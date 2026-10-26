# Mystic Tarot 核心技术深度文档

> 三个重点模块的完整技术剖析：**自定义光标** / **Agent 架构** / **RAG 检索**
>
> 配套代码：`src/components/StardustCursor.tsx`、`src/lib/tarot-agent.ts`、`src/lib/rag-engine.ts` + `src/lib/vector-engine.ts`
>
> 阅读顺序建议：第 1 章（先搞清 RAG 真假）→ 第 2 章（RAG）→ 第 3 章（Agent）→ 第 4 章（光标）

---

## 目录

- [第 1 章：先说清楚 —— RAG 到底是不是 mock？](#第-1-章先说清楚--rag-到底是不是-mock)
- [第 2 章：RAG 检索系统深度剖析](#第-2-章rag-检索系统深度剖析)
- [第 3 章：Agent 架构深度剖析](#第-3-章agent-架构深度剖析)
- [第 4 章：自定义光标深度剖析](#第-4-章自定义光标深度剖析)
- [第 5 章：三者的交汇点 —— 一条占卜请求的完整生命周期](#第-5-章三者的交汇点--一条占卜请求的完整生命周期)
- [第 6 章：面试问答准备](#第-6-章面试问答准备)
- [第 7 章：P0-P4 优化实录 —— 用生产数据驱动改进](#第-7-章p0-p4-优化实录--用生产数据驱动改进)

---

# 第 1 章：先说清楚 —— RAG 到底是不是 mock？

这是最容易被误解、也最需要诚实交代的部分。

## 1.1 结论先行

| 组件 | 是不是 mock | 说明 |
|---|---|---|
| **知识库数据** | ✅ **真实** | 79 条真实塔罗数据，源自开源项目 [tarot-lab](https://github.com/look-fate/tarot-lab)（MIT 协议），字段含中文牌面叙事、正/逆位牌意、原文出处链接 |
| **BM25 检索通道** | ✅ **真实** | 完整实现 Okapi BM25（k1=1.5, b=0.75）+ IDF + 中文 2-gram 切词 + 字段权重 + 每牌去重。纯数学计算，与真实 BM25 无异 |
| **向量检索通道** | ✅ **真实** | transformers.js 本地 ONNX 推理，真实 embedding 模型 `Xenova/all-MiniLM-L6-v2`（384 维，量化版 22MB），**已成功下载并启用**。仍保留特征哈希与纯 BM25 两级降级兜底 |
| **RRF 融合** | ✅ **真实** | 标准 Reciprocal Rank Fusion（k=60），工业界通用做法 |
| **RAG 注入 Prompt** | ✅ **真实** | 检索命中的原文片段真实进入 LLM 的 system prompt，解读里的「典籍有云：…」和 `[n]` 编号都对应真实命中的知识块 |
| **本地降级引擎** | ⚠️ **是 mock** | 仅当完全没配 API Key 时启用，是模拟 Agent 行为的剧本，不是真检索 |

> **结论：RAG 全链路真实，无 mock。** 下面的 1.2 节保留了整个排查过程，因为它记录了**向量通道从"降级"升级回"真模型"的全过程**——这段经历本身就是很好的面试素材（如何定位一个"看起来在跑但其实是假"的链路）。

## 1.2 向量通道：从"卡死"到"真模型"（完整排查复盘）

这是本项目**最真实也最有价值**的一个工程问题。分两个阶段。

### 阶段一：卡死事故（2026-10-23）

**症状**：Agent 在 `rag_search` 工具处卡死，SSE 流 7.3 分钟无输出，最后客户端超时断开。

**第 1 步 —— 查服务端日志**：
```
POST /api/interpret 200 in 7.3min (next.js: 55ms, application-code: 7.3min)
```
服务端"返回了 200"，但用了 7.3 分钟。前端展示的 `application-code: 7.3min` 说明时间花在业务逻辑里，不是框架层。

**第 2 步 —— 查 SQLite 流水**（这是本项目可观测性的价值体现）：
```sql
SELECT agent, duration_ms, ok FROM llm_usage WHERE session_id = '...';
-- 3 次 supervisor 调用，全部 OK，最后一次 16:19:37，之后再无任何记录
-- 既没有成功记录，也没有失败记录(ok=0)

SELECT tool, result_summary FROM tool_calls WHERE session_id = '...';
-- 只有 2 条：ask_user、offer_card_selection
```
**关键推论**：LLM 调用记录**同时没有成功也没有失败**，说明卡住的地方**根本不是 LLM 调用**——否则超时会抛异常，至少留下 `ok=0` 的记录。

**第 3 步 —— 直接复现 LLM**：用 curl 构造相同的消息序列（选牌应答后的上下文）请求 glm-5.3：
```
STATUS: 200 in 3469 ms
tool_calls: [{"name":"rag_search", ...}, ...]   ← 正常返回
```
LLM API 排除了。

**第 4 步 —— 转向工具执行**：`rag_search` → `hybridSearch` → `vectorSearch` → `ensureIndex` → `getPipeline` → `createPipeline("feature-extraction", MODEL_ID)`

**第 5 步 —— 检查缓存目录**（决定性证据）：
```
data\.cache\Xenova\all-MiniLM-L6-v2\config.json    650 bytes   ← 唯一存在的文件
data\.cache\Xenova%2Fall-MiniLM-L6-v2\              （空目录）
```
`model_quantized.onnx`（约 22MB）**从未下载成功**。而 `config.json` 是我之前手动测试 curl 时留下的残留。

**第 6 步 —— 验证网络**：
```
hf-mirror.com      → ECONNRESET / UND_ERR_CONNECT_TIMEOUT
huggingface.co     → ECONNRESET
本机代理 127.0.0.1:7897 → 隧道建立成功(200) 但 TLS 握手失败:
  schannel: next InitializeSecurityContext failed: SEC_E_INVALID_TOKEN
```
代理节点对境外域名**TLS 层被重置**（国内站点 baidu/npmmirror 走同一代理正常）。换 `curl -x` 显式代理、`undici ProxyAgent` 全局 dispatcher 都试过，同样结果。

**根因确认**：`transformers.js` 内部用原生 `fetch` 下载模型文件，**它自己不带超时控制**。域名不可达时，连接会一直挂着（Windows TCP 对不可达地址要 20~80 秒才报错，之后 fetch 静默重试），**整个 Agent 生成器被无限期挂起**。

### 阶段二：修复与最终启用（三层保护 + 重新下载）

**修复 1 —— 三级超时保护**（这是让系统"不再卡死"的关键）：

```typescript
// ① 模型加载硬超时（60s）——用 Promise.race 强制中断
pipeline = await Promise.race([
  createPipeline("feature-extraction", MODEL_ID, { dtype: "q8" }),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`模型加载超时(${MODEL_TIMEOUT_MS}ms)，降级哈希向量`)), MODEL_TIMEOUT_MS)
  ),
]);

// ② 失败标记：失败一次后本进程不再重试（避免每次检索都吃一次超时）
let modelLoadFailed = false;

// ③ 检索层软超时（8s）：向量通道最多等 8 秒，超时按"无命中"处理
const vecWithTimeout = Promise.race([
  vectorSearch(query, topK * 2),
  new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
]).catch(() => null);
```

**修复 2 —— 重新下载模型**（网络恢复后，2026-10-25）：

先做连通性矩阵测试，确认哪个源可用：
```
=== 直连（无代理）===
  hf-mirror        OK 200 (701ms)   ✅
  hf-official      FAIL UND_ERR_CONNECT_TIMEOUT
  hf-mirror-cdn    HTTP 403
  modelscope       OK 200 (466ms)   ✅ 备用源
  jsdelivr-npm     FAIL ECONNRESET
  gitee            HTTP 404
```

`hf-mirror.com` 恢复可用，于是用脚本下载全部 5 个模型文件：
```
config.json                    OK 1KB
tokenizer.json                 OK 695KB
tokenizer_config.json          OK 0KB
special_tokens_map.json        OK 0KB
onnx/model_quantized.onnx      OK 22434KB (10.7s)
```

**踩坑：目录结构**。transformers.js 找的是 `Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx`（**斜杠目录**），而我最初下载到 `Xenova%2Fall-MiniLM-L6-v2`（**URL 编码目录**），报 `ModelFileNotFoundError`。修复：两套结构都放一份。

**修复 3 —— 检测到本地模型就完全离线**：
```typescript
const localModelFile = join(CACHE_DIR, "Xenova", "all-MiniLM-L6-v2", "onnx", "model_quantized.onnx");
if (existsSync(localModelFile)) {
  env.allowRemoteModels = false;   // 彻底杜绝下载挂起
  env.allowLocalModels = true;
}
```

### 最终效果：真实语义检索验证

**模型能力实测**（`scripts/test-embedding.mjs`，离线模式）：

| 语义对 | 余弦 | 判断 |
|---|---|---|
| "升职加薪的机会" ≈ "事业上升，报酬增加" | **0.704** | 字面几乎不重叠，语义高度接近 ✅ |
| "感情出现裂痕" ≈ "亲密关系面临破裂的危险" | **0.656** | ✅ |
| "面试前很紧张" ≈ "即将到来的考验令人忐忑不安" | **0.599** | ✅ |
| "心里放不下他" ≈ "留恋逝去的一切，无法释怀" | **0.451** | ✅ |
| "今天天气不错" ≈ "生活需要仪式感"（对照） | 0.478 | 噪声基线 |

**语义检索实测**（`scripts/warmup-vectors.mjs`，对 312 个知识块建索引）：

| 查询 | 语义命中 | 牌意核对 |
|---|---|---|
| "感情出现裂痕怎么办" | **宝剑八**(0.79) | 宝剑八 = 被蒙蔽、束缚、看不到出路 ✅ 精准 |
| | 圣杯八(0.75) | 圣杯八 = 离开、放下、寻找更深意义 ✅ |
| "心里放不下他" | **圣杯一**(0.64) | 圣杯一 = 新情感、爱慕、倾心 ✅ |
| | 圣杯七(0.64) | 圣杯七 = 幻想、选择困难 ✅ |
| "钱的问题令人焦虑" | 审判(0.75)、倒吊人(0.69) | 倒吊人 = 牺牲、等待、悬置 ✅ |

**这些牌意字面上完全不匹配**（"感情裂痕"里没有"宝剑八"三个字），纯 BM25 绝无可能命中——**这正是语义向量的价值**。

**应用端 E2E 验证**（Agent 的 rag_search 工具实际调用）：
```
1. 检索到 8 条：权杖一(1,bm25)、宝剑三(1,vector)、星币六(0.98,bm25)
2. 检索到 6 条：星币十(1,bm25+vector)、星币五(0.55,bm25)、圣杯四(0.54,bm25)
3. 检索到 6 条：圣杯四(1,bm25+vector)、星币四(0.91,bm25+vector)、宝剑四(0.51,vector)
4. 检索到 6 条：星币侍卫(1,bm25)、星币一(0.98,bm25)、宝剑侍卫(0.98,vector)
5. 检索到 6 条：星币二(1,bm25+vector)、星币八(0.99,bm25+vector)、星币三(0.97,bm25+vector)
```
- `bm25+vector` 大量出现 → **两路独立召回后 RRF 融合**
- 纯 `vector` 命中（如"宝剑三(1,vector)"）→ **BM25 完全匹配不到、只有语义能命中**

### 现在的检索质量对比

| 查询 | 修复前（纯 BM25） | 现在（BM25 + 真实向量 RRF） |
|---|---|---|
| "复合 感情" | 星币六(1)、女皇(0.91)、圣杯十(0.24) | 融合后：圣杯十、星币六、女皇、宝剑八… |
| "感情出现裂痕" | 权杖七(1)、星币七(0.38)、宝剑七(0.36) | **宝剑八(0.79,vector)**、圣杯八(0.75,vector)… |
| "心里放不下他" | 星币六(1)、女皇(0.91) | **圣杯一(0.64,vector)**、圣杯七(0.64,vector)… |

> **面试话术**："这个项目里 RAG 向量通道我踩了个很典型的坑：Agent 会在检索时卡死 7 分钟。当时最迷惑的是——LLM 调用记录**既没有成功也没有失败**，说明卡住的根本不是 LLM。最后定位到是 transformers.js 下载 embedding 模型时，它的内部 fetch 没有超时保护。
>
> 修完之后我做了三件事：① 给模型加载加 60 秒硬超时 + 检索层 8 秒软超时 + 失败标记不重试；② 网络恢复后写了下载脚本，把模型文件拉到本地，**并且发现目录结构有坑**——transformers.js 找的是斜杠目录，我下到的是 URL 编码目录，报 ModelFileNotFoundError；③ 检测到本地模型就设 `allowRemoteModels = false`，彻底离线，杜绝下载挂起。
>
> 最终效果是能真正做语义匹配：查询'感情出现裂痕'，向量通道命中宝剑八（被蒙蔽、束缚、看不到出路）和圣杯八（离开、放下），这些牌意**字面上跟查询毫无重叠**，纯 BM25 根本不可能命中。这就是混合检索的意义——**BM25 管'字面说了什么'，向量管'意思像什么'**。"

## 1.3 三级降级策略：为什么仍要保留降级层

**现在真实模型已可用**（`Xenova/all-MiniLM-L6-v2`，本地离线推理），但三级降级依然保留：

```
Level 1: transformers.js 本地 ONNX 真实 embedding  ← 当前生效
         ↓ 模型文件缺失 / 加载超时
Level 2: 特征哈希 n-gram 向量 (自研, 256 维)
         ↓
Level 3: 纯 BM25
```

**为什么不一劳永逸地删掉降级层？**

| 理由 | 说明 |
|---|---|
| **部署环境不可控** | 面试现场、CI 环境、别人的机器上可能没有模型文件 |
| **模型文件体积** | 22MB 量化模型，容器镜像要带它；某些部署策略不允许 |
| **CPU 推理成本** | 312 块首次 embed 约 4.4 秒，索引缓存失效时会重算 |
| **演示不能翻车** | 降级到哈希向量后，检索管道结构不变（两路 + RRF），演示流程完整 |

**关键认知**：降级不是"功能残废"，而是**优雅降级（Graceful Degradation）**——每一级都保证 Agent 主流程可用。

### 特征哈希：降级方案是什么水平

**它做什么**：把文本切成 n-gram，用 FNV-1a 哈希映射到 256 维空间，加符号防碰撞，L2 归一化。

```typescript
export function hashEmbed(text: string): Float32Array {
  const vec = new Float32Array(HASH_DIM);   // 256
  for (const n of GRAM_SIZES) {              // 2-gram, 3-gram
    for (let i = 0; i <= clean.length - n; i++) {
      const h = fnv1a(clean.slice(i, i + n));
      vec[h % HASH_DIM] += (h >>> 31) === 1 ? -1 : 1;
    }
  }
  // L2 归一化 → 点积即余弦相似度
}
```

**和真 embedding 的差距（诚实评估）**：

| 维度 | 真 embedding (MiniLM) | 特征哈希 |
|---|---|---|
| 语义泛化 | "心里放不下他" ≈ "留恋逝去" ✅ (0.451) | ❌ 无法跨词泛化 |
| 同义匹配 | 能 | 不能 |
| 顺序敏感 | 弱（会学） | 中（n-gram 保留局部顺序） |
| 与 BM25 互补性 | 强（不同信号） | 弱（粒度相近，只是 3-gram 更细） |
| 依赖 | 模型文件 22MB | 零 |

**所以它的真实价值是**：保证 RRF 融合管道始终有两路、提供一个"有结构的第二视角"、演示不翻车。

> **面试话术**："真 embedding 模型现在已经能用了，但我保留了特征哈希和纯 BM25 两级降级。理由是**部署环境不可控**——面试现场、CI、别人的机器上可能没有那 22MB 模型文件。降级不是功能残废，是优雅降级：每一级都保证 Agent 主流程可用。而且我会在知识面板保留 `channels` 标记，让降级状态**可被观测**，而不是假装一切正常。"

## 1.4 怎么验证 RAG 是真的（给面试官/自己看的验证方法）

**方法 1：看知识面板的来源标注**
每条命中都带 `source: "tarot-lab · 权杖七 · 正位牌意"`，可回溯到 `src/data/tarot-lab-cards.json` 原文。

**方法 2：看解读里的引用编号**
```
【未来 · 愚人】
愚人预示一段新的旅程与轻盈的跃步，但请留意他脚下的悬崖……[1]
```
`[1]` 对应知识面板的第 1 条命中。

**方法 3：直接调 API 看真实检索结果**
```bash
curl "http://localhost:3000/api/draw?n=3"
# 注意 /api/draw 不返回牌意文本（保持"翻牌才有解读"的仪式感）
```

**方法 4：写脚本直接测检索函数**
```bash
node -e "const m=require('./mcp-server/rag-engine.cjs');
const h=m.ragSearch('复合 感情',5);
h.forEach(x=>console.log(x.cardNameZh, x.score, x.source));"
# 实测输出：
# 星币六 1 tarot-lab · 星币六 · 关键词
# 女皇 0.91 tarot-lab · 女皇 · 关键词
# 圣杯十 0.24 tarot-lab · 圣杯十 · 牌面叙事
```
注意这里用的是**纯 BM25**（mcp-server 的独立 CJS 实现），完全没碰向量通道——**这本身就是 BM25 真实工作的证据**。

**方法 5：看数据库的检索流水**
```bash
node scripts/inspect-db.cjs
# 输出示例：
# 1. [supervisor] rag_search (4ms) → 检索到 5 条：命运之轮(1,bm25+vector)、权杖四(0.49,bm25)、星币八(0.49,vector)
```
`4ms` 的耗时说明是真在算，不是 mock。

---

# 第 2 章：RAG 检索系统深度剖析

## 2.1 整体架构

```
                    rag_search(query, top_k)
                            │
                            ▼
              ┌─────────────────────────────┐
              │      hybridSearch()          │  ← Agent 唯一入口
              │   (src/lib/rag-engine.ts)    │
              └──────────────┬──────────────┘
                             │  Promise.all 并行
              ┌──────────────┴──────────────┐
              ▼                             ▼
    ┌──────────────────┐          ┌──────────────────┐
    │  BM25 通道        │          │  向量通道         │
    │  ragSearch()      │          │  vectorSearch()   │
    │  · 2-gram 切词    │          │  · 8s 软超时      │
    │  · IDF            │          │  · ONNX 模型      │
    │  · k1=1.5 b=0.75 │          │    ↓ 失败降级      │
    │  · 字段权重       │          │  · 特征哈希 256 维 │
    │  · 每牌去重       │          │  · 每牌去重       │
    └────────┬─────────┘          └────────┬─────────┘
             │                             │
             └──────────┬──────────────────┘
                        ▼
            ┌───────────────────────┐
            │  RRF 融合 (k=60)       │
            │  score = Σ 1/(k+rank) │
            └───────────┬───────────┘
                        ▼
            ┌───────────────────────┐
            │  每牌去重 → top-k      │
            │  归一化 score (0~1)    │
            │  channels: [bm25|     │
            │            vector]     │
            └───────────┬───────────┘
                        ▼
            ┌───────────────────────┐
            │  buildPromptContext() │
            │  "[1] 来源\n    片段"  │
            └───────────────────────┘
```

## 2.2 第一步：知识分块（Chunking）

### 数据来源

`src/data/tarot-lab-cards.json` —— 79 条记录，每条 6 个字段：

```json
{
  "name": "The Fool 愚人",
  "description": "愚人牌描绘了一个快乐地走向世界的青年。他正在迈出他的第一步...但这似乎与他无关——我们不确定他是天真还是幼稚。",
  "normal": "新的开始，新的旅程，自由，纯真，无限潜力，冒险，理想主义，自发性",
  "reversed": "鲁莽，粗心，心烦意乱，幼稚，愚蠢，容易上当受骗，古板，沉闷",
  "detail": "https://labyrinthos.co/blogs/tarot-card-meanings-list/the-fool-meaning-major-arcana-tarot-card-meanings",
  "link": "Fool.jpg"
}
```

> **注意 `detail` 字段**：这是每张牌意的**原文出处链接**（Labyrinthos 塔罗博客）。我们保留在数据里，虽然当前未在 UI 展示，但它是溯源链的一环。

### 分块策略

78 张牌 × 4 个字段 = **312 个知识块**：

```typescript
export const KNOWLEDGE_CHUNKS: KnowledgeChunk[] = TAROT_CARDS.flatMap((card) => {
  const base = { cardId: card.id, cardNameZh: card.nameZh };
  return [
    { ...base, id: `${card.id}:description`, field: "description",
      text: card.description, tokens: tokenize(`${card.nameZh} ${card.nameEn} ${card.description}`) },
    { ...base, id: `${card.id}:upright`, field: "upright",
      text: card.upright, tokens: tokenize(`${card.nameZh} 正位 ${card.upright}`) },
    { ...base, id: `${card.id}:reversed`, field: "reversed",
      text: card.reversed, tokens: tokenize(`${card.nameZh} 逆位 ${card.reversed}`) },
    { ...base, id: `${card.id}:keywords`, field: "keywords",
      text: card.keywords.join("、"), tokens: tokenize(`${card.nameZh} ${card.keywords.join(" ")}`) },
  ];
});
```

### 三个设计决策

**① 为什么分 4 块而不是 1 块？**

整张牌打包 → 检索"权杖七"会同时返回叙事+正位+逆位+关键词，**信噪比低**。分开后，检索"权杖七 防守"精确命中 `upright` 块，检索"权杖七 悬崖 深渊"命中 `description` 块。

**② 为什么每块都带元数据？**

```typescript
interface KnowledgeChunk {
  id: string;          // 唯一标识 {cardId}:{field}
  cardId: string;      // 所属牌 → 用于每牌去重
  cardNameZh: string;  // 引用展示用
  field: ChunkField;   // 字段类型 → 用于字段权重
  text: string;        // 原文
  tokens: string[];    // 预切词（避免查询时重复切）
}
```
三个用途：
- **溯源**：前端显示"tarot-lab · 权杖七 · 正位牌意"
- **去重**：按 `cardId` 聚合
- **加权**：按 `field` 施加权重

**③ 为什么预先切好 tokens？**

`tokenize()` 对 312 个块只跑一次（模块加载时），查询时只切 query。**索引构建是一次成本，查询是高频操作**——把重活放在冷路径。

## 2.3 第二步：中文切词（2-gram 滑窗）

### 问题

中文没有空格。`"权杖七 防守"` 要切成什么？专业做法是用 jieba/THULAC 分词器。

### 权衡

| 方案 | 优点 | 缺点 |
|---|---|---|
| jieba 分词器 | 精度高 | 引入依赖 + 词典 ~5MB + 首屏加载慢 |
| 英文式 split（按空格/标点） | 极简 | 中文整段成一个 token，检索几乎失效 |
| **2-gram 滑窗** ✅ | 零依赖、召回不错、实现 6 行 | 精度不如真分词，索引体积 2-3 倍 |

### 实现

```typescript
export function tokenize(text: string): string[] {
  const clean = text.toLowerCase().replace(/\s+/g, " ").trim();
  const tokens: string[] = [];
  for (let i = 0; i < clean.length - 1; i++) {
    tokens.push(clean.slice(i, i + 2));   // 滑窗取 2 字符
  }
  if (clean.length === 1) tokens.push(clean);
  return tokens;
}
```

**实例**：
```
"权杖七"   → ["权杖", "杖七"]
"权杖七牌意" → ["权杖", "杖七", "七牌", "牌意"]
```
查询"权杖七牌意"能命中知识块里的"权杖"和"杖七" ✅

**已知局限（面试要主动说）**：
- "权杖" 和 "手杖" 无法区分（同为 2-gram "权杖" vs "手杖"，其实可区分；但"剑"和"宝剑"会有部分重叠）
- 无法做同义词扩展（"分手" vs "关系破裂"）
- 索引体积：312 块 × 平均 200 字符 × 2 字节 = 约 125KB token 数据（内存完全可接受）

## 2.4 第三步：BM25 打分

### 完整公式

```
score(D, Q) = Σ_{qᵢ ∈ Q}  IDF(qᵢ) × (f(qᵢ,D) × (k₁+1)) / (f(qᵢ,D) + k₁ × (1 - b + b × |D|/avgdl))
```

| 符号 | 含义 | 代码 | 取值 |
|---|---|---|---|
| `f(qᵢ,D)` | 词频 | `tfMap.get(t) ?? 0` | 实测 |
| `\|D\|` | 文档长度 | `chunk.tokens.length` | 实测 |
| `avgdl` | 平均文档长度 | 全库均值 | 实测 |
| `k₁` | 词频饱和 | `K1` | **1.5** |
| `b` | 长度归一化 | `B` | **0.75** |
| `IDF(qᵢ)` | 逆文档频率 | `idf()` | 见下 |

### 索引预计算

```typescript
const DF = new Map<string, number>();   // Document Frequency
for (const chunk of KNOWLEDGE_CHUNKS) {
  const seen = new Set(chunk.tokens);    // 注意用 Set：一个 chunk 内重复词只算一次
  for (const t of seen) DF.set(t, (DF.get(t) ?? 0) + 1);
}
const N = KNOWLEDGE_CHUNKS.length;       // 312
const AVG_LEN = KNOWLEDGE_CHUNKS.reduce((s, c) => s + c.tokens.length, 0) / N;

const idf = (token: string): number => {
  const df = DF.get(token) ?? 0;
  // BM25+ 式平滑，避免 df=0 时负值
  return Math.log(1 + (N - df + 0.5) / (df + 0.5));
};
```

**IDF 平滑的意义**：
- 标准 IDF：`log((N-df+0.5)/(df+0.5))` —— 当 df > N/2 时会变**负数**，即"这个词出现得越多越不该匹配"，在长文档里会导致负分
- BM25+ 变体：`log(1 + ...)` —— 恒为正，保证分数可加、不会出现负分项

**DF 统计用 Set 的原因**：一个 chunk 内 "权杖" 出现 5 次，文档频率应该算 1（1 个文档包含它），不是 5。

### 打分实现

```typescript
const scored = pool.map((chunk) => {
  const tfMap = new Map<string, number>();
  for (const t of chunk.tokens) tfMap.set(t, (tfMap.get(t) ?? 0) + 1);

  let score = 0;
  for (const t of qSet) {
    const tf = tfMap.get(t) ?? 0;
    if (tf === 0) continue;
    const norm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (chunk.tokens.length / AVG_LEN)));
    score += idf(t) * norm;
  }
  score *= FIELD_WEIGHT[chunk.field];     // 字段权重
  return { chunk, score };
});
```

**逐 query token 累加**（不是"文档里有几个 query token"那种简化版）——这是标准 BM25，每个 query token 独立贡献 IDF × 饱和词频。

### 字段权重

```typescript
const FIELD_WEIGHT: Record<ChunkField, number> = {
  description: 1.0,   // 牌面叙事：长且杂，权重最低
  upright: 1.2,       // 正位牌意：解读最常用
  reversed: 1.2,      // 逆位牌意
  keywords: 1.4,      // 关键词：短而准，权重最高
};
```

**为什么关键词最高？**
```
"新的开始，新的旅程，自由，纯真，无限潜力，冒险，理想主义，自发性"
```
这是作者对牌意的**浓缩**，8 个词精准概括。搜索"冒险"命中它，比命中几百字的叙事块信息密度高得多。

## 2.5 第四步：每牌去重（真实踩坑）

### Bug 现象

```
01 📖 典籍检索 · rag_search() 6ms
   → 检索到 5 条：权杖七(1)、权杖七(1)、权杖七(1)…
```

**5 条结果全是同一张牌**。

### 根因分析

权杖七的 4 个知识块：
```
Wands07:description  tokens 含 "权杖七"（nameZh 在每个 chunk 的 tokens 里都拼了）
Wands07:upright     tokens 含 "权杖七"
Wands07:reversed    tokens 含 "权杖七"
Wands07:keywords    tokens 含 "权杖七"
```
**4 个 chunk 全部命中"权杖七"这个 query token**。而且它们的 IDF 相同、词频相近、字段权重不同（1.0/1.2/1.2/1.4）但排序后仍挤占前 5 名。

**更深层的原因**：我把 `nameZh` 拼进了每个 chunk 的 tokens：
```typescript
tokens: tokenize(`${card.nameZh} 正位 ${card.upright}`)
//                       ^^^^^^^^^^^^^^ 牌名进了索引
```
这本身是对的（牌名应该可检索），但**当 query 就是牌名时，同牌的 4 个块会同时高分命中**。

### 修复

```typescript
const deduped = scored
  .filter((s) => s.score > 0)
  .sort((a, b) => b.score - a.score)
  .reduce<{ hits: typeof scored; seenCards: Set<string> }>(
    (acc, s) => {
      if (acc.seenCards.has(s.chunk.cardId)) return acc;   // 同牌已取过，跳过
      if (acc.hits.length >= topK) return acc;              // 够了
      acc.seenCards.add(s.chunk.cardId);
      acc.hits.push(s);
      return acc;
    },
    { hits: [], seenCards: new Set<string>() }
  )
  .hits;
```

**修复后效果**：
```
检索到 5 条：太阳(1)、宝剑十(0.18)、死亡(0.13)、女祭司(0.15)、星币十(0.12)
```
5 张不同的牌，分数有层次（不再是全 1.0）。

### 延伸思考（面试可讲）

**为什么是"每牌去重"而不是"每 chunk 去重"？**
因为 **top-k 的语义是"给用户 k 张相关牌"，不是"给用户 k 个知识片段"**。用户的兴趣单位是"牌"，不是"字段"。如果按 chunk 去重，用户可能拿到同一张牌的 4 个字段，重复无新信息。

**更彻底的方案**（我们没做，但可以讲）：
在检索层就把同牌的多字段**聚合**成一个命中（取最高分 chunk，但 snippet 拼接各字段）。这样 top-k 语义更自然，但会让 RRF 融合的粒度变粗。

## 2.6 第五步：向量通道（三级降级）

### 三级设计

```
Level 1: transformers.js 本地 ONNX 真实 embedding
         模型: Xenova/all-MiniLM-L6-v2 (量化版 ~23MB)
         运行时: node_modules/@huggingface/transformers
         特性: 真正语义泛化，384 维，CPU 推理
              ↓ 模型下载失败/超时(60s)
Level 2: 特征哈希 n-gram 向量 (自研, 256 维)
         特性: 零依赖，保留 n-gram 局部顺序，与 BM25 粒度不同
              ↓ 仍不可用
Level 3: 纯 BM25
         特性: 永远可用，放弃向量通道
```

### Level 1：ONNX 真实 embedding（当前生效）

```typescript
async function getPipeline() {
  if (pipeline) return pipeline;
  if (modelLoadFailed) throw new Error("模型加载此前已失败，本进程降级哈希向量");

  const { pipeline: createPipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = CACHE_DIR;                              // 模型缓存到项目内，不污染用户目录
  env.localModelPath = CACHE_DIR;                        // 本地模型目录
  if (!process.env.HF_ENDPOINT) {
    env.remoteHost = "https://hf-mirror.com";            // 国内优先走镜像
  }
  // 检测到本地模型文件 → 完全离线，杜绝下载挂起
  const localModelFile = join(CACHE_DIR, "Xenova", "all-MiniLM-L6-v2", "onnx", "model_quantized.onnx");
  if (existsSync(localModelFile)) {
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
  }
  // Node 原生 fetch 不读 HTTPS_PROXY —— 注入 undici ProxyAgent
  const proxyUrl = process.env.HTTPS_PROXY || ...;
  if (proxyUrl) {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  }
  // 硬超时保护
  pipeline = await Promise.race([
    createPipeline("feature-extraction", MODEL_ID, { dtype: "q8" }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("模型加载超时，降级哈希向量")), MODEL_TIMEOUT_MS)),
  ]);
  return pipeline;
}
```

**embedding 计算**（均值池化 + L2 归一化）：
```typescript
const res = await pipe(batch, { pooling: "mean", normalize: true });
for (let j = 0; j < batch.length; j++) {
  out.push(new Float32Array(res[j].data));
}
```
`normalize: true` 让向量单位长度 → **点积即余弦相似度**，省掉每次计算的模长除法。

**批处理**：一次 16 条，避免单条超 512 token 或内存峰值。312 块全量首次 embedding 实测 **4.4 秒**。

**持久化缓存**：
```
data/.cache/embeddings-Xenova_all-MiniLM-L6-v2.bin   ← flat Float32Array (0.5MB)
data/.cache/embeddings-meta.json                    ← { count: 312, dim: 384, model, mode: "model" }
```
`meta.mode === "model"` 是校验位——防止把哈希向量的缓存误当模型缓存读。

**模型文件位置**（22MB 量化版）：
```
data/.cache/Xenova/all-MiniLM-L6-v2/
  config.json  tokenizer.json  tokenizer_config.json  special_tokens_map.json
  onnx/model_quantized.onnx      ← 22434KB
```

**下载脚本** `scripts/download-model.mjs`：
```bash
node scripts/download-model.mjs    # 5 个文件，onnx 约 10.7s
node scripts/warmup-vectors.mjs   # 构建 312 块向量索引 + 语义检索自检
node scripts/test-embedding.mjs    # 验证模型离线加载 + 语义相似度
```

### Level 2：特征哈希向量

```typescript
const HASH_DIM = 256;      // 向量维度
const GRAM_SIZES = [2, 3]; // n-gram 尺寸

/** 32-bit FNV-1a 哈希 */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);   // FNV 质数 16777619
  }
  return h >>> 0;
}

export function hashEmbed(text: string): Float32Array {
  const clean = text.toLowerCase().replace(/\s+/g, " ").trim();
  const vec = new Float32Array(HASH_DIM);
  for (const n of GRAM_SIZES) {
    for (let i = 0; i <= clean.length - n; i++) {
      const gram = clean.slice(i, i + n);
      const h = fnv1a(gram);
      const idx = h % HASH_DIM;
      const sign = (h >>> 31) === 1 ? -1 : 1;   // 符号哈希抗碰撞
      vec[idx] += sign * (1 / Math.sqrt(GRAM_SIZES.length * Math.max(clean.length - n + 1, 1)));
    }
  }
  // L2 归一化
  let norm = 0;
  for (let i = 0; i < HASH_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < HASH_DIM; i++) vec[i] /= norm;
  return vec;
}
```

**三个设计细节**：

**① 为什么用 FNV-1a？**
非加密哈希，速度快（每字符一次 XOR + 一次 IMUL），分布均匀，适合做特征哈希。FNV-1a 比 FNV-1 更好因为它是先 XOR 再乘，避免了尾部字符影响弱的问题。

**② 为什么加符号？**
哈希碰撞时，两个不同 n-gram 可能落到同一维。如果都加 +1，它们会**互相强化**（虚假相似）；用最高位决定符号（+1/-1），碰撞时会**互相抵消**。这是 signed hashing（Weinberger et al. 的经典技巧）。

**③ 为什么权重除以 `sqrt(文档长度)`？**
长文本产生更多 n-gram，词频天然更高。除以长度相关的因子做归一化，让短文本（关键词块）和长文本（叙事块）的单个 n-gram 权重可比。

**④ 为什么用 3-gram 补充 2-gram？**
2-gram 提供的粒度接近 BM25，3-gram 更精细（"权杖七" vs "杖七的" vs "七的防"），提供互补信号。两种尺寸的权重用 `1/sqrt(2)` 平衡。

### Level 3：纯 BM25 兜底

`hybridSearch` 里：
```typescript
if (!vecHits || vecHits.length === 0) return ragSearch(query, topK);
```

### 向量通道的软超时

```typescript
const VECTOR_SOFT_TIMEOUT_MS = 8_000;
const vecWithTimeout = Promise.race([
  vectorSearch(query, topK * 2),
  new Promise<null>((resolve) => setTimeout(() => resolve(null), VECTOR_SOFT_TIMEOUT_MS)),
]).catch(() => null);
```

**为什么是 8 秒？**
- 哈希向量：312 块预计算一次（几毫秒），查询也是毫秒级
- ONNX 模型：312 块 × MiniLM CPU 推理，**首次约 3-8 秒**，之后走缓存
- 超过 8 秒 → 说明在下载模型或 CPU 太慢 → 放弃这一路

**这个软超时比模型加载超时更重要**：即使模型加载的 60 秒保护被绕过（不可能，但没有绝对保证），检索层还有一道 8 秒的闸。

## 2.7 第六步：RRF 融合

### 为什么不能直接加分数

| 通道 | 分数范围 | 分布特点 |
|---|---|---|
| BM25 | 0 ~ 无上界（实测 5~20） | 随查询长度、词频剧烈波动 |
| 余弦相似度 | 0 ~ 1 | 集中在 0.3~0.9 |
| 哈希向量余弦 | -1 ~ 1 | 分布分散 |

**强行归一化的问题**：BM25 的"最高分"和"次高分"可能差 3 倍，也可能几乎相等——这取决于查询本身。归一化系数无法在所有查询上通用。

### RRF 公式

```
RRF_score(d) = Σ_{i ∈ 各路}  1 / (k + rank_i(d))
```
`k = 60`（标准值，RRF 原论文的经验值）

### 实现

```typescript
const RRF_K = 60;

const fused = new Map<string, RagHit & { rrf: number; chans: Set<string> }>();

const addRank = (hits: RagHit[], channel: string) => {
  hits.forEach((h, idx) => {
    const rrf = 1 / (RRF_K + idx + 1);      // idx 从 0 开始，rank = idx+1
    const prev = fused.get(h.chunkId);
    if (prev) {
      prev.rrf += rrf;                       // 两路都命中 → 分数累加
      prev.chans.add(channel);
      if (h.snippet.length > prev.snippet.length) prev.snippet = h.snippet;
    } else {
      fused.set(h.chunkId, { ...h, rrf, chans: new Set([channel]) });
    }
  });
};
addRank(bm25Hits, "bm25");
addRank(vecHits, "vector");
```

### 数值实例

某文档在 BM25 排第 1、向量排第 5：
```
RRF = 1/(60+1) + 1/(60+5)
    = 0.016393 + 0.015385
    = 0.031778
```

某文档在 BM25 排第 1、向量排第 1：
```
RRF = 1/61 + 1/61 = 0.032787
```

某文档只在 BM25 排第 3：
```
RRF = 1/63 = 0.015873
```

**观察**：第 1+第 5（0.0318）> 只有 BM25 第 3（0.0159）。
→ **两路都认可（哪怕排名不高）的文档，排在单路高排名的文档前面**。这正是混合检索想要的：共识优先。

### 为什么 k=60 而不是 1？

k=1 时：
```
第 1 名: 1/(1+1) = 0.5
第 2 名: 1/(1+2) = 0.333
第 10 名: 1/(1+10) = 0.0909
```
差距 5.5 倍——**头部的微小波动会主导结果**（某一路把文档从第 2 挪到第 1，RRF 就涨了 50%）。

k=60 时：
```
第 1 名: 1/61 = 0.016393
第 2 名: 1/62 = 0.016129   (差 1.6%)
第 10 名: 1/70 = 0.014286  (差 12.8%)
```
排名相邻差距很小，**融合结果更平滑、更鲁棒**。k=60 是 RRF 原论文通过实验得出的经验值。

### 归一化输出

```typescript
const top = sorted[0].rrf;       // 基准：排名第一的 RRF 分
out.push({
  ...
  score: Math.round((h.rrf / top) * 100) / 100,   // 归一化到 0~1
  rawScore: Math.round(h.rrf * 10000) / 10000,   // 保留原始 RRF 分
  channels: [...h.chans],       // ["bm25"] | ["vector"] | ["bm25","vector"]
});
```

**为什么同时保留 `score`（归一化）和 `rawScore`（原始）？**
- 前端画分数条用归一化的（0~1 直观）
- 排查问题时用原始的（能看出真实差距）

**`channels` 字段的价值**：前端知识面板会显示命中来自哪个通道，面试时能直观证明"两路都在工作"。

## 2.8 第七步：注入 Prompt

```typescript
export function buildPromptContext(hits: RagHit[]): string {
  if (hits.length === 0) return "（知识库未检索到直接相关内容）";
  return hits
    .map((h, i) => `[${i + 1}] ${h.source}\n    ${h.snippet}`)
    .join("\n");
}
```

输出形如：
```
[1] tarot-lab · 太阳 · 正位牌意
    成功、欢乐、活力、热情、Radiance、乐观、丰收
[2] tarot-lab · 星币十 · 牌面叙事
    在星币十的画面上，一群人聚集在圆桌周围……
```

**编号 `[n]` 的作用**：
1. 撰写者据此在解读里写「典籍有云：…[1]」
2. 用户能在前端知识面板对照编号看到原文出处
3. **审校者据此检查引用是否忠实**（grounding 维度）

## 2.9 完整链路时序

```
Agent 决定调用 rag_search(query="权杖七 防守", top_k=5)
    │
    ▼
hybridSearch("权杖七 防守", 5)
    │
    ├─ Promise.all ─┬─ ragSearch(q, 10)          [同步, <1ms]
    │               │   └─ 2-gram 切词 → BM25 → 字段权重 → 去重 → top10
    │               │
    │               └─ vectorSearch(q, 10)        [异步, 最多 8s]
    │                   └─ hashEmbed(query) → 312 块余弦 → 去重 → top10
    │
    ▼
RRF 融合 (k=60) → 每牌去重 → top5 → 归一化
    │
    ▼
RagHit[] × 5
    │
    ├─→ yield { type: "rag_hits", ragHits }  → 前端知识面板（分数条 + 通道标记）
    │
    └─→ session.ragHits = hits                → 供 analyst / writer / reviewer 三个子 Agent 使用
            │
            ├─ analyst: 逐牌分析时引用 [n] 编号
            ├─ writer:  解读里写「典籍有云：…[n]」
            └─ reviewer: 检查 grounding（引用是否有依据）
```

**注意 `session.ragHits` 是累积的**：多次 rag_search 的结果都保留在会话里，后续子 Agent 看到的是全部检索依据。

## 2.10 RAG 模块的面试话术

> "RAG 这块我做了一层关键设计：**混合检索**。
>
> 稀疏通道是 BM25，Okapi 标准实现，k1=1.5 b=0.75，中文用 2-gram 滑窗切词避免引入分词器依赖。稠密通道是本地 embedding——首选 transformers.js 的 ONNX 量化模型，但**做了三级降级**：模型不可用时降级到自研的特征哈希 n-gram 向量（256 维 FNV-1a + 符号哈希抗碰撞），再不行就纯 BM25。
>
> 两路结果用 **RRF 融合**而不是分数相加——因为 BM25 分无上界、余弦最大 1，量纲不可比，强行归一化很脆弱。RRF 只用排名不用分数，天然规避这个问题，k=60 让头部波动不影响结果。
>
> 还有一个踩过的坑：同一张牌的 4 个字段 chunk 都含牌名，检索牌名时 5 条结果全是同一张牌。修法是**按 cardId 去重**——因为 top-k 的语义是'给用户 k 张相关牌'，不是'k 个片段'。
>
> 为了验证 RAG 是真跑而不是 mock，我在知识面板保留了 `channels` 标记（bm25 / vector / hybrid），每条命中都能回溯到 tarot-lab 原始数据的字段和出处链接。"

---

# 第 3 章：Agent 架构深度剖析

## 3.1 什么算 Agent

| | 普通 LLM 调用 | Agent |
|---|---|---|
| 交互轮次 | 一次 | 循环，直到任务完成 |
| 能做什么 | 只输出文字 | 输出"我想调 X 工具，参数 A" |
| 信息来源 | 只有 prompt | prompt + **工具返回值** |
| 结束条件 | 生成完就结束 | 由 LLM 决定何时停 |

**本质区别**：LLM 从"文本生成器"变成了"决策器"。程序读懂它的决策并执行，形成闭环。

## 3.2 function calling 协议

### 工具定义（我们发给 LLM 的说明书）

```typescript
{
  type: "function",
  function: {
    name: "rag_search",
    description: "混合检索塔罗典籍知识库（BM25+向量 RRF 融合，78 张韦特牌）。当需要了解某张牌的详细牌意、或按主题关键词查找相关牌时调用。返回带相关度分数与命中通道的知识片段。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索词，如牌名、主题关键词（如\"复合 感情\"）" },
        top_k: { type: "number", description: "返回条数，默认 5" },
      },
      required: ["query"],
    },
  },
}
```

**三个字段的作用**：
- `name`：函数标识，LLM 据此指定调用哪个
- `description`：**给 LLM 看的自然语言说明书**——这是 LLM 决定"要不要用这个工具"的主要依据，写得清楚与否直接决定工具调用准确率
- `parameters`：JSON Schema 描述参数结构，LLM 会严格按 schema 生成 arguments

### LLM 的响应

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [{
    "id": "call_abc123",
    "type": "function",
    "function": {
      "name": "rag_search",
      "arguments": "{\"query\": \"权杖七 牌意 解读\", \"top_k\": 3}"
    }
  }]
}
```

**注意 `arguments` 是 JSON 字符串**，不是对象——所以要 `JSON.parse`：
```typescript
let args: Record<string, unknown> = {};
try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* 忽略 */ }
```

### 完整往返（三步协议）

```
① assistant 消息: { role:"assistant", tool_calls:[{id, function:{name, arguments}}] }
   ↓ 程序执行工具
② tool 消息: { role:"tool", tool_call_id:"call_abc123", content:"工具返回的结果字符串" }
③ 把 ①② 的完整历史再发给 LLM → 它看到结果，继续决策
```

**`tool_call_id` 必须严格对应**，错一个字符 API 就报错。这是 Agent 循环最容易翻车的地方。

## 3.3 我们的 6 个工具

| 工具 | 类型 | 用途 | 特殊处理 |
|---|---|---|---|
| `rag_search` | 普通 | 混合检索典籍 | — |
| `draw_cards` | 普通 | 随机抽牌 | `spread: three \| single` |
| `offer_card_selection` | **HITL** | 请用户亲手选牌 | 下发 7 张候选扇面 + 记录犹豫时长 |
| `ask_user` | **HITL** | 澄清提问 | 下发问题 + 预设选项 |
| `fate_crossroads` | **HITL** | 命运岔路 | 下发引子 + 2~3 条走向 |
| `write_reading` | 特殊 | 启动子 Agent 管线 | 内部走 analyst→writer→reviewer |

### Supervisor 的 system prompt

```typescript
function buildSystemPrompt(session: AgentSession): string {
  return `${session.persona.stylePrompt}

你是这场占卜的 Supervisor（编排者），通过工具调用推进占卜流程。

【工作流程】
1. 问题模糊 → ask_user 澄清（全程最多 2 次，每次 1 个问题）
2. 选牌：优先 offer_card_selection 请用户亲手选牌（体验最佳）；用户没耐心/问题简单也可 draw_cards 随机
3. 对抽到的牌调用 rag_search 查阅典籍（可合并查询）
4. 若用户处境存在明显岔路 → fate_crossroads 让用户选走向
5. 信息足够 → write_reading 启动子 Agent 管线（分析师→撰写者→审校者，审校不过自动重写一次）

【纪律】
- ask_user 全程最多 2 次
- write_reading 只调用一次（重写由管线内部处理，不需要你再调）
- rag_search 按需调用，不必过度检索`;
}
```

**三个 prompt 设计技巧**：

**① 用"【工作流程】"编号步骤而不是散文描述**
LLM 对结构化指令的遵循度显著高于自然语言描述。

**② 明确写"【纪律】"约束调用次数**
不写的话 LLM 可能连续调 5 次 ask_user（用户体验灾难）。写进 prompt 是最直接的约束——比在代码里硬性拦截更灵活。

**③ 提前告诉 LLM 子 Agent 管线内部会处理重写**
否则 LLM 可能觉得"审校没过"就再调一次 `write_reading`，导致无限循环。

## 3.4 Supervisor 主循环

```typescript
const MAX_ROUNDS = 12;
let round = 0;

while (round < MAX_ROUNDS) {
  round++;
  let decision: CallResult;
  try {
    decision = await callLLM(config, session.messages, TOOLS, session.id, "supervisor");
    // failover 生效时更新会话粘住的 provider
    const used = buildProviders().find((p) => p.name === decision.provider);
    if (used && used.name !== config?.name) {
      config = used;
      session.__provider = used;
      yield { type: "phase", phase: "analyze", label: `主模型连接不畅，已切换备用模型（${used.name}）` };
    }
  } catch (e) {
    yield { type: "error", error: `占卜师暂时失联：...` };
    db.failSession(session.id);
    return;
  }

  if (decision.reasoning) yield { type: "reasoning", reasoning: decision.reasoning };
  session.messages.push(decision.message);        // ← 记忆核心

  const toolCalls = decision.message.tool_calls;
  if (!toolCalls || toolCalls.length === 0) {
    // LLM 不再要调工具 → 结束
    const text = decision.message.content;
    if (text) {
      for (const chunk of text.match(/[\s\S]{1,6}/g) ?? []) {
        yield { type: "delta", delta: chunk };      // 追问模式的正常路径
      }
    }
    yield { type: "done" };
    session.finished = true;
    return;
  }

  for (const tc of toolCalls) {
    // 逐个执行工具
  }
}
```

### 关键点 ①：步数上限

`MAX_ROUNDS = 12` 不是随便定的。实测一次完整占卜的轮次分布：
```
Round 1: ask_user           (澄清)
Round 2: offer_card_selection (选牌)
Round 3: rag_search × 3     (并行检索)
Round 4: fate_crossroads    (岔路)
Round 5: write_reading      (启动管线)
```
约 5 轮。12 轮留了 2 倍余量，同时能防死循环。

**任何生产 Agent 系统都必须有步数上限**——每个 round 至少一次 LLM 调用（每次真金白银）。

### 关键点 ②：`session.messages.push(decision.message)`

这是**记忆的核心机制**。LLM 是无状态的（stateless），它不记得上一次调用。

**对话历史结构**：
```typescript
session.messages = [
  { role: "system", content: "你是占卜师...【工作流程】..." },
  { role: "user", content: "我想占卜：我在两个工作机会之间纠结" },
  { role: "assistant", content: null, tool_calls: [{ id:"c1", function:{name:"ask_user", arguments:"..."} }] },
  { role: "tool", tool_call_id: "c1", content: '{"answer":"一个稳定安逸，一个更有挑战"}' },
  { role: "assistant", content: null, tool_calls: [{ id:"c2", function:{name:"offer_card_selection", arguments:"{\"count\":3}"} }] },
  { role: "tool", tool_call_id: "c2", content: '{"answer":"Sun,Pents02,Strength|1800,900,3200"}' },
  ...
];
```

**代价**：每轮都要重发全部历史 → token 消耗随轮次平方增长。这就是为什么：
- 要限制 MAX_ROUNDS
- 要限制 analyst 输出长度（≤400 字）
- 要用 `max_tokens` 控制输出

### 关键点 ③：LLM 说"不调工具"就结束

```typescript
if (!toolCalls || toolCalls.length === 0) {
  // 追问模式的正常路径：直接输出文字
}
```

**但这里有个坑我们踩过**：glm-5.3 在某些情况下会返回 `content: null` + `tool_calls: []`（推理 token 全花在 reasoning 上，正文和工具都空）。这时会走"直接结束"分支，解读变成空的。

**我们的处理**：在 writer 那里限制 `max_tokens: 6000`（最初设 1400 被 reasoning 吃光，导致解读 0 字）。

## 3.5 子 Agent 管线（多 Agent 架构）

### 为什么拆三个

**一个 LLM 同时做分析+写作+自检的问题**：
- 写的时候不想着"引用准不准"——创作模式压过了严谨模式
- 写完再自检，已经陷在自己的措辞里，看不出问题
- 而且一次输出几千 token，任何一处"跑偏"都要重跑全部

**拆开之后**：
```
Supervisor ──调用 write_reading──┐
                                 ▼
        ① analyst  → ② writer  → ③ reviewer
        （只分析）    （只写作）   （只审校）
                         ▲            │
                         └─ 返工 ────┘
                            (revision 指令)
```

### ① analyst（牌意分析师）

```typescript
const messages: SessionMessage[] = [
  {
    role: "system",
    content: `你是塔罗牌意分析师（analyst），职责是产出**精简**的结构化分析笔记供撰写者使用，不面向用户，不需要文采。
⚠️ 严格控制篇幅：每张牌 3 行以内，全文不超过 400 字。简洁信息密度高，勿展开长篇论述。

输出格式（每张牌一段）：
【位置 · 牌名（正/逆位）】
- 典籍：<引用牌面知识/RAG 原文，标注 [n] 编号>
- 位置动力学：<1 句>
- 与问题的关联：<1 句>

最后一行【整体叙事】：三张牌连成的一句话故事（1 句）。`,
  },
  {
    role: "user",
    content: `用户问题：${session.question}
用户已澄清的信息：见上文对话
牌面知识：\n${cardKnowledge}
RAG 检索结果：\n${ragContext}
请逐牌分析（务必精简）。`,
  },
];
```

**关键设计**：

**① 输出格式是"结构化数据"，不是散文**
```
【过去 · 权杖七（正位）】
- 典籍：防守与挑战 [1]
- 位置动力学：过去你曾努力守住阵地
- 与问题的关联：你太习惯防守，机会来了也不敢伸手
```
便于 writer 快速提取关键信息。

**② "≤400 字"是踩坑得来的**
最初没限制，analyst 写了 **1 万+ token**，单次调用 **84 秒**。加上限制后降到 ~400 字 / 47 秒。

**③ "不面向用户，不需要文采"**
明确角色的输出受众是"另一个 AI"，不是人。避免它写得像给人看的文章（浪费 token）。

**④ 禁用了 thinking**
```typescript
...(agent === "supervisor" ? {} : { thinking: { type: "disabled" } }),
```
分析/审校是**结构化输出任务**，不需要推理链。关掉后更快、更省 token。只有 supervisor 决策保留思考（选工具本身就是推理）。

### ② writer（撰写者）

```typescript
content: `${session.persona.stylePrompt}

你是占卜解读的撰写者（writer），基于分析师的结构化笔记撰写面向用户的最终解读。
要求：
1. 引用典籍牌意时用「典籍有云：…」标注，并标注 [n] 编号对应检索结果
2. 逐牌解读（过去/当下/未来 或 单张核心指引），再给综合启示与可执行建议
3. 结合用户问题与澄清回答，针对性展开
4. **篇幅 350~450 字**，分段清晰，直接输出正文不加任何前言
5. 不要复述分析师笔记的格式，要写成流畅的占卜文本`,
```

**第 5 条是精髓**："不要复述笔记格式"——子 Agent 之间有**格式转换责任**，不是简单搬运。writer 要把"结构化笔记"转成"流畅散文"。

**流式输出**：
```typescript
let full = "";
for await (const chunk of streamLLM(config, messages, session.id, "writer")) {
  full += chunk;
  yield { type: "delta", delta: chunk };   // 逐字推给用户
}
```
这是**唯一**会推 `delta` 的地方——用户看到的所有解读文字都来自 writer。

### ③ reviewer（审校者）

```typescript
content: `你是占卜解读的审校者（reviewer）。从三个维度为解读打分（0~10 整数）：
- grounding 典籍忠实：解读引用的牌意是否**有据可依**——合法来源包括①下方"牌面知识"（用户抽到的牌，牌意原文可信）②下方"RAG 检索结果"。仅当引用了**既不在牌面知识、也不在检索结果**的牌意才算编造。
- empathy 共情：是否回应用户的具体问题与澄清回答，有无针对性
- tone 语气：是否符合占卜师人格（${session.persona.name}），文风是否统一

【重要】不要苛求每张抽到的牌都必须出现在 RAG 检索里——牌面知识本身就是典籍原文。
只有在解读**编造了牌面知识与检索结果中都不存在的牌意**时才给 grounding 低分。

严格 JSON 输出（不要 markdown 代码块）：
{"pass": <grounding>=7 且 empathy>=6 且 tone>=6>, "scores": {"grounding": n, "empathy": n, "tone": n}, "comment": "一句话总评", "revision": "<若不通过，给撰写者的具体修改指令；通过则为空字符串>"}`,
```

**严格 JSON 输出的处理**：
```typescript
try {
  const m = res.message.content.match(/\{[\s\S]*\}/);   // 正则抠出 JSON 部分
  parsed = m ? JSON.parse(m[0]) : { pass: true, scores: {...8}, comment: "审校解析失败，默认通过" };
} catch {
  parsed = { pass: true, scores: {...8}, comment: "审校解析失败，默认通过" };
}
```
用正则抠 JSON 是为了应对 LLM 加了 markdown 代码块或前后说明文字。**解析失败时默认通过**——审校是质量增强，不该成为阻断点。

### Reflexion 闭环

```typescript
// ③ 审校
let review = null;
let revision = "";
try {
  yield { type: "phase", phase: "review", label: "审校者正在检视解读…" };
  for await (const evt of runReviewer(config, session, reading)) {
    if (evt.type === "review") review = evt.review ?? null;
    yield evt;
  }
  revision = session.__revision ?? "";
} catch { /* 审校失败不阻断 */ }

// Reflexion：不过 → 重写 → 复检
if (review && !review.pass && revision) {
  yield { type: "phase", phase: "interpret", label: "审校未通过 · 撰写者依据修改指令重写…" };
  db.updateSessionReading(session.id, reading);       // 先存初稿
  reading = "";
  for await (const evt of runWriter(config, session, focus, revision)) {
    if (evt.type === "delta") reading += evt.delta;
    yield evt;
  }
  // 重写后再审校一次（判断新版是否达标，而非沿用旧结论）
  yield { type: "phase", phase: "review", label: "审校者复检重写稿…" };
  let reReview = null;
  try {
    for await (const evt of runReviewer(config, session, reading)) {
      if (evt.type === "review") reReview = evt.review ?? null;
      yield evt;
    }
  } catch { /* 复检失败沿用原 review */ }
  if (reReview) review = reReview;
}
```

**重写时 writer 收到的额外指令**：
```typescript
${revision ? `\n⚠️ 审校意见（上一版被退回，必须针对性修改）：\n${revision}\n请重写全文。` : ""}
```

### Reflexion 的两个真实坑（面试高价值素材）

**坑 1：审校标准设计错误导致无意义重写**

**现象**：审校给了 `grounding=3`，触发重写（+103 秒），但重写后问题依旧。

**审校意见原文**（很有代表性）：
> "共情与语气近乎满分，但解读严重脱离检索依据：月亮与星星根本不在 RAG 结果中，其'典籍有云'引文以及女祭司逆位牌意均属编造，必须基于检索到的牌重写。"

**审校者的逻辑**：它只看到了"RAG 检索结果"，没意识到"**用户亲手选中的牌，其牌库原文也是合法依据**"。

**根因**：审校 prompt 没定义"合法引用来源"的范围。

**修复**：在审校 prompt 里明确写出两个合法来源（牌面知识 + RAG 检索），并加粗强调"不要苛求每张抽到的牌都必须出现在 RAG 检索里"。

**效果**：grounding 从 3 → 9，省掉 103 秒的重写。

> **反思**：这说明 **AI 的评判标准本身需要设计**。如果评判标准有偏差，Reflexion 会陷入"误判 → 重写 → 还是误判 → 无限重写"的死循环，而且每次都烧真金白银。

**坑 2：复检是假的**

**现象**：重写后前端显示的审校分数和重写前一样。

**根因**：代码只重发了旧 review 事件 + `rewritten: true` 标记，**根本没重跑 reviewer**。

**修复**：重写后真正再跑一次 `runReviewer`。

> **反思**："看起来做了"和"真的做了"要能区分。复检 ≠ 重发事件。

### 效果数据

| 指标 | 修复前 | 修复后 |
|---|---|---|
| grounding 分数 | 3 | **9** |
| 是否触发重写 | 是（+103s） | 否 |
| 单次占卜总耗时 | ~5min（曾超时） | 正常完成 |

## 3.6 HITL：人机协同

### 问题

SSE 是单向的（服务器→浏览器）。用户怎么把答案送回去？

### 解法：挂起的 Promise + 独立端点

**服务端**（`tarot-agent.ts`）：
```typescript
// ① 先把问题推给用户
yield { type: "ask_user", ask: { question, options, allowFree, prompt } };

// ② 挂起，等一个 Promise
const userAnswer = await new Promise<string>((resolve) => {
  session.pendingAsk = { resolve, question: askPrompt, options };
});
```

**独立端点**（`/api/answer`）：
```typescript
const session = getSession(sessionId);
if (!session) return Response.json({ error: "会话已过期" }, { status: 410 });
const ok = resolvePendingAsk(sessionId, answer.trim());
if (!ok) return Response.json({ error: "当前没有等待回答的问题" }, { status: 409 });
return Response.json({ ok: true });
```

**resolvePendingAsk**：
```typescript
export function resolvePendingAsk(sessionId: string, answer: string): boolean {
  const s = sessions.get(sessionId);
  if (!s?.pendingAsk) return false;
  s.pendingAsk.resolve(answer);     // ← 唤醒上面那个 await
  s.pendingAsk = undefined;
  return true;
}
```

### 时序图

```
浏览器                              服务端
  │                                   │
  ├── POST /api/interpret ──────────►│  Agent 开始跑
  │                                   │  session 存入 globalThis.sessions
  │◄─── SSE: session (sid) ───────────┤
  │◄─── SSE: phase analyze ───────────┤
  │◄─── SSE: tool ask_user ───────────┤
  │◄─── SSE: ask_user {question} ─────┤
  │                                   │  await new Promise(resolve)  ← 挂起
  │   ┌───────────────┐               │
  │   │ 用户看到问题卡片 │               │  (服务端此刻空闲，SSE 连接保持)
  │   │ 点击选项/输入   │               │
  │   └───────────────┘               │
  ├── POST /api/answer {sid, answer} ─►│  resolvePendingAsk → resolve(answer)
  │                                   │  await 恢复，继续跑
  │◄─── SSE: tool (结果摘要) ──────────┤
  │◄─── SSE: cards ───────────────────┤
  │◄─── SSE: delta × N ───────────────┤  解读逐字流出
  │◄─── SSE: done ────────────────────┤
```

### 为什么这个设计好

| 特性 | 说明 |
|---|---|
| **流不中断** | 浏览器只有一个 fetch，从头到尾同一个响应 |
| **无需 WebSocket** | 复用 HTTP 端点，部署简单，代理友好 |
| **无需轮询** | 服务端主动等，答完即恢复（延迟为 0） |
| **严格同步** | 用户的回答发生在 Agent 需要的那个精确时刻 |
| **可多轮** | 一个占卜可以有多次 ask_user / 选牌 / 岔路 |

### 三个 HITL 工具的差异

**① `ask_user`（澄清提问）**
```typescript
askEvent = { type: "ask_user", ask: { question: q, options, allowFree: true, prompt: q } };
```
- 允许自由输入
- 前端渲染成选项按钮 + 输入框

**② `offer_card_selection`（亲手选牌）**
```typescript
const pool = [...TAROT_CARDS];
const fanCards = Array.from({ length: 7 }, () => {
  const idx = Math.floor(Math.random() * pool.length);
  const card = pool.splice(idx, 1)[0];
  return { id: card.id, nameZh: card.nameZh, image: card.image };
});
askEvent = {
  type: "ask_user",
  ask: { question: `请凭直觉，从 ${count} 张牌中选出属于你的 ${count} 张命运之牌`, allowFree: false, prompt },
  fanCards,          // ← 候选牌数据
  fanCount: count,   // ← 应选张数
};
(askEvent as any).cardSelection = true;   // ← 标记：前端渲染扇面
```

**这是我们踩坑修复的地方**（见 3.8 节）：事件最初没带 `fanCards`，前端拿不到数据 → 扇面不渲染 → 用户看不到任何 UI → 服务端永远等不到应答 → 白屏。

应答格式：`"牌id,牌id,牌id|犹豫ms,犹豫ms,犹豫ms"`
```typescript
const [idsStr, dwellStr] = userAnswer.split("|");
const ids = idsStr.split(",").map((s) => s.trim()).filter(Boolean);
const dwell = (dwellStr ?? "").split(",").map((s) => parseInt(s, 10) || 0);
```

**③ `fate_crossroads`（命运岔路）**
```typescript
askEvent = { type: "ask_user", ask: { question: prompt, options: branches, allowFree: false, prompt } };
(askEvent as any).crossroads = true;   // ← 前端用琥珀色主题区分
```
只给选项不允许自由输入（这是"选择"，不是"提问"）。

### 犹豫时长：把人类行为当信号

**前端**（`CardFan.tsx`）：
```typescript
const hoverStart = useRef<Record<string, number>>({});

onMouseEnter={() => { hoverStart.current[card.id] = Date.now(); }}
onMouseLeave={() => {
  const s = hoverStart.current[card.id];
  if (s) setDwell((d) => ({ ...d, [card.id]: (d[card.id] ?? 0) + (Date.now() - s) }));
}}
```

**后端**（把 dwell 放进工具结果）：
```typescript
resultSummary = `用户亲手选出：过去=太阳(正位)、当下=星币二(逆位)、未来=力量；犹豫时长 1800/900/3200ms`;
```

**它真的影响了解读**——实测输出：
> "**你在这张牌前停留最久**——魂灵其实已认出答案。它不教你硬碰硬，而教你以温柔之手抚住狮颚，被驯服的，正是对未知的恐惧。"

AI 知道用户在"力量"牌上停留最久（3200ms），所以专门就这张牌展开。

> **面试话术**："HITL 不只是'问用户问题等回答'。更高级的做法是把**人类行为本身**当输入信号——选择顺序、停留时长、犹豫。这些 implicit feedback 往往比用户主动打的字更能反映真实心理状态。这在推荐系统里是成熟方法。"

### 踩坑：会话在 dev 模式分裂

**现象**：`/api/answer` 返回 410 "会话已过期"，但会话明明刚创建。

**根因**：Next.js dev 模式（Turbopack）把不同路由编译到**不同 worker 进程**，每个 worker 有独立的模块实例：
```
/api/interpret worker:  module A → sessions Map A  ← 会话存在这里
/api/answer    worker:  module B → sessions Map B  ← 这里找不到
```

**修复**：挂到 `globalThis`。
```typescript
const sessions: Map<string, AgentSession> = (() => {
  const g = globalThis as unknown as { __tarotSessions__?: Map<string, AgentSession> };
  if (!g.__tarotSessions__) g.__tarotSessions__ = new Map();
  return g.__tarotSessions__;
})();
```

> **面试话术**："`globalThis` 在 Node 进程内唯一。用它做单例存储，既解决 dev 多 worker 的模块分裂，也避免模块重复 import 时初始化多次。生产 build 没这个问题，但统一写法让 dev/prod 行为一致。"

## 3.7 会话与多轮

```typescript
interface AgentSession {
  id: string;                    // sess_xxx
  createdAt: number;
  lastActive: number;            // TTL 判断
  messages: SessionMessage[];    // LLM 记忆
  question: string;
  persona: Persona;              // 占卜师人格
  drawnCards: DrawnCard[];
  ragHits: RagHit[];             // 累积的检索依据
  analystNotes: string;
  pendingAsk?: { resolve, question, options };
  finished: boolean;
  toolSeq: number;
}
```

**TTL 30 分钟**：
```typescript
function cleanExpired() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActive > SESSION_TTL) sessions.delete(id);
  }
}
```

**多轮追问**：
```typescript
// 前端
body: JSON.stringify({ sessionId, followup: f })

// 后端
session = getSession(body.sessionId);
followup = body.followup.trim();
question = session.question;     // 复用原始问题

// 在 runAgent 里
session.messages.push({ role: "user", content: `（追问）${opts.followup}` });
session.messages.push({
  role: "system",
  content: "用户在追问。请基于已有牌面与上下文直接回答（可以正常说话，不必调用工具），300 字以内。",
});
```

**追问时禁止调工具**——不重新抽牌，只基于已有上下文回答。

**实测效果**（追问"那我应该具体怎么开启这次对话?给我一些话术建议"）：
> "✦ 牌面早已给出指引，我为你提炼成三句可直接开口的话——
> **◈ 开场话术（宝剑八的钥匙）** 戒指责，用「我」起句。可这样说：*「最近我感觉我们之间变得安静了，我有点想念以前的我们。你心里最近在想什么？我真的很想听。」*"

AI 准确复用了之前的牌面（女祭司/宝剑八/皇帝）和用户的澄清回答，给出了**具体可用的话术**——说明会话记忆真的在起作用。

## 3.8 踩坑清单（Agent 模块）

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 点选项无反应，白屏 | `offer_card_selection` 事件没带 `fanCards` | 事件携带候选牌 + 前端兜底 UI |
| 2 | Agent 在 rag_search 卡死 7min | transformers.js fetch 无超时 | 三级超时保护 |
| 3 | 重写后审校分数不变 | 只重发旧事件没复检 | 真正重跑 reviewer |
| 4 | grounding 误判 3 分触发无意义重写 | 审校标准没定义合法引用源 | 明确牌面知识也合法 |
| 5 | 解读输出为空 | `max_tokens: 1400` 被 reasoning 吃光 | 放宽到 6000 |
| 6 | 单次占卜 5 分钟 | analyst 输出 1 万 token | 限制 ≤400 字 + 关 thinking |
| 7 | `/api/answer` 410 | dev 多 worker 模块分裂 | globalThis 单例 |

## 3.9 Agent 模块的面试话术

> "Agent 这块的核心是 **Supervisor 模式**：编排者只做决策，执行者职责单一。
>
> 我手写了 function calling 循环而没用 LangChain——一是想展示对底层机制的理解，二是手写能精确控制 HITL 挂起（SSE 流不中断），三是零依赖。
>
> **多 Agent 拆分**的判断依据是'角色冲突'：一个 LLM 同时做分析、写作、自检时，创作模式会压过严谨模式，审校时已经陷在自己的措辞里。拆成 analyst/writer/reviewer 后，每个子 Agent 只做一件事。而且子 Agent 间传的是**精炼中间产物**（≤400 字结构化笔记），不是共享全部上下文——这是性能关键，我最初没限制，analyst 写 1 万 token，单次 84 秒。
>
> **Reflexion 闭环**我踩了两个坑，都很有代表性：① 审校标准设计错误——它把'用户选的牌不在 RAG 结果里'判为编造，触发无意义重写。根因是审校 prompt 没定义合法引用来源，修复后 grounding 从 3 分升到 9 分。**这说明 AI 的评判标准本身需要设计**，标准有偏就会陷入误判循环。② 复检是假的——代码只重发旧 review 事件没真重跑。'看起来做了'和'真的做了'要能区分。
>
> **HITL** 的实现是：Agent 在需要人类输入时 `await` 一个 Promise，把 resolve 存会话；人类通过另一个 HTTP 端点调 resolve，SSE 流全程不断。相比 WebSocket 方案，它复用无状态 HTTP 基础设施，部署不需要额外网关支持。"

---

# 第 4 章：自定义光标深度剖析

## 4.1 目标与约束

**目标**：淡紫白发光灵球 + 星尘拖尾，神秘感 + 科技感，呼应星空主题。

**约束**（这些决定了实现方式）：
- 不能影响正常交互（点击、选中、滚动）
- 触屏设备完全不用（没有鼠标）
- 尊重 `prefers-reduced-motion`（前庭障碍用户）
- 性能不能拖垮主线程（尤其是有 canvas 粒子 + 大量动画的页面）
- 悬停在可交互元素上要有反馈

## 4.2 三层实现结构

```
┌─────────────────────────────────────────────┐
│  Layer 3: canvas 星尘粒子拖尾   (z-9998)     │  ← 大量粒子，pointer-events-none
├─────────────────────────────────────────────┤
│  Layer 2: DOM 发光灵球         (z-9999)     │  ← 单个 div，mix-blend-mode: screen
├─────────────────────────────────────────────┤
│  Layer 1: 页面内容                           │  ← 默认 z-10
└─────────────────────────────────────────────┘
```

**z-index 层级**：`z-9998`（canvas）/ `z-9999`（灵球）必须高于所有内容，但**不能是 `position: fixed` 的遮挡层**——两个层都是 `pointer-events-none`，不拦截点击。

## 4.3 Layer 1：隐藏默认光标

```css
@media (pointer: fine) {
  html.has-stardust-cursor,
  html.has-stardust-cursor * {
    cursor: none !important;
  }
}
```

**三个细节**：

**① 为什么用 `html.has-stardust-cursor` 类名而不是直接 `* { cursor: none }`？**
因为只有**光标组件成功挂载**（触屏/减动效用户除外）才隐藏默认光标。否则触屏用户会看不到任何光标指示。

```typescript
useEffect(() => {
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (coarse || reduced) return;         // 不启用
  setEnabled(true);
  document.documentElement.classList.add("has-stardust-cursor");
  return () => document.documentElement.classList.remove("has-stardust-cursor");
}, []);
```

**② 为什么用 `@media (pointer: fine)`？**
精确匹配有精确指针（鼠标）设备。触屏和 stylus 走别的分支。

**③ 为什么 `!important`？**
因为要覆盖所有子元素可能自带的 `cursor` 样式（比如某些库设置了 `cursor: text`）。

## 4.4 Layer 2：DOM 发光灵球

```typescript
<div
  ref={dotRef}
  className="fixed top-0 left-0 z-[9999] pointer-events-none w-3.5 h-3.5 rounded-full"
  style={{
    background: "radial-gradient(circle, rgba(255,255,255,0.98) 0%, rgba(233,213,255,0.9) 28%, rgba(196,148,255,0.45) 55%, rgba(147,86,250,0.12) 78%, transparent 100%)",
    boxShadow: "0 0 10px 2px rgba(216,180,254,0.65), 0 0 26px 6px rgba(168,85,247,0.30), 0 0 52px 14px rgba(126,58,242,0.16)",
    mixBlendMode: "screen",
  }}
/>
```

### 视觉设计拆解

**`radial-gradient` 的 5 个色标**：
```
0%    rgba(255,255,255,0.98)   ← 纯白核心（高光点）
28%   rgba(233,213,255,0.9)    ← 淡紫白
55%   rgba(196,148,255,0.45)   ← 紫
78%   rgba(147,86,250,0.12)    ← 淡紫边缘
100%  transparent              ← 完全透明，融入背景
```
**这构成了一个"球体"感**：中心亮、边缘渐隐，像被点亮的玻璃珠。

**`boxShadow` 的 3 层光晕**：
```
0 0 10px  2px  rgba(216,180,254,0.65)   ← 近距强光（清晰边缘）
0 0 26px  6px  rgba(168,85,247,0.30)    ← 中距柔光
0 0 52px 14px  rgba(126,58,242,0.16)    ← 远距氛围光
```
半径和模糊同步增大、透明度递减 → 模拟真实光晕的**平方反比衰减**。

**`mixBlendMode: screen`（滤色）**：
- 效果：两个图层叠加时，亮的地方更亮，暗的地方保留底色
- 好处：光球经过深色背景时**自然发光**，经过亮色区域时**不会变成一坨死白**
- 对比 `normal`（普通叠加）：光球经过任何地方都是不透明的，破坏页面

### rAF 插值跟随（丝滑的关键）

```typescript
const loop = (now: number) => {
  // 插值：灵球位置向鼠标位置逼近
  dx += (mx - dx) * 0.22;
  dy += (my - dy) * 0.22;
  const scale = hovering ? 1.7 : 1;
  dot.style.transform = `translate(${dx}px, ${dy}px) translate(-50%, -50%) scale(${scale})`;
  requestAnimationFrame(loop);
};
```

**为什么不是直接 `translate(mx, my)`？**
直接赋值 = 光球死板地贴在鼠标上，没有"生命感"。

**指数插值（exponential smoothing）**：
```
新位置 = 当前位置 + (目标位置 - 当前位置) × 0.22
```
每帧走完剩余距离的 22%——**与帧率无关**，60fps 和 144fps 表现一致。0.22 是速度与跟手感的平衡点（0.1 太黏，0.5 太飘）。

**为什么用 `transform` 而不是 `left/top`？**
`transform` 走**合成层**（GPU），不触发重排（reflow）和重绘（repaint）。`left/top` 每帧都要重新计算布局，60fps 下会让主线程吃紧。

**为什么用 `translate` 而不是 `left: 0; top: 0` 固定？**
`fixed top-0 left-0` + `transform: translate(x, y)` 是**最高效的定位方式**：元素保持在合成层，位置变化只改 transform。

### 悬停反馈

```typescript
const onOver = (e: MouseEvent) => {
  const t = e.target as HTMLElement;
  hovering = !!t.closest("button, a, input, textarea, [data-cursor-hover]");
};
```
```typescript
const scale = hovering ? 1.7 : 1;
```

**用 `closest()` 而非 `matches()`**：
`matches` 只看元素自己；`closest` 向上冒泡找祖先。我们需要"光标在按钮**内部**任何位置"都触发，所以要查祖先。

**选择器覆盖**：button / a / input / textarea + 自定义 `[data-cursor-hover]`（给非标准元素加反馈的钩子）。

**为什么用 `mouseover` 而不是 `mouseenter`？**
`mouseenter` 不冒泡，只能绑在单个元素上；`mouseover` 冒泡，可以全局监听一个 `window` 事件。

**注意 `mouseover` 会频繁触发**（每次移动到子元素都触发）——所以回调里只做一次 `closest` 判断，很轻量。

## 4.5 Layer 3：canvas 星尘拖尾

### 粒子生成

```typescript
const onMove = (e: MouseEvent) => {
  const prevX = mx, prevY = my;
  mx = e.clientX; my = e.clientY;
  if (prevX < 0) { dx = mx; dy = my; }   // 首次移动，同步位置

  // 按移动速度决定生成数量
  const dist = Math.hypot(mx - prevX, my - prevY);
  const count = Math.min(Math.floor(dist / 6) + 1, 5);
  for (let i = 0; i < count; i++) {
    const t = i / count;
    particles.push({
      x: prevX + (mx - prevX) * t + (Math.random() - 0.5) * 6,
      y: prevY + (my - prevY) * t + (Math.random() - 0.5) * 6,
      vx: (Math.random() - 0.5) * 0.6,
      vy: (Math.random() - 0.5) * 0.6 + 0.15,        // 轻微下坠
      life: 0,
      maxLife: 40 + Math.random() * 35,               // 寿命 40~75 帧
      size: 1 + Math.random() * 1.8,
      hue: 260 + Math.random() * 40,                  // 260~300 紫-品红
    });
  }
  if (particles.length > 260) particles.splice(0, particles.length - 260);
};
```

**五个设计点**：

**① 数量与速度成正比**
静止时只有 1 颗（几乎不生成），快速划动时最多 5 颗/事件。**拖尾长度自然跟随移动速度**——不动就没有拖尾，快划才有星尘尾迹。

**② 沿路径分布而非全在终点**
```typescript
const t = i / count;
x: prevX + (mx - prevX) * t
```
如果所有粒子都生成在鼠标当前位置，拖尾会是"一团"；沿路径均匀分布才是"一条线"。

**③ 位置抖动**
```typescript
+ (Math.random() - 0.5) * 6
```
±3px 随机偏移，避免粒子排成一条僵硬的直线。

**④ 轻微重力**
```typescript
vy: ... + 0.15      // 初始向下偏置
vy = vy * 0.985 + 0.008   // 每帧衰减 + 微小加速度
```
粒子会**缓缓下沉**，像尘埃飘落，比直线运动自然。

**⑤ 数量上限 260**
```typescript
if (particles.length > 260) particles.splice(0, particles.length - 260);
```
防止长时间使用后数组无限增长（内存泄漏 + 渲染变慢）。超出时从头部删除最老的。

### 粒子渲染

```typescript
const loop = (now: number) => {
  const dt = Math.min(now - last, 50);   // 帧间隔，上限 50ms（防后台标签页恢复时跳变）
  last = now;

  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life += dt / 16.7;                 // life 按 60fps 帧当量计
    if (p.life >= p.maxLife) { particles.splice(i, 1); continue; }

    p.x += p.vx; p.y += p.vy;
    p.vx *= 0.985; p.vy = p.vy * 0.985 + 0.008;    // 阻尼 + 重力

    const k = 1 - p.life / p.maxLife;    // 剩余生命比例 1→0
    const alpha = k * 0.85;              // 透明度随之衰减
    const size = p.size * (0.4 + k * 0.6); // 尺寸随之缩小

    ctx.beginPath();
    ctx.shadowBlur = 8;
    ctx.shadowColor = `hsla(${p.hue}, 90%, 80%, ${alpha})`;
    ctx.fillStyle = `hsla(${p.hue}, 95%, 88%, ${alpha})`;
    ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;                   // ← 必须重置！否则后续粒子阴影叠加
  }
  requestAnimationFrame(loop);
};
```

**关键实现细节**：

**① `dt` 归一化**
```typescript
p.life += dt / 16.7;    // 除以 16.7ms（60fps 一帧）
```
如果直接 `p.life++`，那么在 144Hz 屏幕上前 40 帧就死完了（0.28 秒），在 30Hz 屏幕上又拖很久。**除以 16.7 让寿命以"60fps 帧当量"计，跨设备一致**。

**② `Math.min(now - last, 50)`**
标签页切回前台时，`now - last` 可能是几秒（几万个 ms）。不封顶的话所有粒子会瞬间全部死亡（life 暴涨）或瞬间全部老化。上限 50ms 让它平滑恢复。

**③ `shadowBlur = 0` 重置**
canvas 的 shadow 状态是**持久**的。如果不重置，后续每个粒子的 shadowBlur 会继承上一个的值，导致发光越来越强（累积）。这是个很容易忽略的 bug。

**④ HSL 色彩空间**
```typescript
hue: 260 + Math.random() * 40    // 260~300
```
- 260° = 紫罗兰
- 280° = 紫
- 300° = 品红
都是神秘学主题色。`hsla` + 随机 hue 让每颗星尘颜色有细微差异，比固定色更有生命感。

**⑤ `screen` 混合模式的替代方案**
canvas 本身没设 `mix-blend-mode`，但**整个 canvas 元素**可以设：
```typescript
className="fixed inset-0 z-[9998] pointer-events-none"
```
我们用 `shadowBlur` 做发光（canvas 内部的模糊阴影），效果与 DOM 灵球的 `boxShadow` 一致。

### HiDPI 适配

```typescript
const resize = () => {
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
};
```

**四个步骤缺一不可**：
1. `canvas.width = css宽 × dpr` → 物理像素尺寸
2. `canvas.style.width = css宽 px` → CSS 显示尺寸不变
3. `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` → **后续所有绘制坐标都用 CSS 像素**

**如果漏掉第 3 步**：粒子会画在错误的位置（偏移 dpr 倍），且在高 DPI 屏上模糊。
**如果漏掉第 1/2 步**：在 Retina 屏上粒子会模糊一半。

**为什么用 `setTransform` 而不是每次绘制时乘 dpr？**
一次变换，后续所有 `arc(x, y, ...)` 自动按 CSS 像素工作，代码保持简洁。

## 4.6 性能与清理

```typescript
useEffect(() => {
  ...
  const resize = () => { ... };
  resize();
  window.addEventListener("resize", resize);

  const onMove = (e: MouseEvent) => { ... };
  const onOver = (e: MouseEvent) => { ... };

  const loop = (now: number) => { ...; raf = requestAnimationFrame(loop); };
  raf = requestAnimationFrame(loop);

  window.addEventListener("mousemove", onMove, { passive: true });
  window.addEventListener("mouseover", onOver, { passive: true });

  return () => {
    cancelAnimationFrame(raf);                    // 取消动画帧
    window.removeEventListener("resize", resize);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseover", onOver);
  };
}, [enabled]);
```

**四个要点**：

**① `{ passive: true }`**
告诉浏览器这个监听器不会调用 `preventDefault()`，可以**立即滚动而不等监听器执行**。对 `mousemove` 这种高频事件，passive 能显著减少主线程阻塞（尤其在触摸板滚动时）。

**② `cancelAnimationFrame(raf)`**
组件卸载时必须取消，否则 rAF 循环会一直跑（内存泄漏 + 幽灵渲染）。

**③ 监听器全部清理**
React 严格模式（开发环境）会**故意双调用** effect 来暴露副作用问题。不清理会注册两遍监听器，粒子数翻倍、CPU 占用翻倍。

**④ 事件监听挂在 `window` 而非元素**
因为光标是全局的，任何位置的鼠标移动都要响应。

## 4.7 完整代码结构

```typescript
export default function StardustCursor() {
  const dotRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [enabled, setEnabled] = useState(false);

  // Effect 1: 能力检测 + 类名管理
  useEffect(() => {
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (coarse || reduced) return;
    setEnabled(true);
    document.documentElement.classList.add("has-stardust-cursor");
    return () => document.documentElement.classList.remove("has-stardust-cursor");
  }, []);

  // Effect 2: 核心动画循环
  useEffect(() => {
    if (!enabled) return;
    const dot = dotRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;

    let mx = -100, my = -100;      // 真实鼠标位置
    let dx = -100, dy = -100;      // 灵球插值位置
    let hovering = false;
    let raf = 0;
    let last = performance.now();
    const particles: {...}[] = [];

    // ... resize / onMove / onOver / loop ...
  }, [enabled]);

  if (!enabled) return null;   // 不支持则完全不渲染

  return (
    <>
      <canvas ref={canvasRef} className="fixed inset-0 z-[9998] pointer-events-none" />
      <div ref={dotRef} className="fixed top-0 left-0 z-[9999] pointer-events-none w-3.5 h-3.5 rounded-full" style={{...}} />
    </>
  );
}
```

**为什么分成两个 effect？**
- Effect 1：一次性能力检测（决定要不要启用）
- Effect 2：动画循环（依赖 `enabled`）
分开后，切换 `enabled` 时循环能正确重建/清理。

## 4.8 与其他 UI 的配合

**卡牌悬停**：3D 翻转卡片有 `whileHover={{ y: -6 }}`，光球同时放大 1.7 倍——两层反馈叠加，交互感强。

**输入框聚焦**：光球在 input 上也是 1.7 倍，配合输入框自身的 `focus:shadow-[0_0_24px_rgba(168,85,247,0.25)]`，形成"聚光"效果。

**深色背景适配**：`mix-blend-mode: screen` 让光球在深色背景（#05020a）上自然发光，不需要为不同背景做适配。

## 4.9 面试话术

> "自定义光标这类氛围功能，我一定做**无障碍降级**。
>
> 实现分三层：canvas 粒子拖尾（z-9998）+ DOM 发光灵球（z-9999）+ 全局 `cursor: none`。
>
> 几个关键点：① 灵球用**指数插值**跟随鼠标（每帧走完剩余距离的 22%），不是直接贴上去——有生命感且与帧率无关；② 位置更新用 `transform` 而非 `left/top`，走 GPU 合成层不触发重排；③ 粒子寿命用 `dt/16.7` 归一化，跨 60/144Hz 表现一致；④ canvas 必须 `setTransform(dpr,...)` 处理 HiDPI，且每颗粒子画完要重置 `shadowBlur=0`——canvas 的 shadow 状态是持久的，不重置会累积；
>
> **最关键的无障碍设计**：`prefers-reduced-motion` 的用户（很多，前庭功能障碍者看到大幅动画会眩晕）直接不启用，触屏设备也不启用。而且我用 `html.has-stardust-cursor` 类名而不是直接 `* { cursor: none }`——**只有组件成功挂载才隐藏默认光标**，否则触屏用户会看不到任何指示。
>
> 判断一个体验类功能专不专业，我现在的标准是：**它有没有考虑'不该用的人'**。"

---

# 第 5 章：三者的交汇点 —— 一条占卜请求的完整生命周期

把三个模块串起来看，一次占卜请求发生了什么：

```
用户输入问题
    │
    ▼
[前端] POST /api/interpret { question, persona }
    │
    ▼
[服务端] createSession() → 内存 + SQLite 落库
    │
    ▼
[Agent] runAgent() → 循环
    │
    ├─ 决策调用 ask_user
    │     └─ SSE: ask_user { question, options }
    │          └─ [前端] 渲染问题卡片 → 用户点选
    │               └─ POST /api/answer → resolve → Agent 恢复
    │
    ├─ 决策调用 offer_card_selection
    │     └─ SSE: ask_user { cardSelection: true, fanCards: [7张], fanCount: 3 }
    │          └─ [前端] CardFan 渲染弧形扇面
    │               └─ 用户点选 3 张（记录 hover 停留时长）
    │                    └─ POST /api/answer "id,id,id|1800,900,3200"
    │                         └─ 服务端解析 → session.drawnCards
    │
    ├─ 决策调用 rag_search × 3（可并行）
    │     └─ [RAG] hybridSearch()
    │          ├─ BM25 通道：2-gram → IDF → k1/b → 字段权重 → 去重
    │          ├─ 向量通道：hashEmbed/ONNX → 余弦 → 去重（8s 软超时）
    │          └─ RRF 融合(k=60) → 每牌去重 → top-5 → 归一化
    │     └─ SSE: rag_hits { 5条, 带 score + channels }
    │          └─ [前端] KnowledgePanel 渲染分数条 + 通道标记
    │
    ├─ 决策调用 fate_crossroads
    │     └─ SSE: ask_user { crossroads: true, options: [2-3条走向] }
    │          └─ [前端] 琥珀色主题卡片 → 用户选 → POST /api/answer
    │
    └─ 决策调用 write_reading
          └─ 子 Agent 管线
               ├─ analyst: 结构化笔记（≤400字）
               ├─ writer:  流式撰写
               │    └─ SSE: delta × N  ←── 逐字推给用户
               │         └─ [前端] 打字机效果 + 自动滚动
               └─ reviewer: 三维度打分
                    ├─ pass → SSE: review { scores, comment }
                    └─ fail → writer 带 revision 重写 → reviewer 复检
          └─ SSE: done
    │
    ▼
[持久化] SQLite 落库（session 状态 / tool_calls / llm_usage）
    │
    ▼
[前端] 显示追问输入框 + "观测面板"入口
```

**三个模块的协作关系**：
- **光标**贯穿全程——它是"你一直在和一个有生命的东西交互"的心理暗示
- **Agent** 决定流程——它决定什么时候该问你、什么时候该检索、什么时候该写
- **RAG** 提供依据——它保证解读里的每句"典籍有云"都有出处

---

# 第 6 章：面试问答准备

## 6.1 关于 RAG

**Q：你的 RAG 是 mock 吗？**
> "不是。知识库是真实的 79 条 tarot-lab 数据，BM25 是完整的 Okapi 实现，向量通道跑的是**真实 ONNX embedding 模型**（all-MiniLM-L6-v2，384 维，本地离线推理），RRF 是标准算法。
>
> 不过我保留了两级降级（特征哈希向量 → 纯 BM25），因为部署环境不可控——面试现场或 CI 上可能没有那 22MB 模型文件。而且知识面板保留了 `channels` 字段标注每条命中来自 bm25 / vector / hybrid，**让降级状态可被观测，而不是假装一切正常**。"

**Q：向量检索具体带来了什么提升？**
> "举个实测例子：查询'感情出现裂痕怎么办'，纯 BM25 命中的是权杖七、星币七、宝剑七——都是'七'字牌，纯靠 2-gram 巧合匹配。但向量通道命中的是**宝剑八**（被蒙蔽、束缚、看不到出路，0.79）和**圣杯八**（离开、放下，0.75），这两张牌的牌意和查询字面上毫无重叠。
>
> 检索层面 BM25 管'字面说了什么'，向量管'意思像什么'，RRF 把两路的排名融合。**这就是混合检索的意义**——不是把一个更强的算法换掉另一个，而是用两个信号源互相补盲。"

**Q：BM25 的 k1 和 b 是什么意思，调成 0 会怎样？**
> "k1=1.5 是词频饱和参数：词在文档里出现 1 次和 10 次的得分差距是收敛的，防止靠堆词提分。b=0.75 是长度归一化：长文档天然包含更多词会占便宜，b 用来惩罚。**b 调成 0 就完全关闭长度归一化**，检索会严重偏向长文档——比如牌面叙事块会因为字多而总是排在前面。"

**Q：为什么用 2-gram 而不是分词器？**
> "权衡后的选择。jieba 精度更高，但要引入依赖 + 约 5MB 词典 + 首屏加载。2-gram 零依赖、6 行实现、召回够用，代价是'权杖'和'手杖'这种近义词无法区分。312 个 chunk 的规模下索引体积也就 125KB，完全可接受。**如果数据量上去、需要跨词泛化，我会换成字/词混合切分或直接上真分词器**——不过有了向量通道，字面匹配的精度要求其实降低了。"

**Q：RRF 为什么比分数相加好？**
> "因为 BM25 分无上界（实测 5~20）、余弦最大 1，量纲完全不可比。强行归一化很脆弱——归一化系数在不同查询上差异极大。RRF 只用排名不用分数，天然规避。k=60 是关键：k=1 时第 1 名和第 10 名的 RRF 差 5.5 倍，头部微小波动就主导结果；k=60 时相邻排名只差 1.6%，融合结果平滑鲁棒。"

**Q：每牌去重是什么意思，为什么不每 chunk 去重？**
> "top-k 的语义是'给用户 k 张相关牌'，不是'k 个知识片段'。同一张牌的 4 个字段 chunk 命中的是同一个知识点，保留最高分的那个就够，用户兴趣单位是牌不是字段。"

**Q：怎么知道 RAG 真的在工作，不是摆设？**
> "四个验证方法：① 知识面板每条命中都带 `source`（tarot-lab · 权杖七 · 正位牌意），可回溯原始 JSON；② 解读里的 `[n]` 编号对应面板第 n 条；③ 单独跑 `node -e "require('./mcp-server/rag-engine.cjs').ragSearch('复合 感情',5)"` 直接测纯 BM25 通道；④ 查 SQLite 的 tool_calls 流水，检索耗时是 4ms——真在算。另外语义通道有独立自检脚本 `scripts/test-embedding.mjs`，能打印出'升职加薪的机会'≈'事业上升，报酬增加'这种 0.704 的余弦值。"

**Q：你怎么下载 embedding 模型的？遇到过什么坑？**
> "先用连通性矩阵测多个源（hf-mirror / 官方 / modelscope / jsdelivr），确认 hf-mirror 可用后写脚本下载 5 个文件。踩的坑是**目录结构**：transformers.js 找的是 `Xenova/all-MiniLM-L6-v2/onnx/...`（斜杠），我最初下到 `Xenova%2Fall-MiniLM-L6-v2`（URL 编码），报 ModelFileNotFoundError。修法是两套结构都放一份。另外脚本里用 `require()` 和 top-level await 混用会报 ESM 歧义错误，得统一用 import。"

## 6.2 关于 Agent

**Q：为什么不用 LangChain？**
> "三个理由：一是想展示对底层机制的理解而不是调 API；二是手写能精确控制 HITL 挂起——SSE 流不中断、用户答完立即恢复，这在现成框架里反而要绕开它们的状态机；三是零依赖，部署简单。代价是我得自己处理协议细节，比如 tool_call_id 必须严格对应。"

**Q：多 Agent 拆分的判断依据是什么？**
> "**角色冲突**。一个 LLM 同时做分析、写作、自检时，创作模式会压过严谨模式——写的时候不想着引用准不准，写完再自检已经陷在自己的措辞里。拆开后每个子 Agent 只做一件事，且子 Agent 间传的是**精炼中间产物**（≤400 字结构化笔记）而不是共享全部上下文，这是性能关键。"

**Q：Reflexion 是什么？**
> "生成 → 自评 → 反思 → 重写闭环。审校者打分不达标时输出具体的 revision 指令，撰写者按它重写，然后**真正重新审校**。关键不是'让模型自我批评'，而是**批评必须可执行**。"

**Q：你在 Reflexion 上踩过什么坑？**
> "两个。① 审校标准设计错误：审校者把'用户亲手选的牌不在 RAG 检索结果里'判为编造（grounding=3），触发无意义重写。根因是审校 prompt 没定义合法引用来源——其实'用户抽到的牌的牌库原文'也是合法依据。修复后 grounding 从 3 升到 9，省掉 103 秒重写。**这说明 AI 的评判标准本身需要设计**，标准有偏就会陷入'误判→重写→还是误判→无限重写'的死循环。② 复检是假的：代码只重发旧 review 事件加个标记，没真重跑 reviewer。'看起来做了'和'真的做了'要能区分。"

**Q：HITL 怎么实现的？为什么不用 WebSocket？**
> "Agent 循环在需要人类输入时 `await` 一个 Promise，把 resolve 存到会话；人类通过另一个 HTTP 端点调 resolve，服务端立即恢复推进。**整条 SSE 流保持打开**，用户回答后继续收到后续事件。不用 WebSocket 是因为：SSE 单向推送够用、HTTP 原生无需额外网关支持、部署时不用配长连接。而且这个方案天然支持多次交互（澄清→选牌→岔路可以连续发生）。"

**Q：Agent 循环怎么防止死循环？**
> "三重：① `MAX_ROUNDS = 12` 硬上限（实测正常占 5 轮，留 2 倍余量）；② system prompt 里写明'【纪律】ask_user 全程最多 2 次'；③ `write_reading` 只调一次，重写由管线内部处理。每轮至少一次 LLM 调用，必须有上限，否则会烧钱到天亮。"

**Q：dev 模式下 /api/answer 报 410 怎么解决的？**
> "Next.js dev 模式（Turbopack）把不同路由编译到不同 worker，模块级 Map 不共享——占卜的会话存在 worker A，应答接口在 worker B 找不到。修复是挂到 `globalThis` 单例。生产 build 没这个问题，但统一写法让 dev/prod 行为一致。"

**Q：多模型 failover 是怎么设计的？**
> "三层：① **触发精准**——只对网络错误/超时/5xx/429 切换，4xx 业务错误不切（切了也没用）；② **粘性记忆**——主模型失败后 10 分钟内直接用备用，不再每次先吃主模型的连接超时（Windows TCP 对不可达地址要 20~80 秒才报错）；③ **流式安全**——撰写者只在首 token 前失败才切换，已开始输出就不切，避免用户看到重复内容。实测把主模型指向不可达地址，能自动切到 MiniMax-M3 完整跑完占卜。"

## 6.3 关于光标

**Q：自定义光标要注意什么？**
> "最关键是**无障碍降级**。`prefers-reduced-motion` 的用户（很多，前庭功能障碍者看到大幅动画会眩晕）直接不启用，触屏也不启用。而且用 `html.has-stardust-cursor` 类名而不是直接 `* { cursor: none }`——只有组件挂载成功才隐藏默认光标，否则触屏用户看不到任何指示。"

**Q：canvas 性能怎么保证？**
> "四点：① 位置更新用 `transform` 走 GPU 合成层，不触发重排；② 粒子数上限 260，超出从头部删最老的；③ `mousemove` 用 `{ passive: true }` 避免阻塞滚动；④ 卸载时 `cancelAnimationFrame` + 移除所有监听器（React 严格模式会双调用 effect，不清理会让监听器注册两遍）。"

**Q：HiDPI 怎么处理？**
> "三步缺一不可：`canvas.width = css宽 × dpr`（物理像素）、`canvas.style.width = css宽 px`（CSS 尺寸）、`ctx.setTransform(dpr,0,0,dpr,0,0)`（后续绘制坐标仍用 CSS 像素）。漏第三步粒子会偏移且模糊。"

**Q：为什么光球要 mix-blend-mode: screen？**
> "为了在深色背景上自然发光、亮色区域不变成死白。普通叠加是'盖住'底层，screen 是'叠加亮度'——光球经过任何背景都保持通透。"

**Q：粒子寿命怎么做到跨帧率一致？**
> "`p.life += dt / 16.7`——除以 60fps 一帧的毫秒数，寿命以'60fps 帧当量'计。如果直接 `life++`，144Hz 屏上前 40 帧就死完（0.28 秒），30Hz 屏上又拖很久。另外 `dt` 要 `Math.min(now-last, 50)` 封顶，标签页切回前台时时间差可能是几秒，不封顶会让粒子瞬间全部老化。"

---

# 第 7 章：P0-P4 优化实录 —— 用生产数据驱动改进

> 本章记录 2026-10-26 完成的一轮系统性优化。特点：**所有改动都由真实生产数据（SQLite 里的 24 条会话 + 68 次工具调用）驱动，不是拍脑袋。**

## 7.1 优化前的生产数据基线

用 `scripts/analyze.cjs` 对 SQLite 数据做体检，发现的问题：

| 发现 | 数据 | 对应问题 |
|---|---|---|
| 审校者解析失败 | 4/12 会话 review JSON 解析失败，**静默按"通过"处理** | LLM 输出不规范时伪造审校结果 —— 严重可信度问题 |
| 会话卡死 | 10/24 会话停在 `running` 状态 | 进程重启后内存 Map 丢失，DB 状态永不收敛 |
| 撰写者 token 统计缺失 | writer 平均 prompt_tokens=0 | MiniMax 流式响应不带 usage 字段，统计口径缺失 |
| Supervisor 上下文膨胀 | prompt tokens 1357 → 2873（第 1 轮 → 第 4 轮） | 每轮把完整工具结果回填 messages，上下文线性膨胀 |
| Analyst 超时 | 10k tokens / 84 秒 | 无 max_tokens 限制 + 思维链吃满配额 |
| rag_search 重复调用 | 68 次调用 / 20 会话（≈3.4 次/会话） | LLM 每轮重新检索，无缓存 |
| `rag_hits` 事件协议缺陷 | eval 断言 `rag` 维度 0% | LLM 路径把命中内嵌在 `tool` 事件里，独立事件从未发出 |

## 7.2 P0：可靠性 —— 审校结果绝不伪造

**问题**：`JSON.parse` 失败 → catch 里默认 `pass: true`。审校者输出不规范时，等于审校环节形同虚设。

**修复**（三层防御）：

1. **鲁棒 JSON 解析器**（新增 `src/lib/robust-json.ts`）：
   - 第一层：直接 `JSON.parse`
   - 第二层：括号配平提取（字符串/转义感知）+ 归一化（全角引号→半角、去尾逗号、单引号→双引号）
   - 第三层：字段级正则提取兜底（`extractScore`/`extractString`/`extractBool`）
2. **一次纠偏重试**：解析失败 → 把错误信息附在重试 prompt 后再调一次
3. **显式"审校未完成"状态**：两次都失败 → `pass: true` 但三个维度全 0 分 + comment 明确写"审校未完成（输出不可解析）"——**前端如实展示，绝不静默装作通过**

> 面试话术：**"宁可信其坏，不可伪造好。"** 审校环节的可信度 > 解读的成功率指标。

## 7.3 P1：鲁棒性 —— 会话状态收敛

**问题**：dev 模式改代码热重载 / 进程崩溃 → 内存 Map 清空，DB 里 `running` 状态的会话成为僵尸，dashboard 统计永远失真。

**修复**：

- **启动对账**（`db.reconcileStaleSessions`）：服务启动时把超过 30 分钟的 `running` 会话标记为 `error("stale_timeout")`。本次 dev server 重启实测清理了 10 个僵尸会话 ✓
- **客户端断连感知**（`/api/interpret/route.ts`）：`req.signal.addEventListener("abort")` → `failSession(sid, "client_disconnect")`；SSE send() 前检查 closed/aborted 标志，杜绝向已关闭流写入
- **看门狗**：每会话总 deadline（默认 5 分钟）到点强制 `failSession("deadline_exceeded")`，Agent 永不无限挂起
- **DB 迁移**：sessions 表新增 `error_reason`（区分 llm_error / max_rounds / client_disconnect / deadline_exceeded / stale_timeout）与 `prompt_version` 列

## 7.4 P2：Token 成本 —— 上下文治理

**问题**：Supervisor 第 4 轮 prompt 已 2873 tokens——每轮全量回填工具结果，轮数越多越贵越慢。

**修复**：

- **历史压缩**（`trimHistory`）：保留最近 4 轮完整对话，更早的工具结果压缩为 `（早期结果已压缩）` 一行
- **RAG 结果瘦身**（`compressRagResult`）：回填 LLM 的工具内容从完整 JSON 压缩为 top-3 紧凑格式 `[i] 牌名·字段: 40字片段`（省 30-40% token）；**完整命中仍通过独立 `rag_hits` SSE 事件发给前端**，展示无损
- **Analyst 输出约束**：250 字上限 + 两行结构化格式（原来 10k tokens / 84s → 显著下降）
- **Writer max_tokens 修正**：1400（被思维链吃光导致空输出）→ 6000

## 7.5 P3：可观测性 —— 瓶颈看得见

三个新维度，全部进入 dashboard：

1. **轮次时间轴**（新 SSE 事件 `round`）：每轮结束发 `{ round, elapsedMs, promptTokens, toolNames, phase }`；前端 AgentTrace 渲染为决策时间条形图 —— **哪一轮、哪个工具慢，一眼定位**（>15s 标黄）
2. **等待提示**（WaitingHint）：>3s 显示"思考中… Ns"，>10s 变琥珀色"模型仍在思考… 可查看下方时间轴定位瓶颈"——把黑盒等待变成有信息的等待
3. **Dashboard 扩展**：⚠️卡死会话（ID+问题+时长）、❌异常原因分布、🤖各 Agent 性能明细（调用数/平均 prompt/completion tokens/平均耗时，>15s 标黄）、📝Prompt 版本效果对比

## 7.6 P4：体验闭环 —— 引文可点击 + 分享卡

**可点击引文**（新组件 `CitedReading.tsx`）：

- 解读文本里的 `[n]` 渲染为可点击角标；点击 → KnowledgePanel 对应命中行滚动到可视区 + 琥珀色 ring 高亮 2.5s
- 引文序号超出命中范围（`n > 命中数`）→ 渲染为红色禁用态，title 提示"可能是模型幻觉"——**把 RAG 幻觉检测做成了 UI 的一部分**
- 兼容全角 `［１］` 写法

**分享卡**（新组件 `ShareCard.tsx`）：

- 纯浏览器 Canvas 合成 1080×1620 竖版 PNG：星空背景（伪随机星点）+ 牌面（逆位旋转 180°）+ 牌名/位置 + 问题摘要 + 结论 + 落款
- 无服务端参与（隐私 + 零成本），canvas.toBlob 下载
- 卡牌图加载失败时降级为纯色块 + 牌名文字

## 7.7 回归验证

修复 `rag_hits` 事件缺陷（LLM 路径原来只内嵌在 `tool` 事件里）后，eval 套件结果：

```
修复前：总体通过率 77%（rag 维度 0%，cite 100% —— 引用存在但事件缺失）
修复后：总体通过率 97%（rag 100% / cite 100% / complete 100% / review 100% / clarify 83%）
```

clarify 83% 是"面试问题"用例里 Agent 主动澄清了（预期不澄清，给 0.5 部分分）——属可接受行为，不算缺陷。

## 7.8 本章面试要点

**Q：为什么把"审校失败"显式暴露而不是静默通过？**
> "因为审校是整个 Reflexion 闭环的裁判。裁判造假，闭环就是自欺。宁可让用户看到'审校未完成'，也不能在数据里记一条假的'通过'——否则后面所有的质量统计都失真。"

**Q：会话僵尸怎么发现的？**
> "dashboard 上 10/24 会话永远 running。根因是状态存内存 Map、持久层只写不收：进程重启后内存没了，DB 里的 running 再也没人改。修复是启动时对账 + 客户端 abort 监听 + 看门狗三件套。"

**Q：上下文压缩会不会丢信息？**
> "会，所以做了不对称设计：给 LLM 的回填用压缩版（它只需要结论），给前端的展示用完整版（用户要核对）。信息没丢，只是按消费者分流。"

**Q：怎么证明 P2 优化有效？**
> "Supervisor 每轮 prompt tokens 从线性膨胀（1357→2873）压到近似常数（最近 4 轮完整 + 更早压缩）；analyst 从 10k tokens/84s 降到受控输出。可以在 dashboard 的 Agent 性能面板直接看数字。"

---

## 附录：文件索引

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/lib/rag-engine.ts` | ~284 | BM25 + RRF + 分块 + Prompt 上下文组装 |
| `src/lib/vector-engine.ts` | ~267 | 向量检索：ONNX 模型 + 特征哈希降级 + 超时保护 |
| `src/lib/tarot-agent.ts` | ~1400 | Agent 引擎：Supervisor 循环 + 三子 Agent + HITL + 轮次事件 |
| `src/lib/llm-providers.ts` | ~160 | 多模型 failover：健康记忆 + 粘性切换 + 启动探活 |
| `src/lib/robust-json.ts` | ~150 | 三层 LLM JSON 解析器（parse→配平提取→字段正则） |
| `src/lib/prompts.ts` | ~180 | 全部 system prompts 集中管理（版本化 PROMPT_VERSION） |
| `src/lib/db.ts` | ~230 | SQLite 持久层（三张表 + 对账 + 错误原因 + prompt 版本） |
| `src/components/StardustCursor.tsx` | ~150 | 星尘自定义光标 |
| `src/components/CardFan.tsx` | ~110 | 选牌扇面 + 犹豫时长记录 |
| `src/components/AgentTrace.tsx` | ~200 | 工具 Trace + 思考链 + 轮次时间轴条形图 |
| `src/components/KnowledgePanel.tsx` | ~110 | RAG 命中可视化（分数条 + 引文联动高亮） |
| `src/components/CitedReading.tsx` | ~100 | 解读文本 [n] 引文角标（点击跳转知识面板） |
| `src/components/ShareCard.tsx` | ~190 | Canvas 分享卡合成（星空 + 牌面 + 摘要） |
| `src/components/SubAgentPipeline.tsx` | ~80 | 子 Agent 生命周期 |
| `src/components/ReviewCard.tsx` | ~90 | 审校报告卡片 |
| `src/app/api/interpret/route.ts` | ~85 | SSE 接口（abort 感知 + 断连标记） |
| `src/app/api/answer/route.ts` | ~34 | HITL 应答 |
| `src/app/dashboard/page.tsx` | ~260 | 观测面板（卡死会话/异常分布/Agent明细/Prompt版本） |
| `scripts/eval-agent.mjs` | ~230 | Agent 评估套件（失败分类 + 环境阻塞识别） |
| `scripts/analyze.cjs` | ~120 | DB 体检（token 分布/解析失败率/会话状态/工具频次） |
| `scripts/download-model.mjs` | ~110 | 向量模型多源下载（modelscope→hf-mirror→HF） |
| `scripts/inspect-db.cjs` | ~40 | 数据库排查工具 |
| `mcp-server/index.mjs` | ~180 | MCP Server（4 工具） |

---

*文档生成时间：2026-10-26（P0-P4 优化后更新）*
*配套代码版本：见项目 git 状态*
