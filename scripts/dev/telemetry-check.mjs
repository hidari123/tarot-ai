/**
 * 遥测落库核查（诊断工具，无断言 —— 用完即弃）
 *
 * ⚠️ 判读要小心（第一版误报了）：
 *   简单的"usage=0 就说遥测缺失"是**错的** ——
 *   用户中途关页面（client_disconnect）的会话本来就只有 1 次 LLM 调用，
 *   甚至降级路径（本地剧本引擎）一场都不调 LLM → usage=0 是**正确**的。
 *
 *   正确的判据是**内部一致性**：
 *   "有 LLM 用量但没有工具调用记录"才是矛盾（usage>1 且 tools=0）。
 */
import Database from "better-sqlite3";
const db = new Database("data/tarot.db");

const rows = db.prepare(`
  SELECT s.id, s.status, s.error_reason, s.created_at,
    (SELECT COUNT(*) FROM llm_usage u WHERE u.session_id = s.id) usage,
    (SELECT COUNT(*) FROM tool_calls t WHERE t.session_id = s.id) tools,
    (SELECT COUNT(*) FROM session_timings g WHERE g.session_id = s.id) timings
  FROM sessions s ORDER BY s.created_at DESC LIMIT 5
`).all();

console.log("最近 5 场会话的遥测落库情况：");
for (const r of rows) {
  console.log(
    `  ${r.id.slice(0, 16)} ${r.status.padEnd(5)} ${(r.error_reason || "-").padEnd(18)}` +
    ` usage=${String(r.usage).padStart(3)} tools=${String(r.tools).padStart(3)} timings=${String(r.timings).padStart(3)}`
  );
}

/** ⚠️ 真正的矛盾：有 LLM 用量（>1 次调用）却没有工具调用记录 */
const contradiction = db.prepare(`
  SELECT COUNT(*) c FROM sessions s
  WHERE (SELECT COUNT(*) FROM llm_usage u WHERE u.session_id = s.id) > 1
    AND (SELECT COUNT(*) FROM tool_calls t WHERE t.session_id = s.id) = 0
`).get().c;

console.log(contradiction === 0
  ? "\n✅ 没有会话出现「有 LLM 用量但没有工具调用记录」的矛盾 → 写缓冲没有丢数据"
  : `\n❌ 有 ${contradiction} 场会话遥测自相矛盾（写缓冲可能丢数据）`);

const total = db.prepare("SELECT COUNT(*) c FROM llm_usage").get().c;
console.log(`llm_usage 总行数：${total}`);
db.close();
