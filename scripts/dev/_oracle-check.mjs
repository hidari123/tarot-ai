import Database from "better-sqlite3";
const db = new Database("data/tarot.db", { readonly: true });
const rows = db.prepare(`SELECT id, question, created_at, state_json FROM sessions ORDER BY created_at DESC LIMIT 2`).all();
for (const r of rows) {
  const st = r.state_json ? JSON.parse(r.state_json) : {};
  console.log("会话:", r.id, "|", String(r.question).slice(0, 40));
  console.log("  kind:", st.kind, "| messages:", (st.messages ?? []).length, "| phase:", st.ritualPhase);
  console.log("  最后 3 条消息:");
  for (const m of (st.messages ?? []).slice(-3)) {
    console.log("   ", m.role, "|", String(m.content ?? "").slice(0, 150).replace(/\n/g, " "));
  }
}
db.close();
