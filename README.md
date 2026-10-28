# Mystic Tarot · AI 塔罗占卜 Agent

> 倾听星辰的低语，窥探命运的轨迹 —— 一个 **多 Agent 协作 + 混合 RAG + 人机协同（HITL）+ Reflexion 反思重写 + SSE 流式** 的 AI 塔罗占卜应用。

## ✨ 特性

### 🧠 多 Agent 架构（Supervisor 编排）

```
Supervisor（占卜师编排者，工具调用循环）
  ├─ 🔍 牌意分析师 analyst   逐牌产出精简结构化笔记
  ├─ ✍️ 撰写者   writer     基于笔记流式撰写解读（逐字推送给用户）
  └─ 🧐 审校者   reviewer   三维度打分 + Reflexion 修改指令
       └─ 任一维度 < 6 → 打回撰写者重写 → 复检
```

- **Supervisor 工具集**：`rag_search` / `draw_cards` / `offer_card_selection` / `ask_user` / `fate_crossroads` / `write_reading`
- **Reflexion 自我反思**：审校者不过 → 生成修改指令 → 撰写者重写 → 审校者**复检**新版（实测 grounding 从 3 分提升到 9 分）
- **子 Agent 流水线可视化**：前端面板实时展示三个子 Agent 的生命周期流转

### 🔍 混合 RAG 检索（BM25 + 向量 + RRF 融合）

| 通道 | 实现 | 擅长 |
|---|---|---|
| **BM25**（稀疏） | Okapi BM25，k1=1.5 b=0.75，中文 2-gram 切词，字段权重（keywords 1.4 / 牌意 1.2 / 叙事 1.0） | 字面精确匹配 |
| **向量**（稠密） | transformers.js 本地 ONNX 真实 embedding（`Xenova/all-MiniLM-L6-v2`，384 维，量化 22MB，完全离线推理）→ 降级时用**特征哈希 n-gram 向量**（256 维 FNV-1a）→ 再降级纯 BM25 | 语义相近 |
| **RRF 融合** | Reciprocal Rank Fusion，k=60，两路排名倒数加权融合 | 兼顾召回与精度 |

- 312 个知识块（78 张牌 × 4 字段），**每牌去重**保证 top-k 是不同牌
- 命中结果带 `channels` 标记（`bm25` / `vector` / `bm25+vector`），前端知识面板可视化分数与通道
- **查询改写**（`src/lib/query-rewrite.ts`）：口语查询（"复合 前任"）不含牌名，BM25 字面匹配近零召回（实测 Recall@5 仅 44.6%）。主题词典补牌名候选 → **Recall@5 82.2%**（MRR 0.917 / NDCG 0.815 / 零命中 0）
- **检索质量可量化**：`scripts/rag-golden-set.json`（51 条标注）+ `scripts/eval-rag.mjs`（Recall@5 / MRR / NDCG@5）——检索不再是"感觉变好了"，而是有基线的数字
- **零命中自愈**：改写查询零命中时回退原始查询再检索一次（`rag_zero_retry` 落库归因）

### 🤝 人机协同（HITL）

| 交互 | 机制 |
|---|---|
| **澄清提问** `ask_user` | Agent 主动提问（带选项或自由输入），**整条 SSE 流挂起**等待 `/api/answer` 唤醒，同一连接不断线 |
| **亲手选牌** `offer_card_selection` | 扇形牌阵展开 78 张牌背，用户凭直觉点选 3 张；**记录选牌顺序与每张牌的犹豫时长**注入解读上下文 |
| **命运岔路** `fate_crossroads` | 解读中段呈现 2~3 条走向让用户选择，后续解读按选择分支 |
| **多轮追问** | 内存会话（30min TTL）+ SQLite 持久化，解读完成后继续追问 |

### 🧩 智能体自主性

| 能力 | 说明 |
|---|---|
| **Plan-Execute 模式** | `AGENT_MODE=plan` 时 supervisor 先产出 5-8 步仪轨计划（`plan` 事件 → 前端 PLAN 路线图），注入系统提示作为每轮决策的"地图"；长流程不迷路，用户对 HITL 等待有预期。生成失败静默降级 ReAct |
| **跨会话记忆** | `user_profiles` 表：主题分布 / 情绪轨迹 / 会话次数 / 上次问题，90 天衰减；承约阶段注入 ≤120 字画像摘要——占卜师"认识你" |
| **情绪人格建议** | 收束点按情绪档案建议下一场人格（焦虑 + 直断 → 建议疗愈师；自驱 + 疗愈 → 建议直断），前端一键切换 |
| **检索自愈** | 零命中回退原查询重试；检索预算耗尽时工具下架（防"换词重试"死循环） |

### 🛠️ 工程成熟度

- **SQLite 持久层**（better-sqlite3）：sessions / tool_calls / llm_usage / user_profiles / session_timings 五张表，WAL 模式；`error_reason` 全量记录 + `prompt_version` 版本化
- **观测面板** `/dashboard`：会话统计、**延迟瀑布**（逐阶段耗时条形图）、**成本估算**（¥ + token）、工具调用频次、卡死会话、异常原因分布、各 Agent 性能明细、Prompt 版本效果对比
- **错误自动归因** `scripts/classify-errors.mjs`：error 会话规则聚类（client_disconnect / stale_timeout / max_rounds / ttl_expired / llm_error / analyst_empty）+ 占比 + 优先处理建议——从"出错了"到"该修哪里"
- **混沌测试** `scripts/chaos-test.mjs`：故障注入断言（无效会话 409/410 / 畸形 body 400 / 空问题 400 / 并发互斥 409 / 恢复端点 404）
- **会话恢复端点** `GET /api/session/[id]`：live 会话返回完整状态（牌面/解读/耗时），完成后从 DB 读，不存在 → 404
- **瞬时故障重试**：网络抖动（断连/重置/5xx）同 provider 重试 1 次再 failover；超时直接 failover（首次已烧满 45s 预算，再等无意义）；4xx 业务错误不重试
- **会话状态收敛**：启动对账（僵尸 running 会话）+ 客户端断连感知 + 看门狗 deadline（**活跃时间**口径，不计用户思考时间）+ 30min TTL
- **鲁棒 JSON 解析**（`src/lib/robust-json.ts`）：JSON.parse → 括号配平提取（含归一化）→ 字段级正则，三层兜底；审校解析失败绝不静默"默认通过"
- **上下文治理**：历史轮次压缩（保留最近 4 轮）+ RAG 结果瘦身——supervisor prompt tokens 不再随轮数线性膨胀
- **投机预检索**：用户答"翻下一张"的瞬间提前触发下一张牌的检索（fire-and-forget），省 1-3s 等待
- **PWA**：`manifest.json` + Service Worker（静态资源 SWR / 导航 network-first / **API 与 SSE 永不缓存**）+ 生成式图标，可安装到桌面
- **Docker 化**：多阶段构建（deps → builder → runner），`output: standalone`，非 root 运行，ONNX 模型构建期预取，**构建期数据不入镜像层**
- **Agent 评估套件** `scripts/eval-agent.mjs`：固定题集自动 E2E，9 维度断言 + 失败分类（环境阻塞/超时/断言失败），`--ci` 模式环境阻塞不阻塞 CI
- **MCP Server** `mcp-server/`：把 4 个塔罗工具封装为 Model Context Protocol 服务
- **多模型 Failover**：glm-5.3 主 + MiniMax-M3 备（`PRIMARY_PROVIDER` 可指定主模型），网络错误/超时/5xx 自动切换（粘性记忆 + 会话风格一致 + 流式首包安全切换），启动探活预标记不可达节点
- **降级策略**（每层都不删）：LLM 全挂 → 本地剧本引擎；向量模型不可用 → 特征哈希向量；全失败 → 纯 BM25

### 🎨 交互体验

- **占卜师人格**：月影占卜师（神秘优雅）/ 心灵疗愈师（温柔共情）/ 直断导师（犀利毒舌）三选一，影响 system prompt 与审校标准
- **可点击引文**：解读文本中的 `[n]` 角标可点击，联动跳转 RAG 知识面板对应命中并高亮；引文越界（可能幻觉）显示为红色禁用态
- **分享卡生成**：Canvas 本地合成 1080×1620 竖版 PNG（星空背景 + 牌面正/逆位 + 问题摘要 + 结论 + 落款），一键下载，无服务端参与
- **星尘光标**：淡紫白发光灵球 + canvas 粒子拖尾，悬停可交互元素时放大
- **3D 卡牌翻转**：CSS `preserve-3d` + `backface-visibility`，GPU 合成层
- **语音输入**：Web Speech API 浏览器原生

## 🏗️ 架构

```
┌─────────────── 前端 (React 19 + Tailwind 4 + Framer Motion) ───────────────┐
│  人格选择 → 问题输入(语音) → HITL 交互(问答/选牌扇面/岔路) → 3D 翻牌      │
│  → Agent 状态条+等待提示 → 子 Agent 流水线 → Trace+轮次时间轴              │
│  → RAG 知识面板(引文联动) → 审校报告 → 流式解读(可点击引文) → 追问/分享卡 │
└──────────────────────────┬────────────────────────────────────────────────┘
                           │ SSE fetch + /api/answer (HITL)
┌──────────────────────────▼────────────────────────────────────────────────┐
│  /api/interpret POST  Supervisor 循环 → SSE 事件流（13 类事件）           │
│  /api/answer   POST  HITL 应答（resolve 挂起的 Promise）                  │
│  /api/personas GET   占卜师人格列表                                        │
│  /api/dashboard GET  观测数据                                              │
│                                                                            │
│  Agent 引擎 (src/lib/tarot-agent.ts · ~1400 行)                            │
│    while (round < 12): supervisor 决策(tools) → 执行工具 → 回填 → 继续      │
│      ├ ask_user / offer_card_selection / fate_crossroads → await 应答     │
│      ├ 历史压缩(最近4轮完整) + RAG 回填瘦身 → token 受控                   │
│      ├ 看门狗 deadline + 客户端断连标记 → 会话状态必收敛                   │
│      └ write_reading → 子 Agent 管线:                                       │
│          analyst(≤250字) → writer(流式) → reviewer(鲁棒解析+复检)           │
│            └ 不过 → revision → writer 重写 → reviewer 复检                  │
│                                                                            │
│  RAG (src/lib/rag-engine.ts + vector-engine.ts)                            │
│    312 chunks → BM25 ‖ vector(ONNX|hash) → RRF(k=60) → 每牌去重 → top-k  │
│                                                                            │
│  持久化 (src/lib/db.ts)  SQLite: sessions / tool_calls / llm_usage         │
│    + 启动对账(僵尸会话收敛) + error_reason + prompt_version                 │
└────────────────────────────────────────────────────────────────────────────┘
```

## 🚀 快速开始

### 方式一：本地开发

```bash
npm install
cp .env.example .env.local     # 填入 API key
npm run dev
# http://localhost:3000        占卜主界面
# http://localhost:3000/dashboard   观测面板
```

### 方式二：Docker 一键起（推荐用于面试演示）

```bash
cp .env.example .env.local     # 填入 API key
docker compose up -d --build   # 首次约 3-5 分钟（含 23MB 模型预取）
# http://localhost:3000
```

多阶段构建：deps → builder（编译 + 模型预取）→ runner（standalone 产物，非 root 运行）。
详细说明与故障排查见 [`docs/deployment.md`](docs/deployment.md)。

### 接入大模型（主备 failover）

`.env.local`（任何 OpenAI 兼容接口，需支持 **function calling**）：

```bash
# 主模型
DEEPSEEK_API_KEY=sk-xxxxxxxx
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_MODEL=deepseek-chat

# 备用模型（可选）：主模型网络错误/超时/5xx 时自动切换
FALLBACK_API_KEY=sk-yyyyyyyy
FALLBACK_BASE_URL=https://api.minimaxi.com/v1
FALLBACK_MODEL=MiniMax-M3
```

**Failover 机制**（`src/lib/llm-providers.ts`）：
- 触发条件：网络错误 / 超时 / HTTP 5xx / 429
- 粘性记忆：主模型失败后 10 分钟内直接用备用（不再每次先吃主模型超时）
- 会话粘住：切换后会话内固定用同一模型，保证解读风格一致
- 流式安全：仅在**首 token 前**失败才切换（已开始输出不切，避免重复推送）
- 全链路生效：supervisor 决策 / analyst / writer / reviewer 四类调用都受保护

```bash
# 可选调优
LLM_TIMEOUT_MS=45000          # 单次 LLM 调用超时（analyst 自动放宽到 90s）
FAILOVER_STICKY_MS=600000     # 主模型失败后的粘性窗口
RAG_VECTOR_MODE=local         # local | hash | off
EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
```

### 运行评估套件

```bash
# 先启动 dev server
node scripts/eval-agent.mjs http://localhost:3000
# 输出：clarify / rag / cite / complete / review 各维度通过率 + 仪式流程维度 + 失败分类
#   env_error（模型不可达，不计入）/ timeout / assertion_failed
# --ci 模式：环境阻塞时 exit 0 不阻塞 CI

node scripts/eval-rag.mjs             # 检索质量：Recall@5 / MRR / NDCG@5（基线 Recall 82.2%）
node scripts/eval-rag.mjs --rewrite   # 开启查询改写的对比基线
node scripts/chaos-test.mjs           # 混沌测试：故障注入断言（409/400/互斥/404）
node scripts/classify-errors.mjs      # 错误归因：error 会话聚类 + 优先处理建议
node scripts/analyze.cjs              # DB 体检：token 分布/审校解析失败率/会话状态/工具频次
```

### 观测与调优脚本

```bash
node scripts/download-model.mjs    # 从 hf-mirror 下载 5 个模型文件（约 22MB）
node scripts/warmup-vectors.mjs    # 构建 312 块向量索引缓存 + 语义检索自检
node scripts/test-embedding.mjs    # 验证模型离线加载与语义相似度
node scripts/prefetch-model.mjs    # 构建期预取模型（Docker 用，见 Dockerfile）
node scripts/debug-ritual.mjs http://localhost:3000 "你的问题"   # 全流程 SSE 事件回放
```

模型缓存在 `data/.cache/`（已 gitignore，可用 `MODEL_CACHE_DIR` 覆盖）。
未下载时自动降级为特征哈希向量 → 纯 BM25，流程不受影响。

### 接入 MCP 客户端

```jsonc
// Claude Desktop config
{
  "mcpServers": {
    "mystic-tarot": {
      "command": "node",
      "args": ["/path/to/tarot-ai/mcp-server/index.mjs"]
    }
  }
}
```

提供 4 个工具：`tarot_draw_cards` / `tarot_search` / `tarot_card_meaning` / `tarot_interpret`

## 📁 关键文件

| 文件 | 说明 |
|---|---|
| `src/lib/tarot-agent.ts` | 多 Agent 引擎：Supervisor 循环 + 三子 Agent 管线 + HITL + 轮次事件 + 看门狗 + Plan-Execute |
| `src/lib/llm-providers.ts` | 多模型 failover：健康记忆 + 粘性切换 + 启动探活 |
| `src/lib/robust-json.ts` | 三层 LLM JSON 解析器（parse → 配平提取 → 字段正则） |
| `src/lib/prompts.ts` | 全部 system prompts 集中管理（PROMPT_VERSION 版本化） |
| `src/lib/rag-engine.ts` | BM25 + RRF 融合 + 知识分块 + 引用组装 |
| `src/lib/vector-engine.ts` | 向量检索：ONNX 模型 + 特征哈希降级（`MODEL_CACHE_DIR` 可配） |
| `src/lib/query-rewrite.ts` | 查询改写：主题词典补牌名候选（Recall 44.6% → 82.2%） |
| `src/lib/memory.ts` | 跨会话记忆：主题分类 + 画像摘要注入 + 90 天衰减 |
| `src/lib/db.ts` | SQLite 持久层（五张表 + 对账 + error_reason + 耗时聚合 + 成本估算） |
| `src/app/api/interpret/route.ts` | SSE 接口（abort 感知 + 断连标记 + 互斥 409） |
| `src/app/api/answer/route.ts` | HITL 应答（唤醒挂起流） |
| `src/app/api/session/[id]/route.ts` | 会话恢复端点（live 状态 / DB 回放 / 404） |
| `src/app/dashboard/page.tsx` | 观测面板 UI（延迟瀑布 + 成本卡 + 异常分布 + Agent 明细） |
| `src/components/DialogueFlow.tsx` | 统一对话流（承约/呼召/翻牌/解读/收束同区） |
| `src/components/CardFan.tsx` | 选牌扇面（记录顺序 + 犹豫时长） |
| `src/components/SubAgentPipeline.tsx` | 子 Agent 生命周期可视化 |
| `src/components/ReviewCard.tsx` | 审校报告卡片（三维度评分条） |
| `src/components/AgentTrace.tsx` | 工具调用 Trace + 思考链 + 轮次时间轴 |
| `src/components/KnowledgePanel.tsx` | RAG 命中可视化（分数条 + 引文联动高亮） |
| `src/components/CitedReading.tsx` | 解读 [n] 引文角标（点击跳转知识面板） |
| `src/components/ShareCard.tsx` | Canvas 分享卡合成（星空 + 牌面 + 摘要） |
| `src/components/PwaRegister.tsx` | Service Worker 注册（生产环境） |
| `mcp-server/index.mjs` | MCP Server（stdio，4 工具） |
| `scripts/eval-agent.mjs` | Agent 评估套件（9 维度断言 + 失败分类 + CI 模式） |
| `scripts/eval-rag.mjs` | 检索评估（Recall@5 / MRR / NDCG@5） |
| `scripts/rag-golden-set.json` | 51 条标注检索评估集 |
| `scripts/chaos-test.mjs` | 混沌测试（故障注入断言） |
| `scripts/classify-errors.mjs` | 错误归因聚类 + 改进建议 |
| `scripts/prefetch-model.mjs` | 构建期 ONNX 模型预取（Docker） |
| `Dockerfile` / `docker-compose.yml` | 多阶段构建 + 一键起服务 |

## 🎨 面试讲点

| 主题 | 要点 |
|---|---|
| **多模型 Failover** | 主备双模型（glm-5.3 / MiniMax-M3）；触发条件精准区分（网络/超时/5xx 切换，4xx 业务错误不切）；粘性健康记忆避免反复吃超时；流式只在首 token 前切换保证不重复输出 |
| **多 Agent 编排** | Supervisor pattern：编排者只做决策（工具调用循环），执行者只做单一职责（分析/撰写/审校）；子 Agent 间通过结构化笔记传递，而非共享全部上下文 |
| **Reflexion 反思** | 生成 → 自评 → 反思 → 重写闭环；关键设计：审校标准必须认可"牌面知识"和"RAG 检索"是两个合法引用来源，否则会误判编造导致无意义重写 |
| **混合检索** | 稀疏(BM25)与稠密(向量)互补；RRF 只用排名不用分数，天然规避两路分数量纲不可比的问题；每牌去重避免 top-k 被同牌多字段占满 |
| **引文可信闭环** | 解读里每个 `[n]` 可点击 → 跳转 RAG 命中面板高亮原文出处；越界引文（超出命中数）标红提示"可能幻觉"——把幻觉检测做进 UI |
| **向量降级** | 三级策略：ONNX 模型 → 特征哈希 n-gram（256 维 FNV-1a + 符号哈希抗碰撞）→ 纯 BM25；面试可讲"工程可用性优先于理论最优" |
| **HITL 挂起** | SSE 流中 `await new Promise(resolve)`，由独立 HTTP 端点 resolve；解决"长连接上的人机交互"——不用轮询、不用 WebSocket、流不中断 |
| **globalThis 单例** | Next.js dev 模式多 worker 各编译模块，模块级 Map 会分裂（导致 410）；`globalThis` 挂载保证 dev/build 行为一致 |
| **性能优化** | glm-5.3 推理链占 token 配额且拖慢；结构化输出任务（analyst/reviewer）关闭 thinking 并限制 max_tokens；决策步保留推理；单次调用 AbortSignal 超时保护 |
| **可观测性** | 三张表分别记录会话/工具流水/LLM 用量；dashboard 展示工具频次与延迟分布、卡死会话、异常原因分布、各 Agent 性能明细；eval 套件做端到端质量断言并区分"环境问题"与"质量问题" |
| **会话状态收敛** | 内存状态 + 持久层只写不收 = 僵尸会话。三件套修复：启动对账（stale running → error）+ 客户端 abort 监听（client_disconnect）+ 看门狗 deadline。任何会话最终都会收敛到 done/error |
| **鲁棒解析** | LLM 输出的 JSON 不可信（33% 解析失败率实测）。三层解析（parse → 括号配平+归一化 → 字段正则）+ 一次纠偏重试；仍失败则显式"审校未完成"而非伪造"通过"——裁判环节绝不造假 |
| **Token 治理** | 上下文随轮数线性膨胀（1357→2873 tokens）。历史压缩（最近 4 轮完整，早期工具结果一行摘要）+ RAG 回填瘦身（top-3 紧凑格式，省 30-40%）；给 LLM 的与给用户的信息不对称分流 |
| **轮次时间轴** | 每轮 SSE `round` 事件（耗时/tokens/工具名），前端条形图可视化。>15s 标黄——把"Agent 慢"从体感变成可定位的数据 |
| **MCP 协议** | 把内部工具封装为标准 MCP 服务，让 Claude/Cursor 等外部客户端复用同一套塔罗能力 |
| **检索可量化** | 51 条标注 golden set + Recall@5/MRR/NDCG 评估。改写优化把 Recall 从 **44.6% 拉到 82.2%**（零命中 14→0）——"感觉变好"变成可复现的数字 |
| **跨会话记忆** | user_profiles 表存主题/情绪轨迹，90 天衰减；承约阶段注入 ≤120 字画像。占卜师从"每次都当陌生人"变成"认识你" |
| **Plan-Execute** | `AGENT_MODE=plan` 让 supervisor 先出 5-8 步仪轨计划再执行，注入系统提示当决策地图。**关键是失败静默降级 ReAct**——自主性增强不能以牺牲可用性为代价 |
| **可靠性工程** | 混沌测试（5 项故障注入）+ 错误自动归因（unknown 从 37% 降到 4%）+ 瞬时重试 + 会话恢复端点。会话状态**必收敛**到 done/error |
| **成本与延迟可见** | dashboard 延迟瀑布（逐阶段耗时）+ 成本估算（¥ + token）。优化前先能看见瓶颈——writer 平均 19.1s 是全链路最大瓶颈 |
| **容器化陷阱** | 构建期 `db.ts` 的 mkdirSync 会把真实 SQLite 打进镜像层（数据泄露 + 70MB 冗余模型）。Dockerfile 显式清理 + 模型缓存与数据卷分离 |
| **PWA 的正确姿势** | Service Worker 对 `/api/*` 与 SSE **永不缓存**——缓存流式响应会导致"读到上一次的占卜结果"，是正确性 bug 而非性能问题 |

## 📄 License

牌面图片与牌意数据来自 [tarot-lab](https://github.com/look-fate/tarot-lab)（MIT）。