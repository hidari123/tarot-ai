import Database from "better-sqlite3";
const db = new Database("data/tarot.db");
const r = db.prepare(
  "SELECT id, question, length(reading) len FROM sessions WHERE status = 'done' AND length(reading) > 200 ORDER BY created_at DESC LIMIT 1"
).get();
console.log(r ? `${r.id}\t${r.len}\t${r.question.slice(0, 24)}` : "NONE");
