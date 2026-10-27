#!/usr/bin/env node
/**
 * RAG 检索质量评估（方向②）：golden set → Recall@5 / MRR / NDCG
 *
 * 用法：node scripts/eval-rag.mjs [--topk 5]
 * 任何 RAG 参数改动（chunk 策略 / 融合权重 / 切词）前后必须跑本集对比。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 动态加载 rag-engine（TS 模块，通过 tsx 运行或 next dev 的编译缓存皆可）
async function loadRag() {
  try {
    return await import("../src/lib/rag-engine.ts");
  } catch {
    // 直接跑 node（无 tsx）：用内联等价实现太重，提示用 tsx
    console.error("请用 npx tsx 运行本脚本（需加载 TS 模块）：");
    console.error("  npx tsx scripts/eval-rag.mjs");
    process.exit(2);
  }
}

const golden = JSON.parse(readFileSync(join(__dirname, "rag-golden-set.json"), "utf-8"));
const cases = golden.cases;

const TOPK = Number(process.argv.find((a) => a.startsWith("--topk"))?.split("=")[1] ?? 5);

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

function ndcgAtK(retrieved, relevant, k) {
  const rel = new Set(relevant);
  let dcg = 0;
  for (let i = 0; i < Math.min(k, retrieved.length); i++) {
    if (rel.has(retrieved[i])) dcg += 1 / Math.log2(i + 2);
  }
  // 理想 DCG：相关牌全部排最前
  const ideal = Math.min(relevant.length, k);
  let idcg = 0;
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

async function main() {
  const rag = await loadRag();
  const rewriteMod = await import("../src/lib/query-rewrite.ts");
  const { TAROT_CARDS } = await import("../src/lib/tarot-cards.ts");
  const USE_REWRITE = process.argv.includes("--rewrite");
  console.log(`\n🔍 RAG 检索质量评估 · golden set ${cases.length} 条 · top-${TOPK}${USE_REWRITE ? " · 查询改写 ON" : ""}\n`);

  let sumRecall = 0, sumMrr = 0, sumNdcg = 0;
  const fails = [];

  for (const c of cases) {
    const query = USE_REWRITE
      ? rewriteMod.rewriteQueryLocal(c.query, TAROT_CARDS.map((x) => x.nameZh))
      : c.query;
    const hits = await rag.hybridSearch(query, TOPK);
    const retrieved = hits.map((h) => h.cardId);
    const r = recallAtK(retrieved, c.relevant, TOPK);
    const m = mrr(retrieved, c.relevant);
    const n = ndcgAtK(retrieved, c.relevant, TOPK);
    sumRecall += r; sumMrr += m; sumNdcg += n;
    if (r === 0) {
      fails.push({ query: c.query, relevant: c.relevant, retrieved: retrieved.slice(0, TOPK).join(",") });
    }
  }

  const n = cases.length;
  console.log(`  Recall@${TOPK}:  ${((sumRecall / n) * 100).toFixed(1)}%`);
  console.log(`  MRR:        ${(sumMrr / n).toFixed(3)}`);
  console.log(`  NDCG@${TOPK}:   ${(sumNdcg / n).toFixed(3)}`);

  if (fails.length > 0) {
    console.log(`\n  ⚠️ 零命中的查询（${fails.length} 条）：`);
    for (const f of fails.slice(0, 10)) {
      console.log(`    「${f.query}」期望=${f.relevant.join(",")} 实际=${f.retrieved}`);
    }
    if (fails.length > 10) console.log(`    …还有 ${fails.length - 10} 条`);
  }
  console.log("");
}

main();
