# syntax=docker/dockerfile:1
# ============================================================
# Mystic Tarot · 多阶段构建
#
# 阶段划分：
#   deps     —— 只装依赖，利用 Docker 层缓存（改代码不重装依赖）
#   builder  —— 编译 Next.js（output: standalone）
#   runner   —— 只带运行时必要文件（非 root 运行、体积最小）
#
# 关键点：
#   - better-sqlite3 是**原生模块**，必须在与运行时同架构/同 libc 的镜像里编译
#     （alpine = musl，需 python3/make/g++；这里用 debian slim 免去交叉编译坑）
#   - @huggingface/transformers 会下载 ONNX 模型（向量检索用），
#     构建期下载一次打进镜像，避免容器首次启动卡在模型下载
#   - data/ 是 SQLite 落盘目录，必须挂卷（见 docker-compose.yml）
# ============================================================

# ---------- deps ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# libstdc++/python3 用于 better-sqlite3 预编译缺失时的源码编译兜底
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
# npm ci 用 lockfile 精确安装（缺 lockfile 时退回 npm install）
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ---------- builder ----------
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
# 构建期把 ONNX 模型下载到固定目录（不打进数据卷，运行期只读复用）
ENV MODEL_CACHE_DIR=/app/.model-cache
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 构建期不需要真实 API key（LLM 只在运行时调用）
ENV DEEPSEEK_API_KEY=build-placeholder \
    OPENAI_API_KEY=build-placeholder
RUN npm run build
# 预取 ONNX 嵌入模型（23MB）进镜像层 —— 否则容器首次检索要等下载完成
# 失败不阻塞构建（运行期按需下载 / 降级哈希向量）
RUN node scripts/prefetch-model.mjs || true

# ---------- runner ----------
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    RAG_VECTOR_MODE=local \
    MODEL_CACHE_DIR=/app/.model-cache

# 运行期仍需 python3/make/g++ 吗？—— 不需要：
# standalone 产物已带编译好的 .node。但 ONNX runtime 需要 libstdc++/libgomp
RUN apt-get update && apt-get install -y --no-install-recommends \
    libstdc++6 libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 非 root 运行（安全基线）
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs

# standalone 产物（server.js + 精简 node_modules）
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# ⚠️ 构建期 db.ts 的 mkdirSync 会把 data/（含真实 tarot.db + ONNX 模型缓存）
# 复制进 standalone —— 必须清掉：既防止用户数据进镜像层，也避免
# 镜像里塞进 70MB+ 重复模型。运行时用卷重新挂载即可。
RUN rm -rf /app/data && mkdir -p /app/data && chown -R nextjs:nodejs /app/data
# public（图标/manifest/sw.js）与静态资源需手动拷贝（standalone 默认不含）
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# 把构建期下载好的 ONNX 模型带进镜像（只读资源，不入数据卷）
# 模型在宿主上下载时目录名带 %2F 转义，两种结构都拷一份兼容
COPY --from=builder --chown=nextjs:nodejs /app/.model-cache /app/.model-cache

# SQLite 数据目录（运行时可写，容器重启不丢）
VOLUME ["/app/data"]

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(d=>{console.log(d.status);process.exit(0)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
