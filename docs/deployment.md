# Mystic Tarot · 部署手册

> 三条路径：本地开发 → Docker 一键起 → 生产环境（Vercel / 自托管）。
> 面向面试演示：**准备一条 Docker 命令就能跑起来**是最省心的讲法。

---

## 0. 前置条件

| 组件 | 要求 | 用途 |
|---|---|---|
| Node.js | ≥ 20（推荐 22） | Next.js 运行时 |
| npm | ≥ 10 | 依赖管理 |
| Docker | ≥ 24（含 compose v2） | 容器化部署 |
| API Key | 至少 1 个（推荐 2 个） | 主模型 + 备用模型 |

**为什么必须配两个 Key**：本项目的 failover 是真实实现——主模型网络错误 / 5xx / 429
时自动切备用，粘性窗口 10 分钟。面试时现场拔掉主模型的网，
备用模型无缝接管，这就是"降级链不是纸面设计"的现场证据。

---

## 1. 本地开发

```bash
npm install
cp .env.example .env.local     # 填入 DEEPSEEK_API_KEY / FALLBACK_API_KEY
npm run dev                    # http://localhost:3000
```

常用开关（写进 `.env.local`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_MODE` | `react` | `plan` = Plan-Execute（先出仪轨计划再执行） |
| `MAX_ROUNDS` | `22` | 工具循环轮次上限（逐张解读约需 14 轮） |
| `LLM_TIMEOUT_MS` | `45000` | 单次 LLM 超时（analyst 自动放宽到 90s） |
| `HITL_TIMEOUT_MS` | `300000` | 等待用户应答上限 |
| `SESSION_DEADLINE_MS` | `480000` | 单场占卜活跃时长上限（不计用户思考时间） |
| `RAG_VECTOR_MODE` | `local` | `hash` = 零依赖降级（无网络也能用） |
| `MODEL_CACHE_DIR` | `data/.cache` | ONNX 模型缓存目录（Docker 用镜像层路径） |

---

## 2. Docker 一键启动（推荐用于演示）

```bash
cp .env.example .env.local     # 填 key
docker compose up -d --build   # 首次构建约 3-5 分钟（含 23MB 模型下载）
docker compose logs -f tarot   # 看日志
```

打开 <http://localhost:3000> 即可。

### 镜像做了什么（多阶段构建）

```
deps    → 只装依赖（lockfile 精确安装），改代码不重装
builder → 编译 Next.js（output: standalone）+ 预取 ONNX 模型
runner  → 只带运行时必要文件，非 root 运行，~500MB
```

### 三个容易踩的坑（已在 Dockerfile 内解决）

1. **`better-sqlite3` 是原生模块** —— 必须在与运行时同 libc 的镜像里编译。
   本项目用 `node:22-bookworm-slim`（glibc），不用 alpine（musl），避免交叉编译坑。
2. **构建期会打进去真实数据** —— `db.ts` 在模块加载时 `mkdirSync(data/)`，
   `next build` 的文件追踪会把 `data/tarot.db`（含真实会话）复制进
   `.next/standalone`。Dockerfile 里显式 `rm -rf /app/data` 清除，运行时用卷挂载。
3. **模型缓存不该在数据卷里** —— 23MB ONNX 模型放卷里会导致：
   换卷丢模型 / 首次请求卡下载 / 镜像层混入运行数据。
   用 `MODEL_CACHE_DIR=/app/.model-cache` 让它留在镜像层（只读），卷只存会话数据。

### 另一个实测发现的坑：预热阻塞首屏

`instrumentation.ts` 里的向量索引预热原本是 `await` 的。Next.js 的
`register()` 在**首个页面请求之前**执行，await 会把首屏堵住 **10+ 秒**
（模型加载 + 312 块向量索引构建）—— 生产实测首次 `GET /` 直接超时。

修复：改为**触发但不 await**（后台预热，不阻塞首屏）。

```
修复前：GET / → 10s+ 超时
修复后：GET / → 376ms ✅（预热 4s 后台完成，向量通道自然就绪）
```

这正是"降级链不删"的价值：预热未完成时首查走 BM25/哈希，功能不受影响。

### 健康检查

```bash
curl http://localhost:3000/api/health
```

```json
{
  "status": "ok",            // ok = 完全就绪；degraded = 降级但可用
  "uptimeSec": 573,
  "llm": { "configured": true },
  "vector": { "mode": "model", "ready": true, "dim": 384, "chunks": 312 }
}
```

**设计要点**：健康检查永远返回 200。向量未就绪 / LLM 未配置属于**降级状态**
而非进程不健康——返回 503 会让 Docker/K8s 把仍可服务的容器杀掉，反而降低可用性。
"健康检查"与"优雅降级"是两件事，不能混为一谈。

### 数据持久化

```yaml
volumes:
  - ./data:/app/data      # SQLite（WAL 模式）
```

`data/` 已在 `.gitignore` 与 `.dockerignore` 中排除。

---

## 3. 生产部署

### 3.1 自托管（Docker）

```bash
# 1. 构建并推送镜像
docker build -t registry.example.com/mystic-tarot:1.0.0 .
docker push registry.example.com/mystic-tarot:1.0.0

# 2. 服务器上拉起
docker compose -f docker-compose.yml up -d
```

生产建议：
- 前置 Nginx / Caddy 做 TLS 终止与 SSE 缓冲**关闭**（`proxy_buffering off;`）
  —— 缓冲会让流式占卜变成"等全部结束才出字"
- 数据库卷放独立磁盘并定期备份（`sqlite3 data/tarot.db ".backup"`）
- `restart: unless-stopped` 已配；`HEALTHCHECK` 已内置

### 3.2 Vercel

Vercel 天然支持 Next.js，但本项目有两个约束：

1. **SQLite 不适合 Serverless** —— 文件系统是临时的。
   生产需换托管数据库（或用 Vercel 持久化卷 / 迁到自托管）。
2. **SSE 长连接** —— Vercel 有函数执行时长上限。
   完整占卜仪式约 60-120 秒，落在默认限制内但余量不大；
   `maxDuration` 建议设 300（Pro 计划）。

面试用的"可复现演示"建议走 Docker（一条命令 + 一个 compose 文件），
Vercel 作为"我知道它的边界在哪"的加分项。

---

## 4. 可观测性（项目自带）

| 入口 | 地址 | 内容 |
|---|---|---|
| 观测面板 | `/dashboard` | 会话终态、LLM 用量、延迟瀑布、成本估算 |
| 健康检查 | `/api/health` | ok / degraded 状态、LLM 是否配置、向量索引就绪情况 |
| 错误归因 | `node scripts/classify-errors.mjs` | error 会话自动聚类 + 优先处理建议 |
| RAG 质量 | `node scripts/eval-rag.mjs` | Recall@5 / MRR / NDCG@5 |
| Agent 质量 | `node scripts/eval-agent.mjs` | 端到端通过率（基线 98%） |
| 混沌测试 | `node scripts/chaos-test.mjs` | 故障注入（409/400/互斥/404） |

---

## 5. 故障排查

| 症状 | 原因 | 处理 |
|---|---|---|
| 启动报 `spawn EPERM` | 沙箱/受限环境禁止子进程 | 用完整权限运行 `npm run dev` |
| 占卜一直"思考中" | LLM 不可达 | 看启动日志 `[llm-probe] 可用: ...`；确认 key 有效 |
| 首次检索很慢 | ONNX 模型在下载 | 等一次即缓存；Docker 里已预取 |
| 检索总是 BM25 命中 | 向量通道降级 | 看日志"降级哈希向量"；检查 `RAG_VECTOR_MODE` |
| SSE 中途断流 | 反向代理缓冲 | Nginx 加 `proxy_buffering off;` |
| `SQLITE_BUSY` | 跨进程写冲突 | 已设 `busy_timeout=5000`；避免多副本共写同一卷 |
| 镜像构建失败在 `npm ci` | 无 lockfile | `npm install` 生成 lockfile 后重试 |

---

## 6. 公网部署安全标准（P1-④）

> 本章是 2026-11 公网化改造新增的。
> 核心观点：这个应用处理的是**用户的私密心理内容**（占卜问题往往涉及感情/健康/财务），
> 所以"能跑起来"和"跑起来不出事"是两件事。

### 6.1 三条不可违反的约束

这三条是**架构层面的限制**，不是配置项。违反任何一条都会导致真实故障。

#### 约束①：必须单 worker 运行

```bash
node server.js          # ✅ 单进程
# ⚠️ 不要用 --scale / deploy.replicas / 多进程启动
```

**为什么**：

项目有**跨请求共享的内存状态**（会话表、SSE 事件缓冲、限流窗口、熔断器、RAG 缓存）。
`globalThis` 只能解决 **HMR 热重载**丢失，**解决不了多进程** ——
每个 worker 有独立的 JS realm，各自的 `globalThis` 也独立。

| 状态 | 多 worker 的后果 |
|---|---|
| 会话表 | 用户 A 的追问被路由到 worker 2 → 查不到会话 → "会话已过期" |
| SSE 事件缓冲 | 断点续传时后端**没有**那条事件的缓冲 → "无法恢复该会话的事件流" |
| 限流窗口 | 每个 worker 各算各的 → 实际并发是 N 倍 → 上游 429 风暴 |
| 熔断器 | worker 1 知道 provider 挂了，worker 2 不知道 → 继续打挂掉的 provider |

**单 worker 的代价**：吞吐上限 = 1 个 Node 进程。对这个项目**可接受** ——
占卜是长耗时的 AI 交互（单场实测 78.7 秒），瓶颈在 LLM 而不在 Node。

**要多 worker 怎么办**：把热状态外置（Redis / PostgreSQL）。当前**没有做** ——
所以必须单 worker。诚实地说明这一点，比假装能横向扩展更有说服力。

#### 约束②：必须配置 `DASHBOARD_TOKEN`

不配置时观测面板 **fail closed**（拒绝所有访问）——
这是**刻意设计**：公网部署下"没配置就放开"是危险的默认值。

#### 约束③：必须改掉 `USER_KEY_SALT`

`USER_KEY_SALT` 是跨会话画像主键的盐。保持默认值的话，
攻击者可以用"已知盐 + 猜测的 IP/UA"**离线枚举**出所有画像主键。

### 6.2 安全能力凭证（不用用户体系）

占卜产品的用户是**匿名的** —— 强制登录会把"打开网页就能占卜"这个核心体验毁掉。
所以不用用户体系，而是用**能力凭证**：

| 凭证 | 用途 | 强度 |
|---|---|---|
| `sessionId` | 会话控制（answer/interject） | **192bit 全随机**（原格式含时间戳可枚举，已改） |
| `shareToken` | 分享链接（只读） | **128bit**，独立于 sessionId |
| `DASHBOARD_TOKEN` | 观测面板 | 环境变量配置 |
| 服务端派生的 `userKey` | 跨会话画像 | IP + UA + 盐 的 SHA-256 |

**为什么分享要用独立令牌**：sessionId 是**控制凭证**（能替用户回答占卜师），
分享出去等于把控制权也给出去了。独立的 shareToken 只能**读**，不能控制。

### 6.3 公网安全清单

- [ ] `DASHBOARD_TOKEN` 已设置且**不是默认值**
- [ ] `USER_KEY_SALT` 已改成随机值
- [ ] 服务以**单 worker** 运行
- [ ] HTTPS 已启用（剪贴板 API 需要安全上下文）
- [ ] `data/` 目录已持久化（不挂载 → 重启丢历史与统计）
- [ ] 反向代理已关闭 `proxy_buffering`
- [ ] `proxy_read_timeout` ≥ 300s（默认 60s < 实测 78.7s）
- [ ] 未设置 `CORS_ORIGINS`（同源部署）或已设为**精确域名**（非 `*`）
- [ ] `/api/dashboard` 无令牌访问返回 401
- [ ] 响应带 CSP / `X-Frame-Options` / `nosniff`
- [ ] `.env.local` **未**进版本库

### 6.4 验证命令

```bash
# ① 面板必须 401
curl -i http://localhost:3000/api/dashboard | head -1

# ② 正确令牌必须 200
curl -s -H "X-Access-Token: $DASHBOARD_TOKEN" http://localhost:3000/api/dashboard | head -c 80

# ③ 安全头
curl -I http://localhost:3000/ | grep -iE "content-security|x-frame|x-content-type"

# ④ 分享接口无令牌必须拒绝
curl -i "http://localhost:3000/api/share" | head -1
```

预期：① 401 ② 200 ③ 三行头齐全 ④ 400/404

### 6.5 生成安全密钥

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 6.6 Nginx 的三个 SSE 坑

1. **`proxy_buffering off`** —— 不关的话 Nginx 攒够一块才发，
   用户看到"卡住 30 秒然后一次全出来"，流式体验完全消失。
2. **`proxy_set_header Connection '';`** —— HTTP/1.1 下 `Connection: upgrade`
   会让 Nginx 把请求当 WebSocket 处理。空值最稳。
3. **`proxy_read_timeout 300s`** —— 默认 60s 会切断 78.7 秒的占卜。

### 6.7 已知的架构限制（诚实清单）

| 限制 | 影响 | 缓解 |
|---|---|---|
| 单 worker | 吞吐上限 1 进程 | 热状态外置到 Redis 后可横向扩展 |
| SQLite 同步写 | 写入时阻塞事件循环 | 量大后换 PostgreSQL |
| 会话在内存 | 重启丢失活跃会话 | 快照已落 DB，重启后可恢复大部分 |
| 分享链接永久有效 | 拿到链接的人一直能看 | 可加有效期（尚未实现） |
| 无用户体系 | 无法"找回我的历史" | 画像按 IP+UA 派生（换设备即新画像） |

**这张表比"功能列表"更重要** —— 能讲清楚边界在哪里，比声称"什么都能做"可信得多。
