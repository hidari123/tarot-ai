import Database from "better-sqlite3";
const db = new Database("data/tarot.db", { readonly: true });
const rows = db.prepare("SELECT cache_key, LENGTH(payload_json) len FROM fortune_cache").all();
console.log("fortune_cache 条目:", rows.length);
for (const r of rows) console.log(" -", r.cache_key, r.len, "bytes");
db.close();
