# Mystic Tarot · 优化实施报告

> 对应 [`docs/optimization-roadmap.md`](optimization-roadmap.md) 的 6 大方向实施结果。
> 周期：2026-10-27 → 2026-10-28 · 5 次提交 · 36 文件 · +2294 行

---

## 总览

| 方向 | 主题 | 状态 | 关键产出 |
|---|---|---|---|
| ① | 智能体记忆体系 | ✅ 完成 | `user_profiles` 表 + 画像注入 + 90 天衰减 |
| ② | RAG 精度深挖 | ✅ 完成 | **Recall@5 44.6% → 82.2%**，零命中 14 → 0 |
| ③ | 成本与延迟工程 | ✅ 完成 | 延迟瀑布 + 投机预检索 + 成本看板 |
| ④ | 可靠性与混沌测试 | ✅ 完成 | 混沌测试 5/5 · 错误归因 unknown 37% → 4% |
| ⑤ | Agent 自主性升级 | ✅ 完成 | Plan-Execute 模式 + 零命中自愈 + 情绪人格建议 |
| ⑥ | 产品化与规模 | ✅ 完成 | PWA + Docker 多阶段 + 健康检查 + 部署文档 |

**质量基线全程保持**：端到端评估 98% · RAG Recall@5 82.2% · 无降级层被删。

---

## 方向①：智能体记忆体系

**问题**：情绪档案仅会话内有效，第二次占卜完全不记得第一次。

**实施**：
- `user_profiles` 表：主题分类 / 情绪轨迹 / 会话次数 / 上次问题 / 最后活跃
- `src/lib/memory.ts`：`classifyTopic`（情感/事业/财富/学业/综合 正则分类）、
  `buildMemoryContext`（≤120 字注入文本，`【访客记忆】`前缀）、
  `persistMemory`（会话收尾增量更新，失败**绝不阻断**会话）
- 前端 `getUserKey()`：localStorage UUID（`tarot:userKey`），匿名兜底
- 承约阶段 system prompt 注入画像摘要
- 90 天不活跃自动降权（db 层处理）

**验证**：`persistMemory` 在 `runAgent` 外层 finally 调用（所有退出路径都落库）；
画像写入失败仅 warn，不影响占卜主流程。

---

## 方向②：RAG 精度深挖

**问题**：调参没有数据支撑；口语查询（"我心里没底"）检索命中率低。

**实施**：
1. **Golden set**（`scripts/rag-golden-set.json`，51 条标注：查询 → 期望命中牌 id）
2. **评估脚本**（`scripts/eval-rag.mjs`）：Recall@5 / MRR / NDCG@5
3. **查询改写**（`src/lib/query-rewrite.ts`）：~34 条主题词典（正则 → 牌名候选），
   已含牌名则不改写（避免污染精确匹配）
4. **零命中自愈**（方向⑤补齐）：改写查询零命中时回退原始查询再检索一次

**实测数据**：

| 指标 | 改写前 | 改写后 |
|---|---|---|
| Recall@5 | 44.6% | **82.2%** |
| MRR | 0.556 | **0.917** |
| NDCG@5 | 0.433 | **0.815** |
| 零命中查询 | 14 条 | **0 条** |

> 词典中特别补了口语别名：`13号牌` → 死神、`意外打击` → 塔、
> `事业上升期` → 战车/太阳、`冲动消费` → 恶魔、`瓶颈期` → 吊人。

---

## 方向③：成本与延迟工程

**问题**：writer 平均 19.1s 是全链路最大瓶颈，但没有分解视图。

**实施**：
- **延迟瀑布**：`session_timings` 表记录每阶段耗时（`llm_supervisor` /
  `hitl_wait` / `tool_rag_search` / `rewrite_fail` …），dashboard 渲染条形图
  ——"writer 19s"变成"首 token 4.2s + 生成 14.8s"
- **成本看板**：按模型单价折算（¥10/M token 估算），dashboard 展示成本与会话趋势
- **投机预检索**：用户答"翻下一张"的瞬间提前触发下一张牌检索（fire-and-forget），
  下一轮查重直接命中，省 1-3s
- **耗时落库**：`logTiming` 覆盖 LLM 调用 / 工具执行 / HITL 等待三类

**验证**：dashboard 延迟瀑布实测正常渲染（hitl_wait / llm_* / tool_* 分色显示）。

---

## 方向④：可靠性与混沌测试

**问题**：50 个 error 会话归因粗糙（37% 是"未知"），无系统性故障注入。

**实施**：
1. **混沌测试**（`scripts/chaos-test.mjs`）：5 项故障注入断言
   （无效会话 409/410 · 畸形 body 400 · 空问题 400 · 并发互斥 409 · 恢复端点 404）
2. **错误自动归因**（`scripts/classify-errors.mjs`）：规则聚类 + top 原因 + 改进建议
3. **归因补全**：修复 3 处 `failSession` 未写 reason 的路径
   （analyst 异常 / 撰写中断 → `llm_error`；分析师空产出 → `analyst_empty`）
4. **重试语义细化**（`rawCall`）：
   - 快速网络抖动（断连/重置/5xx）→ 同 provider **重试 1 次**再 failover
   - 超时 → **不原地重试**（首次已烧满 45s 预算，再等无意义），直接 failover
   - 4xx 业务错误 → 不重试，直接抛
5. **会话恢复端点**（`GET /api/session/[id]`）：live 会话返回完整状态，
   完成后从 DB 回放，不存在 → 404

**实测数据**：

| 归因 | 实施前 | 实施后 |
|---|---|---|
| 未知 | 17 场 (37%) | **2 场 (4%)**（均为修复前的历史数据） |
| 客户端断开 | 18 场 (39%) | 21 场 (42%) |
| 僵死回收 | — | 15 场 (30%)，此前被算作"未知" |
| 轮次耗尽 | 7 场 (15%) | 7 场 (14%) |
| 会话过期 | 3 场 (7%) | 4 场 (8%) |
| LLM 失败 | 1 场 (2%) | 1 场 (2%) |

**混沌测试结果**：5 通过 / 0 失败。

---

## 方向⑤：Agent 自主性升级

**问题**：仪式顺序全在 prompt 里，Agent 无规划能力。

**实施**：
1. **Plan-Execute 开关**（`AGENT_MODE=react|plan`）：
   - plan 模式开局先产出 5-8 步仪轨计划 → `plan` 事件 → 前端 PLAN 路线图卡片
   - 计划作为 system 消息注入历史，作为每轮决策的"地图"
   - `buildPlanSteps` 独立函数 + 20s 硬超时（规划器卡死不能拖垮 SSE 流）
   - **失败静默降级 ReAct**（自主性增强不能以牺牲可用性为代价）
   - `agent_mode` 落库（`prompt_version` 追加 `/plan` 或 `/react`）便于 A/B 对比
2. **工具结果自评估**：零命中回退原查询重试（`rag_zero_retry` 落库归因）
3. **情绪驱动人格**：`suggestPersonaByEmotion` 在收束点按情绪档案建议下一个人格
   （焦虑 + 直断 → 疗愈师；自驱 + 疗愈 → 直断），前端一键切换

**实测验证**：
- plan 模式：4.1s 产出 8 步计划，事件序列 `session · phase · plan · reasoning · …` ✅
- plan 模式端到端评估：**98%**（与 react 持平）✅
- persona_suggest：blade 人格 + 用户流露「紧张不安、迷茫」→ 实测触发
  「🌿 心灵疗愈师」建议 ✅

---

## 方向⑥：产品化与规模

**实施**：
1. **PWA**：`manifest.json` + 生成式图标（192/512/maskable/64）+
   `public/sw.js` 分层策略 + `PwaRegister` 组件（仅生产注册）
2. **Docker**：多阶段（deps → builder → runner）、`output: standalone`、
   非 root 运行、`HEALTHCHECK`、`.dockerignore`、`docker-compose.yml`
3. **健康检查**：`GET /api/health` 返回 ok/degraded 分层状态
4. **部署文档**：`docs/deployment.md`（本地 / Docker / 生产三条路径 + 排障表）

### 实测发现的三个真问题（都已修）

| 问题 | 现象 | 修复 |
|---|---|---|
| **预热阻塞首屏** | `instrumentation` 的 `await` 让生产首屏 **10s+ 超时**（Next.js 的 register() 在首个请求前执行） | 改为触发不 await → 实测首屏 **376ms** |
| **构建期数据入镜像** | `db.ts` 的 `mkdirSync` 让 `next build` 把**真实 SQLite**（含用户会话）复制进 `.next/standalone` | Dockerfile 显式 `rm -rf /app/data` |
| **模型缓存混进数据卷** | 23MB ONNX 模型在卷里 → 换卷丢模型 / 镜像层混入运行数据 | `MODEL_CACHE_DIR=/app/.model-cache`，模型留镜像层、卷只存会话 |

**Service Worker 的关键约束**：`/api/*` 与 SSE **永不缓存** ——
缓存流式响应会导致"读到上一次的占卜结果"，是正确性 bug 而非性能问题。

**健康检查的设计判断**：永远返回 200。向量未就绪 / LLM 未配置属于**降级状态**
而非进程不健康——返回 503 会让 Docker/K8s 把仍可服务的容器杀掉，反而降低可用性。

**验证**：standalone 产物按 Dockerfile 的 runner 布局本地复现，
生产服务器实测可跑（首屏 200/376ms，manifest + sw + 图标全部 200）。

---

## 全流程验证结果

| 验证项 | 命令 | 结果 |
|---|---|---|
| 端到端评估 | `node scripts/eval-agent.mjs` | **98%**（clarify 83 / rag 100 / cite 100 / complete 100 / review 100 + 仪式 4 维全 100） |
| 检索质量 | `npx tsx scripts/eval-rag.mjs --rewrite` | Recall@5 **82.2%** / MRR 0.917 / NDCG 0.815 / 零命中 0 |
| 混沌测试 | `node scripts/chaos-test.mjs` | **5 通过 / 0 失败** |
| 错误归因 | `node scripts/classify-errors.mjs` | unknown 37% → **4%** |
| 类型检查 | `npx tsc --noEmit` | **0 错误** |
| 代码规范 | `npx eslint` | **0 问题** |
| 生产构建 | `npm run build` | 成功（standalone 产物 113MB） |
| 仪式流程 | `node scripts/debug-ritual.mjs` | 承约→呼召→选牌→3×翻牌解读→收束 全通 |

---

## 面试讲述：三分钟版本

**开场（30s）**
"这是一个多 Agent 协作的塔罗占卜系统——Supervisor 编排 + 三子 Agent 流水线 +
混合 RAG + HITL 挂起交互 + Reflexion 反思重写 + SSE 流式。
它有 9 维度的自动化评估、观测面板、故障注入测试和容器化部署——
不是玩具 Demo，是工程系统。"

**深技术点 A：HITL 挂起流与协议配对守卫（2min）**
"难点不是 SSE，是**在流里挂起等人**。我用 `await new Promise(resolve)`，
由独立的 `/api/answer` 端点 resolve——不用轮询、不用 WebSocket、流不中断。
但这引出一个更隐蔽的 bug：MiniMax 严格协议下，
`assistant(tool_calls=[interpret,reveal]) → tool(interpret) → user(继续) → tool(reveal)`
这个序列里，**tool 响应被 user 消息隔断**了，直接 400
`tool call result does not follow tool call`。
定位靠的是：把每轮的消息序列打出来逐条对比协议要求。
修复是引入 `pendingUserNotes` 队列——user 消息暂存到轮首，
在 deferred tool 响应**之后**再插入。"

**深技术点 B：检索可量化 + 混合检索（2min）**
"RAG 我没靠感觉调参。先建了 51 条标注的 golden set，写了 Recall/MRR/NDCG 评估器，
拿到基线 **Recall@5 只有 44.6%**，14 条查询零命中——
根因是口语查询不含牌名，BM25 字面匹配直接跪。
做了主题词典改写后 **82.2%**，MRR 0.917，零命中清零。
混合检索上，BM25 和向量用 **RRF 融合**——只用排名不用分数，
天然规避两路分数量纲不可比的问题；每牌去重避免 top-k 被同牌多字段占满。"

**工程判断力（1min）**
"三个我特别想讲的判断：
1. **降级的不要删**——LLM 全挂→本地剧本、向量模型挂→特征哈希→纯 BM25，
   三级降级任何一级都能跑完。方向⑤的 Plan-Execute 生成失败也是静默降级回 ReAct。
2. **评估先行**——没有 golden set 就不调参，'感觉变好了'不算数。
3. **健康检查 ≠ 优雅降级**——向量通道没就绪时服务仍然可用，
   健康检查永远返回 200；返回 503 会让 K8s 把能服务的容器杀掉。"

**杀手锏数据**
- 端到端评估 **98%**（9 维度）
- 检索 Recall@5 **44.6% → 82.2%**（零命中 14 → 0）
- Reflexion 重写 grounding **3 → 9** 分
- 400 协议错位定位到根因（tool 响应被 user 隔断）
- 生产首屏 **10s+ → 376ms**（预热阻塞首屏的定位与修复）

---

## 提交历史

```
4e5ca0e 方向⑥ 产品化：PWA + Docker 化 + 健康检查 + 部署文档
9f0ec0e 方向⑤ Agent 自主性：Plan-Execute 模式 + RAG 零命中自愈 + 情绪人格建议
2114fcb 方向④ 可靠性工程：瞬时网络重试 + 错误归因补全 + 混沌测试
1c027f6 方向③ 成本与延迟工程：延迟瀑布 + 投机预检索 + 成本看板
8b057ee 方向① 记忆体系 + 方向② RAG 精度（Recall@5 44.6%→82.2%）
fcfd798 修复 400 协议错位 + 恢复逐张翻牌仪式感
eb5c338 全面优化：34 项审查发现落地（可靠性/性能/体验/清理）
```

---

## 遗留与下一步

**已识别的改进点**（按优先级）：
1. `client_disconnect` 占 error 42%（21 场）——用户中途离开，
   需从"等待过久/交互卡点"角度优化体验，而非修系统
2. `max_rounds` 占 14%（7 场）——模型决策循环未收敛，
   可考虑在 supervisor 层加"流程状态机"约束而非仅靠轮次上限
3. `writer` 仍是最大耗时项（15-19s）——方向③的管线并行（analyst 边产出 writer 边写）
   尚未实施，是下一步最高性价比的优化
4. Vercel 部署的 SQLite 限制——需迁移到托管数据库

**降级层清单（全部保留）**：
```
LLM 全挂       → 本地剧本引擎（runLocalFallback）
向量模型不可用 → 特征哈希 n-gram 向量（256 维 FNV-1a）
向量索引未就绪 → 纯 BM25 检索
Plan 生成失败  → 静默降级 ReAct
主模型 5xx     → 备用 provider（粘性健康记忆）
网络瞬时抖动   → 同 provider 重试 1 次
TTF 检索零命中 → 回退原始查询重试
HITL 超时/断开 → 按"未回应"记录继续，不挂死
前端无 SSE     → 降级选牌（随机代抽）
```
