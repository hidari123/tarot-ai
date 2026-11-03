import Database from "better-sqlite3";
const db = new Database("data/tarot.db");
const x = db.prepare("SELECT id, question FROM sessions ORDER BY created_at DESC LIMIT 1").get();
console.log(`会话: ${x.question}\n`);
const ev = db.prepare("SELECT seq, type, payload_json FROM event_log WHERE session_id = ? ORDER BY seq").all(x.id);
for (const e of ev) {
  let p = {};
  try { p = JSON.parse(e.payload_json); } catch { /* ignore */ }
  let detail = "";
  if (e.type === "phase") detail = p.phase + " | " + (p.label ?? "");
  else if (e.type === "ask_user") detail = `kind=${p.ask?.kind ?? "-"} q="${String(p.ask?.question ?? "").slice(0, 34)}"`;
  else if (e.type === "tool") detail = `${p.tool?.name} → ${String(p.tool?.resultSummary ?? "").slice(0, 40)}`;
  else if (e.type === "cards") detail = `count=${p.cards?.length}`;
  else if (e.type === "subagent") detail = `${p.subagent?.agent}/${p.subagent?.role ?? ""}`;
  console.log(`  ${String(e.seq).padStart(2)} ${e.type.padEnd(14)} ${detail}`);
}
