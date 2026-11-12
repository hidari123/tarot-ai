/**
 * 验证 SSE 帧解析（splitSseFrames）
 *
 * ⚠️ 为什么这个函数值得单测：
 *   · SSE 是**分块传输**的 → 一帧可能被切成多个 chunk 到达
 *   · 帧格式是**多行**的（`id:` + `data:`）→ 旧实现只认 data 行 → id 丢失
 *   · 这是整个 SSE 链路最容易出错的地方 → 用测试钉住行为 ✅
 */
import { splitSseFrames } from "../src/features/divination/useSseParser";

let passed = 0;
let failed = 0;

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

console.log("SSE 帧解析");

/* ---------- ① 基本切帧 ---------- */
{
  const { frames, remainder } = splitSseFrames(
    'id: 1\ndata: {"a":1}\n\nid: 2\ndata: {"b":2}\n\n'
  );
  check("切出 2 帧", frames.length === 2, `实际 ${frames.length}`);
  check("第 1 帧 seq=1", frames[0]?.seq === 1);
  check("第 1 帧 data 正确", frames[0]?.data === '{"a":1}', frames[0]?.data);
  check("第 2 帧 seq=2", frames[1]?.seq === 2);
  check("remainder 为空", remainder === "", `实际 "${remainder}"`);
}

/* ---------- ② 不完整的尾帧要留在 remainder ---------- */
{
  const { frames, remainder } = splitSseFrames(
    'id: 1\ndata: {"a":1}\n\nid: 2\ndata: {"b":'
  );
  check("只切出 1 帧", frames.length === 1, `实际 ${frames.length}`);
  check(
    "半帧留在 remainder",
    remainder === 'id: 2\ndata: {"b":',
    `实际 "${remainder}"`
  );
}

/* ---------- ③ 分块到达（模拟网络切片）---------- */
{
  // 同一帧被切成 3 个 chunk
  const chunks = ['id: 7\nda', 'ta: {"x":', '1}\n\n'];
  let buf = "";
  const all = [];
  for (const c of chunks) {
    buf += c;
    const { frames, remainder } = splitSseFrames(buf);
    all.push(...frames);
    buf = remainder;
  }
  check("分块拼接后得到 1 帧", all.length === 1, `实际 ${all.length}`);
  check("分块后 seq 仍正确", all[0]?.seq === 7, `实际 ${all[0]?.seq}`);
  check("分块后 data 完整", all[0]?.data === '{"x":1}', all[0]?.data);
}

/* ---------- ④ 没有 id 行 → seq = 0 ---------- */
{
  const { frames } = splitSseFrames('data: {"a":1}\n\n');
  check("无 id 行时 seq=0", frames[0]?.seq === 0);
  check("无 id 行时 data 仍解析", frames[0]?.data === '{"a":1}');
}

/* ---------- ⑤ 注释行 / 心跳要跳过 ---------- */
{
  const { frames } = splitSseFrames(': ping\n\ndata: {"a":1}\n\n');
  check("注释行被跳过", frames.length === 1, `实际 ${frames.length}`);
  check("剩下的是有效帧", frames[0]?.data === '{"a":1}');
}

/* ---------- ⑥ CRLF 换行也要能切 ---------- */
{
  const { frames, remainder } = splitSseFrames(
    'id: 3\r\ndata: {"a":1}\r\n\r\nid: 4\r\ndata: {"b":2}\r\n\r\n'
  );
  check("CRLF 切出 2 帧", frames.length === 2, `实际 ${frames.length}`);
  check("CRLF 第 1 帧 seq=3", frames[0]?.seq === 3);
  check("CRLF 第 2 帧 seq=4", frames[1]?.seq === 4);
  check("CRLF remainder 为空", remainder === "", `实际 "${remainder}"`);
}

/* ---------- ⑦ 空输入 ---------- */
{
  const { frames, remainder } = splitSseFrames("");
  check("空输入 → 0 帧", frames.length === 0);
  check("空输入 → remainder 空", remainder === "");
}

/* ---------- ⑧ data 行有前导空格也要能取 ---------- */
{
  const { frames } = splitSseFrames('id: 9\ndata:   {"a":1}   \n\n');
  check("data 值已 trim", frames[0]?.data === '{"a":1}', frames[0]?.data);
}

/* ---------- ⑨ 多行 data 只取最后一个（后覆盖前）---------- */
{
  const { frames } = splitSseFrames('id: 1\ndata: {"a":1}\ndata: {"b":2}\n\n');
  check("多行 data 取最后一个", frames[0]?.data === '{"b":2}', frames[0]?.data);
}

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
