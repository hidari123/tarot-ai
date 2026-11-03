# Mystic Tarot · AI 塔罗占卜 Agent

> 倾听星辰的低语，窥探命运的轨迹 —— 一个 **多 Agent 协作 + 混合 RAG + 人机协同（HITL）+ Reflexion 反思重写 + SSE 流式** 的 AI 塔罗占卜应用。

📖 **完整设计思路与实现解析 → [`docs/architecture.md`](docs/architecture.md)**
（含每个模块"为什么这么写"、一次真实排查的完整链条、以及**被实测否决的三个"优化"**）

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

- **SQLite 持久层**（better-sqlite3）：sessions / tool_calls / llm_usage / user_profiles / session_timings / event_log 六张表，WAL 模式；`error_reason` 全量记录 + `prompt_version` 版本化 + `share_token` 分享凭证
- **遥测写缓冲**：better-sqlite3 是**同步** API，高频写（一场占卜 ~40 次）会阻塞事件循环 → tool_calls / llm_usage / session_timings 改为**入队 + 事务批量提交**（500ms）；**关键数据（解读正文/审校结果）仍同步写** —— 用"可丢的数据"换"不阻塞"
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
- **Agent 评估套件** `scripts/eval-agent.mjs`：34 条**分层**题集（主题 × 问法 × 长度）自动 E2E，多维度断言 + 失败分类（环境阻塞/超时/断言失败），`--ci` 模式环境阻塞不阻塞 CI
- **MCP Server** `scripts/mcp-server.mjs`：把 3 个塔罗能力封装为 Model Context Protocol 服务（`draw_cards` / `interpret_cards` / `search_tarot`），任何 MCP 客户端（Claude Desktop / Cursor）都能直接调用占卜能力
- **多模型 Failover**：glm-5.3 主 + MiniMax-M3 备（`PRIMARY_PROVIDER` 可指定主模型），网络错误/超时/5xx 自动切换（粘性记忆 + 会话风格一致 + 流式首包安全切换），启动探活预标记不可达节点
- **降级策略**（每层都不删）：LLM 全挂 → 本地剧本引擎；向量模型不可用 → 特征哈希向量；全失败 → 纯 BM25
- **仪式状态机** `src/lib/agent/ritual-machine.ts`：把"仪式进度"从散落的 if 判断收敛成**显式转移表**（承约→呼召→选牌→逐张→综合→收束），守卫统一入口 + 可执行的修复提示；**核心不变量在后端强制，不靠 prompt 约束**
- **SSE 断点续传**：每个事件带 SSE 标准 `id: <seq>`，客户端断线后用 `Last-Event-ID` 请求补发缺失事件（内存 ring buffer，实测无缝衔接/无缺口/无重复）
- **事件日志 + Trace 时间轴**：`event_log` 表记录结构事件，`/api/dashboard/events` 提供单会话逐条时间轴 —— "这场占卜卡在哪一步"一眼可见
- **滑动窗口限速**：限流器的语义与上游配额**逐字一致**（实测网关是「滚动 ~60 秒内最多 4 次」）—— 记录窗口内的请求时间戳，滚动剔除过期记录。**限速等待对用户可见**（区分"模型慢"与"主动限速"）；收到 429 自动收缩窗口容量（AIMD 乘性减 + 缓慢回升）
- **并行择优（Hedged Request）**：主用疑似故障时双路竞速，谁先回用谁，落败方主动 abort；把主用挂掉时的 45~80 秒等待压缩到最快那路
- **CI** `.github/workflows/ci.yml`：三阶段（静态门禁 → 功能验证 → 质量评估），快的先跑快速失败；失败时上传 DB 作为现场证据

### 🔒 公网部署标准（2026-11）

- **能力凭证鉴权**（不用用户体系 —— 强制登录会毁掉"打开网页就能占卜"的零摩擦体验）：
  - `sessionId` = **192bit 全随机**（原格式含时间戳可枚举，已改）→ 它本身就是会话**控制凭证**
  - `shareToken` = **128bit 独立令牌** → 分享出去的是**读权限**，不是控制权
  - `DASHBOARD_TOKEN` → 观测面板鉴权，**未配置时 fail closed**（公网下"没配置就放开"是危险默认值）
  - `userKey` **服务端派生**（IP+UA+盐 的 SHA-256）→ 客户端不能指定他人的画像主键
- **六处泄露面已修**：面板公开 / 分享页可枚举 / userKey 可伪造 / 输入无上限 / health 泄露绝对路径 / 安全头只有一处有
- **输入长度上限**：question 500 / followup 500 / answer 4000 / body 32KB —— 防单请求放大 token 成本
- **全局安全头**（`next.config.ts` 的 `headers()`，框架级统一配置，含 HTML 页面）：CSP（生产去 `unsafe-eval`）/ `X-Frame-Options: DENY` / `nosniff` / `Referrer-Policy` / `Permissions-Policy`
- **前端可取消 SSE**：`AbortController` 打通 → 后端的 `req.signal → client_disconnect → 停止烧 token` 从**死代码**变成真能触发（误点"重新开始"不再白烧 ¥0.22）
- **断点续传真能触发**：原来 catch 块读的是 state 闭包（启动时刻的空串）→ 恢复分支**一次都进不去**；改用 ref 镜像后修复
- **原子占用会话**：`tryAcquireSession` 把"检查 busy + 设置 busy"放进同一同步段 —— 原来中间有 await 间隙，两个并发追问会把会话历史搞坏（assistant→tool 配对错位）
- **运行时状态收敛**：`src/lib/runtime.ts` 单一入口（**13 处**跨请求状态：限流桶 / 熔断器 / provider 健康度 / 会话表 / 快照脏标记 / SSE 事件缓冲 / RAG 缓存与 DF 表 / 向量索引 / 面板缓存 / 截断标记）—— HMR 重载不再清空它们；`scripts/verify-runtime-state.mjs` 静态扫描保证不会有新的模块级状态漏网
- **端到端流程测试** `scripts/verify-e2e-ritual.mjs`：真实跑完整场占卜（自动答 10 次 HITL），抓到了"刷新后正文变空"等静态检查抓不到的真 bug

### 🎨 交互体验

- **占卜师人格**：月影占卜师（神秘优雅）/ 心灵疗愈师（温柔共情）/ 直断导师（犀利毒舌）/ **赛特行者**（古埃及赫尔墨斯传统）/ **凯尔特林语者**（自然与季节）五选一 —— 影响 system prompt 与审校标准
- **可点击引文**：解读文本中的 `[n]` 角标可点击，联动跳转 RAG 知识面板对应命中并高亮；引文越界（可能幻觉）显示为红色禁用态
- **分享卡生成**：Canvas 本地合成 1080×1620 竖版 PNG（星空背景 + 牌面正/逆位 + 问题摘要 + 结论 + 落款），一键下载，无服务端参与
- **分享链接**：服务端渲染的可分享 HTML 卡（一个 URL 即可转发，带**完整解读**而非摘要），与 PNG 分享互补
- **星尘光标**：淡紫白发光灵球 + canvas 粒子拖尾，悬停可交互元素时放大
- **3D 卡牌翻转**：CSS `preserve-3d` + `backface-visibility`，GPU 合成层
- **语音输入**：Web Speech API 浏览器原生

## 🏗️ 架构

```
┌─────────────── 前端 (React 19 + Tailwind 4 + Framer Motion) ───────────────┐
│  人格选择 → 问题输入(语音) → 仪式流程 → 3D 翻牌 → 流式解读              │
│  → 引文联动 → 审校报告 → 分享(PNG / 链接) → 追问                        │
│  + Agent 状态条（区分"模型慢"与"主动限速"）                            │
│  + 牌阵面板（对话流 + 顶部时间线同一份状态）                            │
│  + 知识面板（引文角标点击联动）                                          │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ SSE (fetch 流, 带 id: seq) + POST /api/answer
┌────────────────────────────────▼────────────────────────────────────────┐
│ API 层                                                                   │
│  /api/interpret POST   发起占卜，返回 SSE 流（支持 Last-Event-ID 续传）   │
│  /api/answer   POST    唤醒挂起的 HITL（resolve Promise）                 │
│  /api/share   GET     分享卡 HTML（可传播的 URL）                         │
│  /api/dashboard GET    聚合观测数据（60s 缓存）                           │
│  /api/dashboard/events GET  单会话事件时间轴                             │
│  /api/session/[id] GET 会话状态（刷新恢复 / 追问）                       │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────▼────────────────────────────────────────┐
│ Agent 引擎  src/lib/agent/  （tarot-agent.ts 是薄壳 re-export）            │
│                                                                         │
│  supervisor.ts   编排中枢（ReAct 循环 + 仪式守卫 + 阶段推进）             │
│    ├ ritual-machine.ts  仪式状态机（转移表 + 守卫 + 阶段推导）            │
│    ├ hitl.ts            HITL 等待（唯一阻塞点 + 分级提醒）               │
│    ├ llm.ts             LLM 调用（failover/熔断/限速/并行择优）           │
│    ├ subagents.ts       analyst → writer → reviewer（Reflexion）         │
│    ├ tools/rag.ts       检索执行 + 跨会话缓存 + 投机预检索               │
│    ├ tools/cards.ts     抽牌 + 扇面生成                                  │
│    ├ event-log.ts       事件序号 + ring buffer（断点续传）               │
│    ├ session.ts         会话生命周期 + 快照/恢复 + 启动对账                │
│    ├ fallback.ts        本地剧本引擎（降级也走完整仪式）                   │
│    └ helpers.ts         情绪提取/上下文压缩/牌槽/提示构建                 │
│                                                                         │
│  llm-providers.ts  provider 管理 + 熔断器 + 并行择优竞速                 │
│  rag-engine.ts     BM25 ‖ vector(ONNX|hash) → RRF(k=20) → 查询改写        │
│  vector-engine.ts  ONNX embedding（降级：特征哈希 → 无）                 │
│  db.ts             SQLite 持久层（六张表 + 事件日志 + 成本聚合）           │
└────────────────────────────────────────────────────────────────────────────┘
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
      "args": ["tsx", "/path/to/tarot-ai/scripts/mcp-server.mjs"]
    }
  }
}
```

提供 3 个工具：`draw_cards`（抽牌）/ `interpret_cards`（解读）/ `search_tarot`（典籍检索）

⚠️ 与 Web 前端的关系是**互补**而非替代：
MCP 工具是**无状态**的（不暴露整场 HITL 仪式），
让外部 AI 助手能调用"抽牌/解读/检索"这三个原子能力；
仪式仍由 Web 前端的完整流程承载。

## 📁 关键文件

| 文件 | 说明 |
|---|---|
| `src/lib/agent/` | **Agent 引擎（拆包后）**：`supervisor.ts` 编排中枢 · `ritual-machine.ts` 仪式状态机 · `hitl.ts` HITL 等待 · `llm.ts` LLM 调用 · `subagents.ts` 三子 Agent · `tools/` 工具执行 · `event-log.ts` 事件日志 · `session.ts` 会话生命周期 · `fallback.ts` 降级引擎 · `helpers.ts` 辅助函数 |
| `src/lib/tarot-agent.ts` | Agent 引擎的薄壳（`export * from "./agent"`，保持旧 import 路径可用） |
| `src/lib/llm-providers.ts` | 多模型 failover：健康记忆 + 粘性切换 + 启动探活 + **并行择优竞速** |
| `src/lib/robust-json.ts` | 三层 LLM JSON 解析器（parse → 配平提取 → 字段正则） |
| `src/lib/prompts.ts` | 全部 system prompts 集中管理（PROMPT_VERSION 版本化） |
| `src/lib/rag-engine.ts` | BM25 + 向量 + RRF 融合 + 查询改写 + 跨会话缓存 |
| `src/lib/vector-engine.ts` | 向量检索：ONNX 模型 + 特征哈希降级（`MODEL_CACHE_DIR` 可配） |
| `src/lib/query-rewrite.ts` | 查询改写：主题词典补牌名候选（Recall 44.6% → 82.2%） |
| `src/lib/memory.ts` | 跨会话记忆：主题分类 + 画像摘要注入 + 90 天衰减 |
| `src/lib/personas.ts` | 占卜师人格定义（5 种流派：月影/疗愈/直断/赛特/凯尔特） |
| `src/lib/mcp-tools.ts` | MCP 工具实现（与 stdio 传输层解耦，可独立测试） |
| `src/lib/db.ts` | SQLite 持久层（七张表 + 启动对账 + event_log + 单场成本聚合 + `share_token`） |
| `src/lib/api-auth.ts` | **公网鉴权与安全策略**：能力凭证（sessionId / shareToken / 面板 token）+ 服务端派生 userKey + 输入上限 + 安全头 |
| `src/lib/runtime.ts` | **运行时状态单一入口**（`runtimeState(key, factory)`）—— 8 处跨请求状态挂 globalThis，避免 HMR 重载清空 |
| `src/lib/agent/truncation.ts` | 输出截断标记（P3-⑩ 假绿灯修复）—— 截断的审校结论不计入通过率 |
| `src/app/api/interpret/route.ts` | SSE 接口（abort 感知 + 断连标记 + 互斥 409 + **断点续传** + 原子占用会话） |
| `src/app/api/answer/route.ts` | HITL 应答（唤醒挂起流） |
| `src/app/api/share/route.ts` | 分享卡 HTML（**shareToken 鉴权** —— 只能读不能控） |
| `src/app/api/dashboard/events/route.ts` | 单会话事件时间轴（trace 视图数据源，**需令牌**） |
| `src/app/api/session/[id]/route.ts` | 会话恢复端点（live 状态 / DB 回放 / 404） |
| `src/app/dashboard/page.tsx` | 观测面板 UI（延迟瀑布 + 成本卡 + 异常分布 + Agent 明细 + **令牌输入**） |
| `src/components/TraceTimeline.tsx` | 事件 Trace 时间轴（单场占卜的过程可见性） |
| `src/components/DialogueFlow.tsx` | 统一对话流（承约/呼召/翻牌/解读/收束同区，容器 memo 化） |
| `src/components/CardFan.tsx` | 选牌扇面（记录顺序 + 犹豫时长） |
| `src/components/SubAgentPipeline.tsx` | 子 Agent 生命周期可视化 |
| `src/components/ReviewCard.tsx` | 审校报告卡片（三维度评分条） |
| `src/components/AgentTrace.tsx` | 工具调用 Trace + 思考链 + 轮次时间轴 |
| `src/components/KnowledgePanel.tsx` | RAG 命中可视化（分数条 + 引文联动高亮） |
| `src/components/CitedReading.tsx` | 解读 [n] 引文角标（点击跳转知识面板） |
| `src/components/ShareCard.tsx` | Canvas 分享卡合成（星空 + 牌面 + 摘要）+ **分享令牌换取** |
| `src/components/PwaRegister.tsx` | Service Worker 注册（生产环境） |
| `scripts/mcp-server.mjs` | MCP Server（stdio，3 工具） |
| `scripts/eval-agent.mjs` | Agent 评估套件（分层用例 + 失败分类 + CI 模式） |
| `scripts/eval-rag.mjs` | 检索评估（Recall@5 / MRR / NDCG@5） |
| `scripts/rag-golden-set.json` | 51 条标注检索评估集 |
| `scripts/chaos-test.mjs` | 混沌测试（故障注入断言） |
| `scripts/classify-errors.mjs` | 错误归因聚类 + 改进建议 |
| `scripts/prefetch-model.mjs` | 构建期 ONNX 模型预取（Docker） |
| `scripts/verify-e2e-ritual.mjs` | **端到端跑完整场占卜**（自动答 HITL，零误拦断言） |
| `scripts/verify-api-auth.mjs` | 鉴权 + 安全头 + 输入截断（真实 HTTP 断言） |
| `scripts/dev/` | 一次性诊断工具（无断言、用完即弃，与回归验证器分层） |
| `docs/architecture.md` | **整体设计思路与实现解析**（含被实测否决的四个"优化" + 公网化改造章） |
| `docs/deployment.md` | 部署手册（本地 / Docker / **公网安全标准**） |
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
| **MCP 协议** | 把内部工具封装为标准 MCP 服务，让 Claude/Cursor 等外部客户端复用同一套塔罗能力。**工具实现与传输层解耦**（`mcp-tools.ts` vs `mcp-server.mjs`）→ 可独立测试，不用起 stdio 进程 |
| **仪式状态机** | 核心不变量（承约→呼召→选牌→逐张→综合→收束）**在后端强制**，不靠 prompt。实测 glm-5.3 在 prompt 明确禁止时仍有 32/34 条用例跳过承约 —— prompt 是软约束，代码才是硬约束。守卫不只返回 false，还给**可执行的修复提示**（只说"不行"模型会死循环） |
| **限流保护的三层** | ① 熔断器（事后跳过坏 provider）② 滑动窗口（事前控制节奏）③ 并行择优（主用坏了双路竞速）。**熔断解决"provider 坏了"，限流解决"请求太密"** —— 两回事 |
| **限流语义必须与上游逐字一致** | 网关配额是「滚动 ~60 秒内最多 4 次」。第一版用令牌桶（"空闲攒额度"语义）—— 实测 30 秒内发了 8 次、第 9 次 429：**攒额度后连发 → 全落在同一窗口**。改成滑动窗口（记录窗口内时间戳）后全程零 429。**"差不多"的限流语义在这里是有害的** |
| **令牌桶 vs 滑动窗口** | 已弃用令牌桶 —— 见上一条。滑动窗口 + 「窗口容量自适应收缩」（收到 429 → 容量 ×0.5 → 至少等一个窗口过期再试）比"固定间隔"和"令牌桶"都更贴合真实配额。配额探针 `scripts/probe-gateway-quota.mjs` 留档：配额是**环境相关**的，必须能随时实测 |
| **实测否决三个优化** | ① RAG 并发（净省 3ms，`hybridSearch` 是同步 CPU 计算）② 字段权重进 RRF 融合（重复计数，实测负收益）③ supervisor 流式化（网关流式下不下发思考链，收益≈0）。**结论与数据都写进代码注释**，防止后人重复踩坑 |

### 🔒 公网化相关的面试讲点（2026-11 新增）

| 主题 | 要点 |
|---|---|
| **功能测试 ≠ 攻击面测试** | 第一轮的 34 条用例全绿，但面板公开返回全站用户心理内容、sessionId 含时间戳可枚举、userKey 可伪造、输入无上限。**"该做的做了"和"不该做的没做"是两套用例**，后者只能靠换视角（假设你是攻击者）想到 |
| **能力凭证 vs 用户体系** | 占卜是"打开网页就能用"的产品，强制登录会毁掉零摩擦体验。用**能力凭证**代替身份认证：sessionId（192bit，控制权）/ shareToken（128bit，只读）/ 面板 token / 服务端派生的 userKey。**分享出去的是读权限，不是控制权** —— 这是最容易漏的一条 |
| **fail closed 的默认值** | 面板 token 未配置时**拒绝访问**，而不是放开。公网部署下"没配置就放开"是危险的默认值。**安全功能的默认值应该偏严** |
| **注释不是证据，代码才是** | 两次同一类的翻车：① 测试钩子用正确写法、生产实现没有（单测全绿线上失效）② `return "truncated" as "ok"` —— **类型断言骗过了编译器**，运行时行为完全没变，而注释里写着"调用方可见"。**绿色的测试和详尽的注释都不等于行为正确** |
| **判据的时序要匹配守卫的时机** | 守卫扩到 8 个工具后暴露：`completedPhases` 把 synthesis 挂在 `finished`（会话结束）上，但 close_reading 需要 synthesis 已完成（早于结束）→ **守卫永远拦截 → 收束语永远不生成**。只有端到端跑完整流程才能发现 |
| **检查与设置之间不能有 await** | 并发追问把会话历史搞坏（assistant→tool 配对错位）→ 该会话之后**所有**追问都失败。根因是 TOCTOU：路由层检查 busy 与 supervisor 设置 busy 之间有 await 间隙。修法不是加锁（Node 没有），而是把两件事放进**同一个同步段** |
| **globalThis 解决什么、不解决什么** | 它解决 **HMR 热重载**清空限流窗口/熔断状态/SSE 序号；**解决不了多进程**（各 worker 有独立 realm）。所以本项目**必须单 worker 部署** —— 把限制写进部署文档，比含糊地说"我们用了单例所以线程安全"诚实得多 |
| **端到端测试抓到的真 bug** | `verify-e2e-ritual.mjs` 真实跑完整场占卜（自动答 10 次 HITL），抓到"落库了但 `session.reading` 没赋值 → **用户刷新后正文变空**"。静态检查和单元测试都测不到"七步有序依赖"的中间态 |
| **限流语义必须与上游逐字一致** | 第一版用令牌桶限流，实测每场占卜都撞 429。根因：上游是「滚动 60 秒内 4 次」，令牌桶是「空闲攒额度」—— 用户思考久了攒满令牌就连发，全落在同一窗口。改成滑动窗口后全程零 429。**教训：限流器的语义不能"差不多"，必须与上游一致**；且配额是环境相关的，必须能随时实测（探针脚本留档） |
| **指标本身要验证** | 34 条用例曾"全军覆没"（通过率 2%）—— 真因是环境限流 + 降级被误算成质量缺陷。修正分类后真实通过率 99%，并暴露出真正的问题（审校维度 33%）。**指标不可信时，数字再好看都没意义** |
| **限流治不好先查谁占资源** | 7 条僵尸会话占着网关 4 个并发槽位，最老的躺了 3 天。根因：`restoreSession` 把 `lastActive` 填成 `Date.now()` → 假心跳 → 永久保鲜。修完重启配额立即恢复 |
| **降级也要像样** | 本地剧本引擎产出**与主路径同构**的事件序列（承约/呼召/逐张翻牌讲牌/收束一个不少）。不只是"能跑"，还得"跑得像样" —— 用户看不到模型时，仪式感仍在 |
| **检索可量化** | 51 条标注 golden set + Recall@5/MRR/NDCG 评估。改写优化把 Recall 从 **44.6% 拉到 82.2%**（零命中 14→0）——"感觉变好"变成可复现的数字 |
| **跨会话记忆** | user_profiles 表存主题/情绪轨迹，90 天衰减；承约阶段注入 ≤120 字画像。占卜师从"每次都当陌生人"变成"认识你" |
| **Plan-Execute** | `AGENT_MODE=plan` 让 supervisor 先出 5-8 步仪轨计划再执行，注入系统提示当决策地图。**关键是失败静默降级 ReAct**——自主性增强不能以牺牲可用性为代价 |
| **可靠性工程** | 混沌测试（5 项故障注入）+ 错误自动归因（unknown 从 37% 降到 4%）+ 瞬时重试 + 会话恢复端点。会话状态**必收敛**到 done/error |
| **成本与延迟可见** | dashboard 延迟瀑布（逐阶段耗时）+ 成本估算（¥ + token）。优化前先能看见瓶颈——writer 平均 19.1s 是全链路最大瓶颈 |
| **容器化陷阱** | 构建期 `db.ts` 的 mkdirSync 会把真实 SQLite 打进镜像层（数据泄露 + 70MB 冗余模型）。Dockerfile 显式清理 + 模型缓存与数据卷分离 |
| **PWA 的正确姿势** | Service Worker 对 `/api/*` 与 SSE **永不缓存**——缓存流式响应会导致"读到上一次的占卜结果"，是正确性 bug 而非性能问题 |

## 📄 License

牌面图片与牌意数据来自 [tarot-lab](https://github.com/look-fate/tarot-lab)（MIT）。
