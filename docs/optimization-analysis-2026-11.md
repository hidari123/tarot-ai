# Mystic Tarot · 第二轮优化分析（2026-11-04）

> **这一轮的定位**：上一轮（[optimization-report.md](optimization-report.md)，2026-10-28）
> 与公网化改造（2026-11-03/04）已经把清单打掉了。
> 这一轮的问题不是"还有什么该优化"，而是：
> **打掉之后，瓶颈跑到哪去了？**
>
> 所以本文的方法论是：**先重新体检，再列清单**——
> 不用"感觉这里还能优化"，只用**实测数据 + 代码证据**。

---

## 一、方法论：这一轮怎么找问题

### 1.1 三条来源

| 来源 | 手段 | 产出 |
|---|---|---|
| **生产数据体检** | 11 个新诊断脚本（`scripts/dev/`） | 瓶颈的**量化位置** |
| **前端静态审计** | subagent 逐文件读，50+ 条带行号 | 体验与工程债 |
| **后端静态审计** | subagent 逐文件读，58 条带行号 | 架构与正确性 |

### 1.2 ⚠️ 审计结论必须独立验证

两个 subagent 给了 100+ 条结论。**我没有直接采信**——
逐条用代码与数据复核，结果：

- **证实 6 条**（下面 P0/P1 的 ①②③④⑤⑥）—— 包括 3 条**我上一轮的漏网**
- **降级 3 条**（下面"被证伪/降级的审计结论"）
- **本轮自己发现的 4 条**（subagent 没提到的）

> **这一轮我自己踩了同一个坑**（第三次）：
> 写 `verify-telemetry-buffer` 时，断言"done 会话一定有 LLM 用量"，
> 结果**降级路径会话**（本地剧本引擎，不调 LLM）usage=0 被误判成"丢数据"。
> **结论**：断言失败时，先怀疑断言，再怀疑代码 —— 但**必须用数据核实**。

---

## 二、实测基线（改造后的真实状态）

### 2.1 会话终态

```
done   295 场  59.2%
error  203 场  40.8%
总计   498 场
```

失败原因分布：

| 原因 | 场数 | 占比 | 平均工具调用 | 性质 |
|---|---|---|---|---|
| `client_disconnect` | 79 | 15.9% | **3.5 → 1.1**（修复后） | 用户主动离开 ✅ |
| `ttl_expired` | 69 | 13.9% | 2.4 | 用户离开但没断开 |
| `stale_timeout` | 24 | 4.8% | 4.5 | 真僵死 |
| `llm_error` | 22 | 4.4% | 4.4 | 上游故障 |
| `max_rounds` | 7 | 1.4% | **19.0** | 轮次预算撞墙 |

> **重要澄清**：40.8% 的 error 里，**近七成是用户自己走了**（disconnect + ttl）。
> 真正需要修的技术性失败只有 `stale_timeout` + `llm_error` + `max_rounds` = **53 场（10.6%）**。
> 把"用户离开"当成"系统故障"去优化，方向就错了。

**abort 修复的效果实测**（`fix-effect.mjs`）：

```
最近 20 场 client_disconnect：平均 1.1 次工具调用
其中 16/20 场在 ≤2 次工具调用就断开（早退出 = 没白烧 token）
```

修复前平均 **3.5** 次 → 修复后 **1.1** 次。
**上一轮的 AbortController 修复确实生效了**（早退出，不白烧）。

### 2.2 token 消耗结构 —— 单一热点

```
supervisor   2813 次  prompt 11,392,904  completion 829,486   占 93.3%
reviewer      202 次  prompt    381,919  completion  99,868   占  3.7%
analyst       183 次  prompt    247,536  completion  54,971   占  2.3%
writer         57 次  prompt     66,670  completion  20,972   占  0.7%
总计 13,094,326 tokens
```

**supervisor 一个 Agent 吃掉 93.3%**。这是唯一值得优化的成本大头。

单场分布：

```
287 场 done · 均值 36,239 tokens · 中位 19,590
P90 80,893 · P99 108,592 · 最大 173,170
最贵的 10 场只占总量 10.2%   ← 分布健康，没有长尾问题
```

### 2.3 supervisor prompt 的精确构成

这是本轮最有价值的实测（`prompt-breakdown.mjs`）：

| 部分 | 未压缩 | 压缩后 | 变化 |
|---|---|---|---|
| system | 1647 | 1647 | 0% |
| user 消息 | 136 | 136 | 0% |
| assistant 正文 | 503 | 433 | −14% |
| tool 结果 | 3239 | 1289 | **−60%** ✅ |
| **tool_calls 参数** | **2689** | **2689** | **0%** ⚠️ |
| 合计 | 8214 | 6194 | −25% |

**`tool_calls.arguments` 占压缩后 prompt 的 43.4%，而 `trimHistory` 对它完全无效。**

#### 为什么 tool_calls 参数这么大？

模型自己写的参数（实测 `tool-args.mjs`）：

```
reveal_card (299 字):   narrative 78 + meaning 77 + question 29 + options 40
interpret_card (277 字): reading 244
close_reading (298 字):  closing 194 + question 18 + options 39
```

这些是**占卜仪式的核心内容**（牌面叙述、解读正文、提问）——不是垃圾。

#### 但 tool 结果把它们又抄了一遍

实测重复率（`dup-content.mjs`）：

| 工具 | args | tool 结果 | 重复 | 重复率 |
|---|---|---|---|---|
| `establish_contract` | 142 | 111 | 60 | **54%** |
| `reveal_card` | 299 | 275 | 155 | **56%** |
| `reveal_card` | 264 | 239 | 131 | **55%** |
| `reveal_card` | 280 | 256 | 170 | **66%** |
| `close_reading` | 298 | 274 | 194 | **71%** |
| `interpret_card` | 277 | 279 | 0 | 0% ✅ |

**tool 结果总 3239 字里，710 字（22%）是纯重复。**

#### 累积成本（`dup-cost.mjs`）

prompt 是累积的 —— 第 k 轮省 d 字，**后续每一轮都省 d 字**：

```
reveal_card(#15) 省 155 字 → 影响后 25 轮 → 3875 字
reveal_card(#21) 省 131 字 → 影响后 19 轮 → 2489 字
reveal_card(#32) 省 170 字 → 影响后  8 轮 → 1360 字
establish_contract(#3) 省 60 字 → 影响后 36 轮 → 2160 字
close_reading(#39) 省 194 字 → 影响后 1 轮 → 194 字
──────────────────────────────────────────────
单场累计浪费 ≈ 10,078 字 ≈ 4,031 tokens
```

对比单场 supervisor 消耗 25,046 tokens → **可省约 16%**。

### 2.4 投机预检索：命中率 0%（`prefetch-waste.mjs`）

```
统计：0 / 60 次 rag_search 能命中预取缓存（0.0%）
reveal_card 406 次（每次触发一次预检索）· rag_search 593 次
→ 预检索做了约 406 次检索，命中后续 rag_search 的仅 0 次
```

**根因（两个都不匹配）**：

1. **query 不同**：预取用 `rewriteQueryLocal(牌名)`，实际检索用 `rewriteQueryLocal(模型 query)`
   实测样本：
   ```
   预取 key:  5|权杖七
   实际 key:  10|权杖七 复合 前任
   ```
2. **top_k 不同**：预取固定 5，模型实际传 10 种不同的值（10 占 55.8%）

**而且 `hybridSearch` 是同步 CPU 计算**（实测 3~4ms/次，阻塞事件循环）——
所以预检索并没有"提前"做任何事，只是**多同步算一遍**。

> ⚠️ 但预检索**不是完全无用**：它把 hits 写进 `session.ragHits`，
> 保证 `[n]` 引文编号连续。**这个价值是真的**，
> 错的只是 README 里"省 1~3s 等待"的说法。

### 2.5 表的增长与清理覆盖

```
sessions          498 行
tool_calls       2688 行
llm_usage        3255 行
event_log        6539 行
session_timings  3819 行   ← 每日清理漏了
user_profiles       2 行   ← 每日清理漏了
```

每日清理只删：`tool_calls, llm_usage, sessions, event_log`

**`session_timings` 与 `user_profiles` 无限增长**，
而 `getStageAggregates`（dashboard 冷缓存时）还对 `session_timings` 全表 GROUP BY。

### 2.6 state_json 写放大

```
平均快照 5,918 字节 · 最大 25,207 字节
每 10 秒重写一次脏会话 → 一场 14 轮占卜约 14 次全量写
```

---

## 三、优化清单

### P0 —— 必须做（有明确证据，成本极低）

#### ① `share_token` 列无索引 → 分享链接全表扫

**证据**：`src/lib/db.ts` 有 `idx_sessions_share_token` ❌ —— grep 无结果。
`getSessionByShareToken` 按 `share_token` 查询。

**为什么严重**：分享链接是**公网入口**，每次访问都全表扫 `sessions`；
而 better-sqlite3 是**同步**的 → 直接阻塞事件循环 → 拖慢所有并发 SSE 流。
`session_timings` 已经 3819 行、`sessions` 会一直涨。

**修法**：一行
```sql
CREATE INDEX IF NOT EXISTS idx_sessions_share_token ON sessions(share_token);
```

#### ② `truncatedSessions` 永不清理 → 进程内存泄漏

**证据**：`clearTruncated` 全项目**只有一个定义、零调用点**（grep 确认）。

**后果**：`Set` 只 add 不 delete → 每场占卜加一条 → 占卜是高频操作 →
进程级内存单调增长，几周后就是几十 MB 的纯泄漏。

**修法**：会话结束的 finally 里 `clearTruncated(session.id)`。

#### ③ 审校**解析失败**的降级 review 未标 `truncated` → 假绿灯漏网

**证据**：`src/lib/agent/subagents.ts:279` 的降级 review：
```ts
pass: true,                    // ⚠️ 没被审校，却算"通过"
scores: { grounding: 0, ... },
parseLevel: 0,
```

**这是我上一轮的漏网**：上一轮修了 `supervisor.ts` 的审校不可用降级路径，
但漏了 `subagents.ts` 的**解析失败**降级路径。
两者都是"根本没审校，却产出 `pass: true`"。

**后果**：dashboard 的审校通过率仍把 184 场解析失败算进分母 → 指标继续失真。

**修法**：同样打 `truncated: true` 标记（复用同一通道）。

#### ④ `ReviewSchema` 缺 `truncated` 字段 → 前后端契约不完整

**证据**：`schema.ts` 的 `ReviewSchema` 有 `parseLevel` / `retried`，**没有 `truncated`**；
而 `ReviewResult`（subagents.ts:168）有 `truncated?: boolean`。

**后果**：前端用 `parseAgentEvent`（走 zod）时该字段被剥离 →
前端拿不到"本次未经完整审校"的信息。

#### ⑤ 每日清理漏 `session_timings` / `user_profiles`

**证据**：`db.ts` 清理定时器只删 4 张表。
`getStageAggregates` 对 `session_timings` 全表 GROUP BY。

**修法**：清理定时器补两条 DELETE。

#### ⑥ 完全没有错误边界 → 任何客户端异常 = 整页白屏

**证据**：grep 确认 `src/` 下**无** `error.tsx` / `global-error.tsx` / `ErrorBoundary`。

**后果**（最严重的 UX 故障）：
- 组件抛错 → React 卸载整棵树 → **白屏**
- **正在跑的 14 次 LLM 占卜全部作废**（¥0.58/场）
- 用户只能刷新

**修法**：加 `src/app/error.tsx`（路由级）+ `src/app/global-error.tsx`（根级）。
约 40 行，收益最高。

---

### P1 —— 成本可控，收益明确

#### ⑦ tool 结果重复 arguments 内容 → 单场省 ~16% prompt

见 §2.3。**修法**：工具返回**结构化确认 + 新增信息**，不回显模型已写在 arguments 里的正文。

- `reveal_card` → 返回 `{ok:true, card:"过去·圣杯一"}`（不重复 narrative/meaning）
- `close_reading` → 返回 `{ok:true, saved:true}`
- `establish_contract` → 返回 `{ok:true, userConfirmed:"..."}`（用户的确认是**新**信息）

⚠️ 注意：OpenAI 协议要求 tool 消息必须对应 `tool_call_id`，但**内容**可以是简短确认。

#### ⑧ 投机预检索命中率 0% → 406 次纯重复劳动

见 §2.4。**修法**（三选一）：
- (a) 让预取的 cacheKey 与后续检索一致（用**牌名子串**查已缓存的单牌结果）
- (b) 删掉预检索，只保留"写 session.ragHits 保证编号连续"这部分
- (c) 至少修正 README 里"省 1~3s"的**错误说法**

#### ⑨ `state_json` 每 10 秒全量重写（平均 5.9KB / 场 14 次）

**修法**：只写**自上次快照以来的增量**（messages tail + ragHits 新增 + cardReadings 变化），
或把 messages 剥离成独立 append-only 表。

#### ⑩ `supervisor.ts:86` 的 `session.busy = true` 与路由层重复占用

**证据**：路由层 `tryAcquireSession` 已原子占用 busy；supervisor 又写一次。

**后果**：busy 标志的**所有权不唯一** → 释放时机不确定。

**修法**：busy 的唯一写入点是 `tryAcquireSession` / `releaseSession`。

#### ⑪ `supervisor.ts:105` 与 `:137` 连续两次写 `prompt_version`

**证据**：第 105 行写 `PROMPT_VERSION`，第 137 行写 `${PROMPT_VERSION}/${agentMode}`
—— **前者被后者完全覆盖**，白写一次 DB，且版本对比口径可能错。

#### ⑫ 会话从快照恢复后，事件 seq 从 1 重来 → 与 `event_log` 已落库的 seq 重复

**证据**：`event-log.ts` 的 buffer 在恢复会话时新建，`nextSeq` 从 1 开始；
而 `event_log` 表里同一 sessionId 已有 seq。

**后果**：恢复场景下 `Last-Event-ID` 语义失效（断点续传补发会与已收事件重复）。

**修法**：恢复时用 DB 里的 `max(seq)` 初始化 `nextSeq`。

#### ⑬ `db.ts` 的 `JSON.parse(r.cards_json)` 无兜底 → 一张脏数据让 dashboard 500

**证据**：同文件已有 `safeParse`（db.ts:271）却没用上。

#### ⑭ `MAX_ROUNDS` 固定 22，不随牌数变化

**证据**：仪式需要约 14 轮；实测 `max_rounds` 失败的会话平均 **19.0** 次工具调用
—— 说明模型经常撞墙。

**修法**：按 `牌数 × 2 + 固定 8` 动态计算，而不是固定 22。

---

### P2 —— 体验与工程债

#### ⑮ a11y 基线为 0

grep 验证：`src/` 下 **0 个** `aria-label` / `role=` / `aria-live` / `aria-modal` / `tabIndex`。

- 两个模态框（`CardPreviewModal` / `ShareCard` 预览）无 `role="dialog"`、无 focus trap、无焦点还原
- 所有 input 只有 placeholder 无 label
- `AgentTrace` 的 hover tooltip 键盘不可达（无 `focus-within`）

#### ⑯ 零代码分割

grep 验证：**0 处** `next/dynamic` / `React.lazy` / `Suspense`。
`ShareCard`（Canvas 渲染 ~190 行）与 `SubAgentPipeline` 都是"点开才用"却进首屏 bundle。

#### ⑰ zod 完整版进客户端 bundle + 每事件一次 safeParse

`page.tsx` 导入 `parseAgentEvent` → 拖入 zod v4 完整版；
而生产环境每个 SSE 事件都跑一次 `safeParse`（delta 每秒 20+ 次）。
**改法**：schema 拆服务端版 / 前端轻量 type guard 两份。

#### ⑱ `StardustCursor` 永久 rAF + 90 颗星无限动画

首屏立即启动，空闲时仍每帧 `clearRect` + 遍历粒子；90 条 `infinite` CSS 动画常驻。
**改法**：mousemove 后启动 / 静止 1s 暂停。

#### ⑲ `@fontsource/noto-serif-sc` 是死依赖

`package.json` 列了它，但 `layout.tsx` 从未 import；
而 `ShareCard.tsx` 的 Canvas 字体写的是 `'Noto Serif SC'` / `'Noto Sans SC'`
—— **浏览器里根本不存在** → Canvas 静默回退到 sans-serif → 分享卡字体与设计不符。

#### ⑳ 全局缺 `prefers-reduced-motion`

只有 `StardustCursor` 自己检查了；魔法阵、星点、rune-breathe、typing-cursor
对动效敏感用户照常播放。

#### ㉑ `trimHistory` 只改副本 → `session.messages` 仍线性增长

压缩只作用于**发给模型的副本**，`session.messages` 本身只增不减，
且被 `state_json` 全量序列化。与 ⑨ 是同一个根因的两面。

#### ㉒ 定时器未 cleanup（4 处）

- `page.tsx` 的 rAF（`scheduleDeltaFlush`）卸载后仍会触发 → setState on unmounted
- `CardFan` / `CitedReading` / `KnowledgePanel` / `ShareCard` 的 `setTimeout(2500)`

---

## 四、被证伪 / 降级的审计结论

> 记录下来是为了**防止后人重复调查**，也说明"审计结论要验证"不是空话。

| 审计结论 | 复核结果 | 说明 |
|---|---|---|
| "缓存 key 含 `top_k` 导致大量重复计算" | **降级为"影响很小"** | 实测只多造成 **2 次**重复 —— 模型在同一场里通常用同一个 top_k。设计上是瑕疵，实际收益极小 |
| "预检索必然不命中下一轮" | **部分成立** | 命中率确实 0%，但预检索的**真实价值**是"写 `session.ragHits` 保证 `[n]` 编号连续"，不是"省时间" |
| "`session.messages` 线性增长是性能问题" | **成立但要合并看** | 与 ⑨（state_json 全量重写）是同一根因：messages 既进 prompt 又进快照。剥离 messages 能同时解决两者 |

---

## 五、建议实施顺序

按"**收益 ÷ 成本**"排：

| 批次 | 内容 | 理由 |
|---|---|---|
| **第一批** | ①②③④⑤⑥ | 全部是**一两行**的改动（索引 / finally / 字段 / DELETE / 两个新文件），但每条都指向一个真实故障模式 |
| **第二批** | ⑦⑧⑨⑩⑪⑫⑬⑭ | 需要改协议或数据流，但都有精确的量化收益（⑦ 单场省 16%） |
| **第三批** | ⑮~㉒ | 体验与工程债，可按需 |

---

## 六、这一轮的元教训

三条，都是**实测**换来的：

1. **打掉清单 ≠ 没有瓶颈了**
   —— 上一轮把 P0~P3 全做完，但 supervisor 立刻吃掉了 93.3% 的 token。
   **优化是转移，不是消灭**。

2. **审计结论要独立验证**
   —— 100+ 条里证实 6 条、降级 3 条。不验证就实施，
   会把"设计瑕疵"当成"严重 bug"去做无用功。

3. **断言失败时，先怀疑断言**
   —— 第三次了（`truncated` 字段位置 / 历史数据归属 / 降级路径 usage=0）。
   **代码是对的、断言是错的** —— 这个模式反复出现，值得写进项目原则。

---

## 附：本轮新增的诊断工具

全部在 `scripts/dev/`（无断言、用完即弃、不进 CI）：
`health-check` / `prompt-histogram` / `message-structure` / `prompt-composition` /
`prompt-breakdown` / `tool-args` / `dup-content` / `dup-cost` /
`prefetch-waste` / `cache-key-design` / `fix-effect` / `telemetry-check`

用法与定位见 [`scripts/dev/README.md`](../scripts/dev/README.md)。
