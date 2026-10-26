/**
 * 健壮 JSON 解析器 —— 专门用于解析 LLM 输出的结构化结果
 *
 * 背景：审校者要求输出 JSON，但 LLM 常犯这些错：
 *   ① 包在 markdown 代码块里（```json ... ```）
 *   ② 前后加说明文字（"好的，我的评分如下："）
 *   ③ 用中文引号（“grounding”: 8）
 *   ④ 单引号（{'pass': true}）
 *   ⑤ 尾随逗号（{"a":1,}）
 *   ⑥ 输出多个 JSON 对象
 *
 * 三级策略：
 *   L1 直接 JSON.parse（最理想）
 *   L2 提取首个平衡括号块（正确处理嵌套与字符串内的括号）
 *   L3 逐字段正则兜底（只捞需要的字段）
 */

export interface ParsedResult<T> {
  ok: boolean;
  data?: T;
  /** 使用的解析级别：1=直接解析 2=括号提取 3=正则兜底 0=失败 */
  level: 0 | 1 | 2 | 3;
  error?: string;
}

/** 提取第一个完整的平衡括号块（正确跳过字符串内的括号与转义） */
export function extractFirstJSONBlock(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // 未闭合
}

/** 修复常见 JSON 语法问题：中文引号、单引号、尾随逗号 */
function normalizeJSON(text: string): string {
  return text
    .replace(/[“”]/g, '"')   // 中文双引号 → 英文
    .replace(/[‘’]/g, "'")    // 中文单引号 → 英文
    .replace(/,\s*([}\]])/g, "$1") // 尾随逗号
    .replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":')  // 单引号键
    .replace(/:\s*'([^']*)'/g, ': "$1"');           // 单引号值
}

/**
 * 三级解析：优先严格 JSON，其次括号提取，最后正则兜底
 * @param fieldExtractors L3 阶段使用的字段提取器
 */
export function parseLLMJSON<T>(
  raw: string,
  fieldExtractors: (text: string) => Partial<T> | null
): ParsedResult<T> {
  if (!raw || !raw.trim()) {
    return { ok: false, level: 0, error: "输出为空" };
  }

  // ---- L1: 直接解析 ----
  try {
    const data = JSON.parse(raw.trim());
    if (data && typeof data === "object") return { ok: true, data: data as T, level: 1 };
  } catch { /* 继续 */ }

  // ---- L2: 提取平衡括号块 + 规范化 ----
  const block = extractFirstJSONBlock(raw);
  if (block) {
    try {
      const data = JSON.parse(normalizeJSON(block));
      if (data && typeof data === "object") return { ok: true, data: data as T, level: 2 };
    } catch { /* 继续 */ }
  }

  // ---- L2.5: 只取第一行（有些模型第一行是 JSON，后续是说明） ----
  const firstLine = raw.trim().split("\n")[0]?.trim();
  if (firstLine && firstLine.includes("{")) {
    try {
      const data = JSON.parse(normalizeJSON(firstLine));
      if (data && typeof data === "object") return { ok: true, data: data as T, level: 2 };
    } catch { /* 继续 */ }
  }

  // ---- L3: 正则逐字段兜底 ----
  if (fieldExtractors) {
    const partial = fieldExtractors(raw);
    if (partial && Object.keys(partial).length > 0) {
      return { ok: true, data: partial as T, level: 3 };
    }
  }

  return {
    ok: false,
    level: 0,
    error: `无法解析（前 120 字：${raw.trim().slice(0, 120)}）`,
  };
}

/** 从文本中提取 0~10 的整数评分（用于 L3 兜底） */
export function extractScore(text: string, field: string): number | undefined {
  // 优先匹配带引号的键："grounding": 8  或  "grounding"：8
  const quoted = new RegExp(`["'${field}"'\\s*[:：]\\s*(\\d+)`, "i").exec(text);
  if (quoted) return Math.min(10, Math.max(0, parseInt(quoted[1], 10)));
  // 退而求其次：grounding 8 / grounding：8
  const loose = new RegExp(`${field}\\s*[:：=]\\s*(\\d+)`, "i").exec(text);
  if (loose) return Math.min(10, Math.max(0, parseInt(loose[1], 10)));
  return undefined;
}

/** 从文本中提取字符串值（用于 L3 兜底） */
export function extractString(text: string, field: string): string | undefined {
  const m = new RegExp(`["']${field}["']\\s*[:：]\\s*["']([^"']{0,600})["']`, "i").exec(text);
  return m ? m[1] : undefined;
}

/** 从文本中提取布尔值 */
export function extractBool(text: string, field: string): boolean | undefined {
  const m = new RegExp(`["']${field}["']\\s*[:：]\\s*(true|false|是|否|通过|不通过)`, "i").exec(text);
  if (!m) return undefined;
  const v = m[1].toLowerCase();
  return v === "true" || v === "是" || v === "通过";
}
