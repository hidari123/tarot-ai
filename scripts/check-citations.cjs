/** 检查最近几个 done 会话的解读里是否有引文标记 [n] 或「典籍有云」 */
const Database = require("better-sqlite3");
const db = new Database(require("path").join(process.cwd(), "data", "tarot.db"), { readonly: true });

const rows = db.prepare(`
  SELECT id, status, error_reason, question, reading, created_at
  FROM sessions ORDER BY created_at DESC LIMIT 8
`).all();

for (const s of rows) {
  const r = s.reading ?? "";
  const hasCite = /\[\d+\]/.test(r) || r.includes("典籍有云");
  const ageMin = Math.round((Date.now() - s.created_at) / 60000);
  console.log(`[${s.status}]${s.error_reason ? `(${s.error_reason})` : ""} ${ageMin}min前 | 引文:${hasCite ? "✓" : "✗"} | ${r.length}字 | ${s.question}`);
  if (s.status === "done" && !hasCite) {
    console.log(`  --- 解读前200字 ---`);
    console.log("  " + r.slice(0, 200));
    console.log();
  }
}
