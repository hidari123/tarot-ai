#!/usr/bin/env node
/**
 * RAG 融合参数网格搜索（P4-⑪）
 *
 * 背景：Recall@5 82.2%（生产路径）但裸检索只有 44.6% ——
 * 改写层承担了 37.6 个点。检索层自身太弱 = golden set 恰好被
 * 改写规则覆盖才好看。加强检索层 = 换个说法也能召回。
 *
 * 网格维度（当前值 → 搜索范围）：
 *   RRF_K        20 → {10, 20, 40, 60}
 *   EXACT_BOOST  3  → {1, 3, 5}
 *   字段权重进融合 off/on
 *   向量通道权重 1.0 → {1.0, 1.5, 2.0}（口语查询靠语义）
 *
 * 评估口径：golden set 51 条，**双口径**（裸查询 + 改写后查询）
 * —— 裸检索是检索层真实实力；改写口径防"优化裸查询伤了生产"。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(__dirname, "rag-golden-set.json"), "utf-8"));
const cases = golden.cases;

const rewriteMod = await import("../src/lib/query-rewrite.ts");
const { TAROT_CARDS } = await import("../src/lib/tarot-cards.ts");
const rag = await import("../src/lib/rag-engine.ts");

function recallAtK(retrieved, relevant, k) {
  const rel = new Set(relevant);
  const hit = retrieved.slice(0, k).filter((id) => rel.has(id)).length;
  return relevant.length === 0 ? 0 : hit / relevant.length;
}
function mrr(retrieved, relevant) {
  const rel = new Set(relevant);
  for (let i = 0; i < retrieved.length; i++) {
    if (rel.has(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}

/** 跑一遍全量 golden（可指定用改写后的查询） */
async function evalOnce(rewrite) {
  let sumR = 0, sumM = 0, zeroHit = 0;
  for (const c of cases) {
    const q = rewrite
      ? rewriteMod.rewriteQueryLocal(c.query, TAROT_CARDS.map((x) => x.nameZh))
      : c.query;
    const hits = await rag.hybridSearch(q, 5);
    const retrieved = hits.map((h) => h.cardId);
    const r = recallAtK(retrieved, c.relevant, 5);
    sumR += r;
    sumM += mrr(retrieved, c.relevant);
    if (r === 0) zeroHit++;
  }
  return {
    recall: sumR / cases.length,
    mrr: sumM / cases.length,
    zeroHit,
  };
}

console.log("\n🔍 RAG 融合参数网格搜索 · golden 51 条\n");

// 当前配置（改动后：字段权重进融合已开）
const nowRaw = await evalOnce(false);
const nowRewritten = await evalOnce(true);
console.log("== 当前配置（字段权重进融合 = ON）==");
console.log(`  裸:   Recall@5 ${(nowRaw.recall * 100).toFixed(1)}%  MRR ${nowRaw.mrr.toFixed(3)}  零命中 ${nowRaw.zeroHit}`);
console.log(`  改写: Recall@5 ${(nowRewritten.recall * 100).toFixed(1)}%  MRR ${nowRewritten.mrr.toFixed(3)}  零命中 ${nowRewritten.zeroHit}`);

// ⚠️ 为什么是这个写法（而不是"改配置跑两遍对比"）：
//   rag-engine 是**单例模块**（import 后缓存），运行期改环境变量不会重新加载 ——
//   想真正对比"字段权重进融合 ON/OFF"必须能切分实现，成本远大于收益。
//   所以这里的定位是「**记录一次实验**」，不是「可复现的 A/B 框架」：
//   ON 的实现已被实测否决并回退（结论写在 rag-engine.ts 的 fuseAndDedup 注释里），
//   本脚本保留下来是为了让结论**可复现核对** —— 跑一遍看看当前实现的数字
//   是否仍与当初的基线一致（基线硬编码在下方）。
//   若要做真正的 A/B，应给 fuseAndDedup 加一个显式参数（而非环境变量）。
console.log("\n== 结论依据 ==");
console.log("基线（字段权重不进融合，git 提交 fc41951 前）：");
console.log("  裸:   Recall@5 44.6%  MRR 0.556  零命中 14");
console.log("  改写: Recall@5 82.2%  MRR 0.917  零命中 0");
console.log("");
console.log("当前（字段权重进融合 = ON）：");
console.log(`  裸:   Recall@5 ${(nowRaw.recall * 100).toFixed(1)}%  MRR ${nowRaw.mrr.toFixed(3)}  零命中 ${nowRaw.zeroHit}`);
console.log(`  改写: Recall@5 ${(nowRewritten.recall * 100).toFixed(1)}%  MRR ${nowRewritten.mrr.toFixed(3)}  零命中 ${nowRewritten.zeroHit}`);

const delta = (nowRaw.recall * 100) - 44.6;
const deltaRw = (nowRewritten.recall * 100) - 82.2;
console.log(`\n裸检索变化: ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} pt`);
console.log(`改写口径变化: ${deltaRw >= 0 ? "+" : ""}${deltaRw.toFixed(1)} pt`);

if (delta > 0.5 && deltaRw > -0.5) {
  console.log("\n✅ 字段权重进融合有净收益，保留");
  process.exit(0);
} else if (delta > -0.5 && deltaRw > 0.5) {
  console.log("\n✅ 改写口径显著提升，保留");
  process.exit(0);
} else {
  console.log("\n⚠️ 无净收益（中性或负向）—— 这也是结论：字段权重在 BM25 内部已经生效，");
  console.log("   融合层再加一遍是重复计数。P4-⑪ 的正确方向应是 cross-encoder rerank（超出本次范围）。");
  process.exit(1);
}
