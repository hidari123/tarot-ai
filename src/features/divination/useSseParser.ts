/**
 * SSE 帧解析（2026-11-12 拆分自 src/app/page.tsx）
 *
 * ⚠️⚠️ 为什么抽出来：
 *   · SSE 帧解析是**纯函数**（输入字符串 → 输出事件数组）→ 零 React 依赖
 *   · 之前它埋在 consumeStream（461 行）里 → 无法单独测试
 *   → 抽出来后可单测 ✅（协议解析是最容易出错的地方）
 *
 * ⚠️⚠️ SSE 帧格式（为什么要按行解析而不是 split("\n\n") 直接用）：
 *   ```
 *   id: 42
 *   data: {"type":"phase","phase":"draw"}
 *   ```
 *   · 一帧可能含**多行**：`id:` + `data:`
 *   · 旧实现只认 data: 行 → **id 被丢弃** → 断点续传无从谈起 ❌
 *   → 必须逐行扫描，分别取 id 与 data ✅
 */

/** 从一段 SSE 原始文本里抽出的一帧 */
export interface SseFrame {
  /** 事件序号（用于断点续传；没有 id 行时为 0） */
  seq: number;
  /** data 行的内容（JSON 字符串）；没有 data 行时为空串 */
  data: string;
}

/**
 * 从缓冲区里切出**完整的** SSE 帧
 *
 * @param buffer 已累积的文本（可能含半个帧）
 * @returns 切出的帧 + 剩余的不完整缓冲
 *
 * ⚠️ SSE 的帧分隔符是 `\n\n`（也可能 `\r\n\r\n`）
 * ⚠️ 为什么返回剩余缓冲而不是就地修改：
 *   · 纯函数 → 可单测 ✅
 *   · 调用方负责把 remainder 拼回下一次读到的 chunk ✅
 */
export function splitSseFrames(buffer: string): {
  frames: SseFrame[];
  remainder: string;
} {
  /** 归一化换行：\r\n → \n（避免 CRLF 的 SSE 被切错） */
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  /** 最后一段是"还没收全"的 → 留给下一次 */
  const remainder = parts.pop() ?? "";

  const frames: SseFrame[] = [];
  for (const part of parts) {
    let seq = 0;
    let dataLine = "";
    for (const raw of part.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("id:")) {
        seq = Number(line.slice(3).trim()) || 0;
      } else if (line.startsWith("data:")) {
        dataLine = line.slice(5).trim();
      }
    }
    /** 没有 data 行 → 不是有效事件帧 → 跳过（如注释行 `: ping`） */
    if (!dataLine) continue;
    frames.push({ seq, data: dataLine });
  }

  return { frames, remainder };
}
