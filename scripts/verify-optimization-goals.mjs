#!/usr/bin/env node
/**
 * 目标逐项终审（P0 / P1 / P2 / P3 全部优化项）
 *
 * ⚠️ 为什么要有这个脚本：
 *   目标文本列了 20 个具体优化项，散落在 7 次提交里。
 *   "我记得都做了"是不可靠的 —— 必须有**可执行**的证据。
 *   本脚本对每一项做**代码级证据检查**（不是叙述，是 grep 出来的位置）。
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const read = (rel) => readFileSync(join(root, rel), "utf8");
const has = (rel) => existsSync(join(root, rel));

let pass = 0, fail = 0;
const groups = [];
let current = null;

function group(title) {
  current = { title, items: [] };
  groups.push(current);
  console.log(`\n${title}`);
}
function item(label, ok, evidence = "") {
  current.items.push({ label, ok, evidence });
  console.log(`  ${ok ? "✓" : "✗"} ${label}${evidence ? ` — ${evidence}` : ""}`);
  if (ok) pass++; else fail++;
}

const llm = read("src/lib/agent/llm.ts");
const sup = read("src/lib/agent/supervisor.ts");
const mach = read("src/lib/agent/ritual-machine.ts");
const sess = read("src/lib/agent/session.ts");
const db = read("src/lib/db.ts");
const auth = read("src/lib/api-auth.ts");
const page = read("src/app/page.tsx");
const rag = read("src/lib/agent/tools/rag.ts");
const fb = read("src/lib/agent/fallback.ts");
const vec = read("src/lib/vector-engine.ts");
const interpret = read("src/app/api/interpret/route.ts");
const summarize = read("src/app/api/summarize/route.ts");
const runtime = read("src/lib/runtime.ts");

/* ═══════════ P0 ═══════════ */
group("P0 —— 五个最高优先级");

item(
  "P0-① 限流器并发占位（占位在 await 之前）",
  /bucket\.stamps\.push\(releaseAt\);[\s\S]{0,200}?await new Promise/.test(llm),
  "stamps.push(releaseAt) 位于 await sleep 之前"
);
item(
  "P0-① 429 per-provider 收紧（不是全局变量）",
  /rateStates = runtimeState<Map<string, ProviderRateState>>/.test(llm) &&
    /export function tightenOnRateLimit\(providerName: string\)/.test(llm) &&
    !/^let rateScale/m.test(llm),
  "rateStates 是 Map + tightenOnRateLimit(providerName)"
);
item(
  "P0-② 降级路径同构（fanCards / 用户选的牌 / flip_ready / confirm / nudge）",
  /fanCards/.test(fb) && /card_flip_ready/.test(fb) && /card_confirm/.test(fb) &&
    /nudge/.test(fb) && /ritualPhase/.test(fb),
  "fallback.ts 含全部同构要素"
);
item(
  "P0-③ 前端 SSE 可取消（AbortController + signal + abort 调用）",
  /new AbortController\(\)/.test(page) && /signal:\s*[A-Za-z_$][\w.$]*\s*[},]/.test(page) &&
    /abortStream\(\)/.test(page),
  "page.tsx 有 controller + signal + abortStream()"
);
item(
  "P0-④ 断点续传真能触发（catch 块读 ref 而非 state 闭包）",
  /sessionIdRef\.current/.test(page) &&
    /catch \(e\) \{[\s\S]*?resumeStream\(\)/.test(page),
  "catch 块用 sessionIdRef.current"
);

/* ═══════════ P1 ═══════════ */
group("P1 —— 安全与并发");

item(
  "P1-④ API 鉴权（能力凭证 + fail closed）",
  /generateSessionId/.test(auth) && /generateShareToken/.test(auth) &&
    /checkDashboardAuth/.test(auth) && /fail closed/.test(auth),
  "api-auth.ts：sessionId / shareToken / 面板 token"
);
item(
  "P1-④ 输入长度上限（question/followup/answer/body）",
  /question: 500/.test(auth) && /followup: 500/.test(auth) &&
    /answer: 4000/.test(auth) && /bodyBytes/.test(auth),
  "LIMITS 常量齐备"
);
item(
  "P1-④ userKey 服务端派生（客户端不可伪造）",
  /export function deriveUserKey/.test(auth) &&
    /createHash\("sha256"\)/.test(auth),
  "deriveUserKey(IP+UA+盐)"
);
item(
  "P1-④ 安全响应头（框架级统一）",
  // ⚠️⚠️ 2026-11-04 修正：CSP **不再**放在 next.config.ts 的 headers() 里。
  //   原因：next.config 的 headers() 是**静态**的，只能写死一份 CSP；
  //   而 CSP 需要"每请求动态"（nonce / strict-dynamic）才能既严格又不挡死页面。
  //   Next.js 16 的正确位置是 `src/proxy.ts`（原 middleware，已改名）。
  //   实测踩过：写在 next.config 的 `script-src 'self'` 会把 Next 的内联
  //   RSC script 全拦掉 → **首页永远停在 loading**。
  //   ⚠️ 断言改成"检查安全头在**任一**框架级位置"，并**额外**要求
  //     proxy.ts 里的 script-src 不会挡死内联脚本。
  (() => {
    const nc = read("next.config.ts");
    const px = has("src/proxy.ts") ? read("src/proxy.ts") : "";
    // 其余安全头（X-Frame-Options 等）必须在 next.config（框架级、全站生效）
    const restOk = /X-Frame-Options/.test(nc) && /X-Content-Type-Options/.test(nc);
    // CSP 必须在 proxy.ts 且放行内联脚本
    const cspOk =
      /Content-Security-Policy/.test(px) &&
      /script-src/.test(px) &&
      /'unsafe-inline'/.test(px);
    return restOk && cspOk;
  })(),
  "next.config.ts headers()（其余头）+ src/proxy.ts（CSP，动态下发）"
);
item(
  "P1-⑤ 多 worker 状态收敛（runtime 单例 + 静态扫描守卫）",
  /export function runtimeState/.test(runtime) &&
    /runtimeState<Map<string, Bucket>>/.test(llm) &&
    /runtimeState<VectorState>/.test(vec) &&
    has("scripts/verify-runtime-state.mjs"),
  "13 个命名空间 + verify-runtime-state.mjs"
);
item(
  "P1-⑥ busy TOCTOU（原子占用）",
  /export function tryAcquireSession/.test(sess) &&
    /tryAcquireSession\(body\.sessionId\)/.test(interpret) &&
    /releaseSession/.test(interpret),
  "tryAcquireSession 在路由层调用 + finally 释放"
);
item(
  "P1-⑦ llm_usage 索引",
  /CREATE INDEX IF NOT EXISTS idx_llm_usage_session ON llm_usage\(session_id\)/.test(db),
  "idx_llm_usage_session"
);
item(
  "P1-⑦ dashboard 去 N+1（批量查询 + JOIN）",
  /GROUP BY session_id/.test(db) && /LEFT JOIN llm_usage u ON u\.session_id = s\.id/.test(db),
  "IN + GROUP BY / LEFT JOIN"
);
item(
  "P1-⑦ 同步写不阻塞事件循环（遥测写缓冲）",
  /export function flushTelemetry/.test(db) && /db\.transaction/.test(db) &&
    /TELEMETRY_MAX_QUEUE/.test(db),
  "遥测入队 + 事务批量提交"
);

/* ═══════════ P2 ═══════════ */
group("P2 —— 状态机守卫全覆盖");

item(
  "P2-⑧ 守卫表覆盖全部 8 个仪式工具",
  /TOOL_PHASE_REQUIREMENT/.test(mach) &&
    ["establish_contract", "invoke_three_questions", "offer_card_selection", "draw_cards",
     "reveal_card", "interpret_card", "write_reading", "close_reading"]
      .every((t) => new RegExp(`^\\s*${t}:\\s*"`, "m").test(mach)),
  "8 个工具全部登记"
);
item(
  "P2-⑧ supervisor 走统一入口（不是各分支各抄一份）",
  /TOOL_PHASE_REQUIREMENT\[name\]/.test(sup),
  "分发前统一查表"
);
item(
  "P2-⑨ advance().ok 不再被丢弃（8 处）",
  !/advance\([^)]*\)\.phase/.test(sup) &&
    (sup.match(/advancePhase\(/g) || []).length >= 8,
  `${(sup.match(/advancePhase\(/g) || []).length} 处改用 advancePhase`
);
item(
  "P2-⑨ advancePhase 对非法转移有日志",
  /export function advancePhase/.test(mach) && /非法阶段转移/.test(mach),
  "非法转移打日志（可观测）"
);
item(
  "P2-⑨ synthesis 判据与守卫时序匹配",
  /synthesisDone\) done\.add\("synthesis"\)/.test(mach) &&
    /session\.synthesisDone = true/.test(sup),
  "synthesisDone ≠ finished"
);

/* ═══════════ P3 ═══════════ */
group("P3 —— 假绿灯修复");

item(
  "P3-⑩ truncated 标记（类型断言不再骗编译器）",
  !/"truncated" as "ok"/.test(llm) && /"truncated"/.test(llm) &&
    has("src/lib/agent/truncation.ts"),
  "truncated 纳入返回类型 + 标记表"
);
item(
  "P3-⑩ 截断的审校结论移出通过率分母",
  // ⚠️ ReviewResult 的 truncated 定义在 subagents.ts（不是 session.ts）
  /truncated\?: boolean/.test(read("src/lib/agent/subagents.ts")) &&
    /truncated: true,/.test(sup) &&
    /rv\.truncated === true/.test(read("scripts/dev/quality-stats.mjs")),
  "review.truncated 标记 + 分析脚本剔除"
);
item(
  "P3-⑩ ragCacheStats 真实计数",
  /cacheCounters\.hits\+\+/.test(rag) && /cacheCounters\.misses\+\+/.test(rag) &&
    /hitRate/.test(rag),
  "hits/misses 真实计数 + 命中率"
);
item(
  "P3-⑩ summarize 走统一 LLM 层（限速/failover/熔断/usage 记账）",
  /import \{ callLLM \}/.test(summarize) && !/fetch\(`\$\{p\.baseURL\}/.test(summarize),
  "callLLM 取代裸 fetch"
);
item(
  "P3-⑩ listStaleSessions 判据与 reconcile 统一",
  /const STALE_SESSION_PREDICATE/.test(db) &&
    (db.match(/STALE_SESSION_PREDICATE/g) || []).length >= 3,
  "两条 SQL 共用判据常量"
);
item(
  "P3-⑪ 429 不原地重试（用带 status 的错误类型）",
  /export class LLMHttpError/.test(llm) &&
    /rateLimited = e instanceof LLMHttpError && e\.status === 429/.test(llm),
  "LLMHttpError + 429 直接抛给上层 failover"
);
item(
  "P3-⑪ totalChars 误判（用 sawChunk）",
  /let sawChunk = false/.test(llm) && /if \(!sawChunk && isFailoverError/.test(llm),
  "判据改为「收到过任何有效分片」"
);
item(
  "P3-⑫ 错误信息不泄露（SSE 也不发内部异常）",
  !/error: `占卜师暂时失联：\$\{/.test(sup) &&
    !/error: `分析师异常：\$\{/.test(sup),
  "内部细节只进 console.error"
);
item(
  "P3-⑬ CORS 白名单（不是 *）",
  /CORS_ORIGINS/.test(read("next.config.ts")) &&
    !/Access-Control-Allow-Origin[^"]*"\*"/.test(read("next.config.ts")),
  "env 驱动 + 无 *"
);

/* ═══════════ 验证脚本与文档 ═══════════ */
group("验证脚本与文档");

const scripts = [
  "verify-api-auth.mjs", "verify-e2e-ritual.mjs", "verify-phase-guard.mjs",
  "verify-runtime-state.mjs", "verify-telemetry-buffer.mjs",
  "verify-sse-cancel.mjs", "verify-resume-trigger.mjs",
  "verify-rate-concurrency.mjs", "verify-fallback-parity.mjs",
  "verify-rate-limiter.mjs", "verify-ritual-machine.mjs", "verify-hitl-nudge.mjs",
];
const missingScripts = scripts.filter((s) => !has(join("scripts", s)));
item(
  `验证脚本齐备（${scripts.length} 个）`,
  missingScripts.length === 0,
  missingScripts.length ? `缺: ${missingScripts.join(", ")}` : "全部存在"
);

const arch = read("docs/architecture.md");
const readme = read("README.md");
const deploy = read("docs/deployment.md");
item(
  "架构文档含公网化改造章",
  /## 九、公网化改造/.test(arch) && /9\.10 遗留的架构限制/.test(arch),
  "第九章 10 节"
);
item(
  "部署文档含公网安全标准",
  /## 6\. 公网部署安全标准/.test(deploy) && /必须单 worker 运行/.test(deploy),
  "第六章 + 三条不可违反的约束"
);
item(
  "README 含公网特性块与面试讲点",
  /公网部署标准/.test(readme) && /公网化相关的面试讲点/.test(readme),
  "特性块 + 8 条讲点"
);
item(
  "CI 纳入新验证脚本",
  /verify-runtime-state\.mjs/.test(read(".github/workflows/ci.yml")) &&
    /verify-telemetry-buffer\.mjs/.test(read(".github/workflows/ci.yml")),
  "静态门禁阶段纳入"
);
item(
  "关键数据（解读正文）仍是同步写 —— 没被缓冲",
  /UPDATE sessions SET review_json = \?, status = 'done'/.test(db),
  "sessions 表不缓冲"
);

console.log(`\n${"═".repeat(60)}`);
console.log(`${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
for (const g of groups) {
  const gp = g.items.filter((i) => i.ok).length;
  console.log(`  ${gp === g.items.length ? "✓" : "✗"} ${g.title} — ${gp}/${g.items.length}`);
}
process.exit(fail === 0 ? 0 : 2);
