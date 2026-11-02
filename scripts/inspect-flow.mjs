import Database from "better-sqlite3";
const db = new Database("data/tarot.db");
const rows = db.prepare("SELECT id, question, created_at FROM sessions ORDER BY created_at DESC LIMIT 4").all();
for (const x of rows) {
  console.log(`=== ${new Date(x.created_at).toLocaleString("zh-CN")} | ${x.question.slice(0, 24)}`);
  const ev = db.prepare(
    `SELECT seq, type, payload_json FROM event_log
     WHERE session_id = ? AND type IN ('tool','ask_user','cards','card_reveal','card_reading','contract','invocation')
     ORDER BY seq`
  ).all(x.id);
  for (const e of ev) {
    let p = {};
    try { p = JSON.parse(e.payload_json); } catch { /* ignore */ }
    const label = p.tool?.name || p.ask?.kind || (p.cards ? `cards:${p.cards.length}` : "") || p.contract ? "contract" : p.invocation ? "invocation" : "";
    console.log(`   ${e.type.padEnd(12)} ${label}`);
  }
}
