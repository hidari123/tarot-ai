# Mystic Tarot 优化路线图

> 系统性优化计划：6 大方向，按实施顺序排列。每项含"现状缺口 → 实施 → 验证"三段式。
> 配套文档：`docs/optimization-report.md`（实施完成后的结果报告）。

## 现状快照（2026-10-27）

| 指标 | 现状 | 优化方向 |
|---|---|---|
| 会话终态 | 74 done / 45 error（error 率 38%） | 方向④ |
| supervisor 每轮 prompt | 平均 3877 tokens（峰值 6260） | 方向③ |
| writer 平均耗时 | 19.1s（全链路最大瓶颈） | 方向③ |
| rag_search 调用 | 379 次（占全部工具 39%） | 方向② |
| 评估基线 | 98% 通过率（5 基础 + 4 仪式维度） | 全部方向 |
| 跨会话记忆 | 无（第二次占卜完全不记得第一次） | 方向① |
| 检索质量度量 | 只有"是否命中"断言，无 Recall/MRR | 方向② |
| 失败归因 | error_reason 手工枚举，无自动聚类 | 方向④ |
| Agent 模式 | 纯 ReAct（逐步反应式决策） | 方向⑤ |
| 部署形态 | 单机 dev 模式，无产物 | 方向⑥ |

---

## 方向①：智能体记忆体系（长程个性化）

**缺口**：情绪档案（emotionTags）仅会话内有效；用户第二次占卜，Agent 完全不记得。

**实施**：
1. `user_profiles` 表（SQLite）：`user_key`（浏览器指纹）、历史问题主题、情绪轨迹、
   困惑领域分布（情感/事业/财富）、活跃时间戳
2. 画像读写 API（`src/lib/memory.ts`）：
   - `updateProfile(userKey, session)`：会话结束时增量更新
   - `getProfileContext(userKey)`：承约阶段注入的画像摘要（≤120 字）
   - 90 天衰减：`lastActive` 超 90 天的画像降权/清空
3. 前端生成稳定 `userKey`（localStorage UUID），interpret 请求携带
4. 承约阶段 prompt 注入："这位用户此前关注过 X（3 次情感类问题），
   上次占卜主题是跳槽犹豫"——占卜师"认识你"

**验证**：同一 userKey 连续两次占卜，第二次承约阶段能看到"你上次…"式的上下文引用。

---

## 方向②：RAG 精度深挖（检索质量可量化）

**缺口**：调参没有数据支撑；口语查询（"我心里没底"）检索命中率低。

**实施**：
1. **golden set 评估集**（`scripts/rag-golden-set.json`，50 条标注）：
   查询 → 期望命中的牌 id 列表（多 Relevant）
2. **评估脚本**（`scripts/eval-rag.mjs`）：计算 Recall@5 / MRR / NDCG，
   按通道分解（exact/bm25/vector 各自贡献）
3. **查询改写**（`src/lib/query-rewrite.ts`）：LLM 把口语改写为检索友好关键词
   （带降级：LLM 不可用时直接用原查询）——只在 reveal 前对牌名已知的场景跳过
4. **别名词典**（`src/lib/rag-engine.ts` 扩展）：牌名俗称/英文/数字
   （"死神"="13"="Death"="转化的必然"）
5. **LLM rerank**（`src/lib/rerank.ts`）：top-10 → LLM 按相关性打分重排 → top-5；
   开关 `RAG_RERANK=on|off`，默认 off（延迟敏感场景可关）

**验证**：eval-rag 脚本输出基线 → 实施改进 → 对比 Recall@5 提升（目标 +10pp）。

---

## 方向③：成本与延迟工程

**缺口**：writer 19s 没有分解视图；管线是串行（analyst 完成 → writer 开始）。

**实施**：
1. **延迟瀑布**（dashboard 增强）：
   `session_timings` 表记录每阶段耗时（HITL 等待/LLM/工具/传输），
   dashboard 渲染瀑布条形图——"19s 的 writer"变成"首 token 4.2s + 生成 14.8s"
2. **管线并行**：analyst 笔记流式传递给 writer（analyst 边产出 writer 边写），
   总耗时从"串行相加"降为"取最大值"
3. **成本看板**：每会话 token 成本折算（按模型单价表），dashboard 展示
   成本/会话趋势 + prompt 版本横向对比
4. **prompt cache**：MiniMax/glm 的 context caching 若可用，
   supervisor 重复前缀（system + 压缩历史）可省 30-50%

**验证**：优化前后同题集端到端耗时对比（目标：write_reading 阶段 -30%）。

---

## 方向④：可靠性与混沌测试

**缺口**：45 个 error 会话归因粗糙；无系统性故障注入。

**实施**：
1. **故障注入套件**（`scripts/chaos-test.mjs`）：
   模拟 LLM 429 / 流中断 / 超时 / 畸形 JSON / answer 409，
   断言会话收敛到 done/error + 用户可见错误 + 无泄漏
2. **error 自动归因**（`scripts/classify-errors.mjs`）：
   LLM 聚类 error 会话（网络/参数/流程死锁/超时），dashboard 展示 top 原因
3. **重试语义细化**：网络类错误（可重试）自动重试 1 次；
   4xx 参数错误直接降级不重试（当前一刀切不重试）
4. **会话完整恢复**：刷新后不止恢复 sessionId——新增 `/api/session/[id]` 查询接口，
   返回对话流历史 JSON，前端重建 entries（断点续传）

**验证**：chaos-test 全部断言通过；刷新页面后对话流完整恢复。

---

## 方向⑤：Agent 自主性升级

**缺口**：仪式顺序硬编码在 prompt（1-8 步）；Agent 无规划能力。

**实施**：
1. **Plan-and-Execute 开关**（`AGENT_MODE=react|plan`）：
   plan 模式下 Supervisor 开局产出完整占卜计划（JSON plan），
   逐步执行并允许按用户反馈修正计划；评估集对比两模式轮次/成功率
2. **工具结果自评估**：rag_search 结果与当前牌无关时
   Agent 自动改写 query 重试一次（带预算）
3. **情绪驱动人格**：emotionTags 累计检测到高焦虑 →
   建议切换心灵疗愈师人格（提示条，非强制）

**验证**：两种模式各跑评估集 3 次，记录轮次/质量差异。

---

## 方向⑥：产品化与规模

**实施**：
1. **PWA**：manifest.json + 图标 + 可安装（meta theme-color 已有基础）
2. **Dockerfile**（多阶段构建：deps → build → runner）+ `docker-compose.yml`
3. **部署文档**（`docs/deployment.md`）：环境变量清单、模型下载、
   数据卷挂载、健康检查
4. 更新 README（新增能力段落）

**验证**：`docker build` 通过 + manifest 被 Chrome 识别为可安装。

---

## 实施顺序与依赖

```
①记忆体系 ──┐
②RAG 精度 ──┼──→ ④可靠性（依赖①②的表结构稳定）
③成本延迟 ──┘         │
                      ▼
              ⑤自主性（在稳定地基上实验）
                      │
                      ▼
              ⑥产品化（最后打包）
```

## 面试讲述结构（配套）

1. **开场定位**（30s）：多 Agent + 混合 RAG + HITL + Reflexion 完整系统，
   有评估套件、观测面板、故障恢复——不是玩具 Demo
2. **两个深技术点**（各 2min）：
   - HITL 挂起流 + 协议配对守卫（400 修复故事）
   - 混合检索 RRF + 引文闭环（[n] 溯源 + 越界标红）
3. **工程判断力**（2min）："降级的不要删"（三级降级永不翻车）+
   评估先行（无 golden set 不调参）
4. **演进方向**（1min）：记忆体系 + 延迟瀑布（具体可落地）

**三个杀手锏数据**：
- 98% 评估通过率（5+4 维度）
- Reflexion 重写 grounding 3 → 9 分
- 400 协议错位定位：tool 响应被 user 消息隔断（MiniMax 严格协议）
