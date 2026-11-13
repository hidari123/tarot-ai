import { readFileSync, writeFileSync } from "node:fs";

// ⚠️ 抽取 consumeStream 里的事件分发 switch → useEventDispatcher.ts
const P = "src/app/page.tsx";
const src = readFileSync(P, "utf-8");
const NL = "\r\n";

// 找 switch 起点
const switchStart = src.indexOf("          switch (p.type) {");
if (switchStart < 0) { console.log("MISS switch start"); process.exit(1); }

// 找 switch 结束（对应 case "error" 之后的 "}" ）
const errorCaseIdx = src.indexOf('            case "error":');
if (errorCaseIdx < 0) { console.log("MISS error case"); process.exit(1); }
const afterError = src.indexOf("          }", errorCaseIdx);
if (afterError < 0) { console.log("MISS switch end"); process.exit(1); }

const switchBody = src.slice(switchStart, afterError + "          }".length);
writeFileSync("scripts/dev/_switch_body.txt", switchBody, "utf-8");
console.log(`✓ 提取 ${switchBody.split(/\r?\n/).length} 行`);
console.log(`✓ 首行: ${switchBody.split(/\r?\n/)[0]}`);
console.log(`✓ 末行: ${switchBody.split(/\r?\n/).slice(-1)[0]}`);
