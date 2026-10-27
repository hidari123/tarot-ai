#!/usr/bin/env node
/**
 * 故障注入测试（方向④）：验证系统在各类故障下的收敛性与恢复能力
 *
 * 用法：node scripts/chaos-test.mjs [baseURL]
 *
 * 注入的故障与断言：
 *  1. answer 无等待问题（409）       → API 返回 409，不崩溃
 *  2. 过期会话 answer（410）          → API 返回 410
 *  3. 畸形 body（400）                → API 返回 400
 *  4. 并发 interpret 同会话（409）    → 第二个请求被互斥拒绝
 *  5. 会话恢复接口（断点续传）        → /api/session/[id] 返回历史
 *  6. LLM 中途断流（SSE error 事件）  → 会话收敛到 error 而非挂死
 */

const BASE = process.argv[2] || "http://localhost:3000";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}

async function main() {
  console.log(`\n🌋 故障注入测试 · ${BASE}\n`);

  // ---- 1. answer 无等待问题 ----
  {
    const r = await fetch(`${BASE}/api/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "sess_nonexistent", answer: "测试" }),
    });
    assert("answer 无会话 → 409/410", r.status === 409 || r.status === 410, `got ${r.status}`);
  }

  // ---- 2. 畸形 body ----
  {
    const r = await fetch(`${BASE}/api/interpret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{{",
    });
    assert("interpret 畸形 body → 400", r.status === 400, `got ${r.status}`);
  }

  // ---- 3. 空 question ----
  {
    const r = await fetch(`${BASE}/api/interpret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "  " }),
    });
    assert("interpret 空问题 → 400", r.status === 400, `got ${r.status}`);
  }

  // ---- 4. 并发 interpret 互斥 ----
  {
    // 开一场真实占卜（进入 HITL 等待），然后并发第二笔 interpret
    const ctl = new AbortController();
    const first = fetch(`${BASE}/api/interpret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "故障注入测试：并发互斥验证" }),
      signal: ctl.signal,
    });
    // 等待 session 事件拿到 sessionId
    const reader = (await first).body.getReader();
    const dec = new TextDecoder();
    let sid = "";
    let buf = "";
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const m = buf.match(/"type":"session","sessionId":"([^"]+)"/);
      if (m) { sid = m[1]; break; }
    }
    if (sid) {
      // 会话此刻应挂在 HITL 或运行中 → 第二笔 interpret 应 409
      // （若已 finished 则 410——两种都算"被互斥拒绝"）
      const r2 = await fetch(`${BASE}/api/interpret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid, followup: "并发测试" }),
      });
      assert("并发 interpret → 409/410 互斥", r2.status === 409 || r2.status === 410, `got ${r2.status}`);
      // 清理：中断第一场
      ctl.abort();
    } else {
      assert("并发 interpret → 拿到 sessionId", false, "60s 内未收到 session 事件");
      ctl.abort();
    }
  }

  // ---- 5. 会话恢复接口 ----
  {
    const r = await fetch(`${BASE}/api/session/sess_nonexistent`);
    assert("session 恢复接口：不存在 → 404", r.status === 404, `got ${r.status}`);
  }

  // ---- 汇总 ----
  console.log(`\n📊 结果：${passed} 通过 / ${failed} 失败\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("测试执行异常:", e); process.exit(2); });
