#!/usr/bin/env node
/**
 * 诊断：尝试用 Node 的 fetch 抓取竞品站点（不同 TLS/网络栈）
 *
 * ⚠️ 用法：npx tsx scripts/dev/fetch-competitors.mjs
 */
const TARGETS = [
  ["tarot.run", "https://tarot.run/zh"],
  ["tarot-tap", "https://www.tarot-tap.com/"],
  ["tarotoo", "https://tarotoo.com/"],
  ["tarotap", "https://tarotap.com/"],
  ["tarotwhisper", "https://tarotwhisper.org/"],
  ["deararcana", "https://deararcana.com/"],
  ["biddytarot", "https://biddytarot.com/"],
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

for (const [name, url] of TARGETS) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(t);
    const body = await res.text();
    console.log(`${name.padEnd(14)} -> HTTP ${res.status} · ${body.length} bytes · ${res.url}`);
  } catch (e) {
    console.log(`${name.padEnd(14)} -> FAIL: ${String(e.message || e).slice(0, 90)}`);
  }
}
