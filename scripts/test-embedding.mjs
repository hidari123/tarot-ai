/** 验证 transformers.js 能加载本地模型并做真实语义 embedding */
import { pipeline, env } from "@huggingface/transformers";
import { join } from "node:path";

const CACHE_DIR = join(process.cwd(), "data", ".cache");
env.cacheDir = CACHE_DIR;
env.localModelPath = CACHE_DIR;
env.allowRemoteModels = false;   // 强制离线：只认本地文件
env.allowLocalModels = true;

console.log("加载模型（离线模式）...");
const t0 = Date.now();
const pipe = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
  dtype: "q8",
});
console.log(`✓ 加载完成（${Date.now() - t0}ms）`);

// 真实语义测试：字面不重叠但语义相近的句子
const CASES = [
  ["心里放不下他", "留恋逝去的一切，无法释怀"],
  ["面试前很紧张", "即将到来的考验令人忐忑不安"],
  ["升职加薪的机会", "事业上升，报酬增加"],
  ["感情出现裂痕", "亲密关系面临破裂的危险"],
];

console.log("\n语义相似度实测（余弦）：");
for (const [a, b] of CASES) {
  const out = await pipe([a, b], { pooling: "mean", normalize: true });
  const va = out[0].data, vb = out[1].data;
  let dot = 0;
  for (let i = 0; i < va.length; i++) dot += va[i] * vb[i];
  console.log(`  ${dot.toFixed(3)}  "${a}"  ≈  "${b}"`);
}

// 对照组：无关句子
const out2 = await pipe(["今天天气不错", "生活需要仪式感"], { pooling: "mean", normalize: true });
const c = out2[0].data, d = out2[1].data;
let dot2 = 0;
for (let i = 0; i < c.length; i++) dot2 += c[i] * d[i];
console.log(`  ${dot2.toFixed(3)}  "今天天气不错"  ≈  "生活需要仪式感"  (对照组,应较低)`);

console.log(`\n维度: ${out[0].data.length}`);
console.log("✓ 真实 ONNX embedding 可用");
