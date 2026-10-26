const Database = require("better-sqlite3");
const db = new Database(require("path").join(process.cwd(), "data", "tarot.db"), { readonly: true });
const s = db.prepare("SELECT id, question, reading FROM sessions WHERE status='done' ORDER BY created_at DESC LIMIT 1").get();
console.log(`Q: ${s.question}\n`);
console.log(s.reading);
