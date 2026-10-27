/** 测试 /api/summarize：用最近的 done 会话 */
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const cwd = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(cwd, "..", "data", "tarot.db"), { readonly: true });

const r = db.prepare("SELECT id, reading FROM sessions WHERE status='done' AND length(reading)>100 ORDER BY created_at DESC LIMIT 1").get();
console.log("session:", r.id, "| reading:", r.reading.length, "chars\n");

const res = await fetch("http://localhost:3000/api/summarize", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sessionId: r.id, reading: r.reading }),
});
console.log("HTTP", res.status);
const j = await res.json();
if (j.summary) {
  console.log(`\n=== 总结（${j.length} 字）===`);
  console.log(j.summary);
} else {
  console.log("error:", j.error);
}
