import { execFileSync } from "node:child_process";

/**
 * ⚠️ 8 张写实卡片插画 —— 第 2 轮 × **3 个风格方向** = 24 张
 *
 * ⚠️⚠️ 用户反馈（第 1 轮）：
 *   「你这个颜色太偏紫色了 会看不清楚的 金色吧」
 *   「人给一点人物啊，你这太抽象了」
 *   「多出几版我看看 别只出一版」
 *
 * ⚠️ 三个方向（都：金色主调 + 有人物 + 3:4 竖版）
 *   A. **蜜金油画** —— 蜂蜜金/黄铜/赭石，古典人物，暖光
 *   B. **暗金舞台** —— 更暗的背景（深棕+烛光），人物更突出
 *   C. **流金星云** —— 星空/银河感但偏金，人物在星光中
 */

const CARDS = [
  {
    id: "love",
    scene:
      "a woman and a man standing facing each other in warm golden light, seen in three-quarter view, " +
      "their faces softly lit and clearly recognizable, wearing flowing classical robes, " +
      "her hand reaching toward him, tender intimate moment",
  },
  {
    id: "career",
    scene:
      "a determined traveler in a hooded cloak standing on a rocky summit, seen from behind but clearly human, " +
      "golden morning light on the horizon, a vast valley of clouds below, a road leading forward",
  },
  {
    id: "wealth",
    scene:
      "a merchant in fine classical robes weighing gold coins in one hand, a golden balance scale on the table beside him, " +
      "clearly visible face, warm golden candlelight",
  },
  {
    id: "crossroads",
    scene:
      "a lone traveler in a long coat and hat standing at a fork in a golden dirt road, seen from behind, " +
      "clearly human silhouette, two diverging paths glowing warm gold",
  },
  {
    id: "tides",
    scene:
      "a woman with long flowing hair standing waist-deep in golden-lit ocean waves at dusk, " +
      "clearly visible face and shoulders, wind in her hair, a huge warm golden moon low on the horizon",
  },
  {
    id: "morning",
    scene:
      "a young person standing on a hilltop watching a golden sunrise over a sea of clouds, " +
      "clearly visible person in silhouette with warm rim light, brilliant golden sun with spreading rays",
  },
  {
    id: "kindred",
    scene:
      "two friends in simple cloaks sitting side by side on a stone ledge, seen from behind, " +
      "clearly human figures, a glowing golden vine curling around the stone, golden dusk over a valley",
  },
  {
    id: "whispers",
    scene:
      "a mysterious hooded seer with a clearly visible pale face looking up in awe, " +
      "a giant mystical golden eye opening in the swirling sky above them, golden dust streaming down",
  },
];

/** 三个风格方向 */
const VARIANTS = [
  {
    tag: "A",
    desc: "蜜金油画（暖亮）",
    extra:
      "honey gold, brass, ochre, cream and deep warm brown palette, bright golden hour light, " +
      "luminous and warm overall, soft glowing atmosphere",
    neg: "",
  },
  {
    tag: "B",
    desc: "暗金舞台（深底烛光）",
    extra:
      "dark chocolate brown and antique brass palette, single warm candle-like golden light source, " +
      "strong contrast, deep shadows, moody and intimate, chiaroscuro like a Rembrandt painting",
    neg: "",
  },
  {
    tag: "C",
    desc: "流金星云（夜空金光）",
    extra:
      "golden nebula and swirling gold dust in a dark sky, warm gold and amber light, " +
      "celestial and dreamlike, sparkling golden particles, the figure lit by golden starlight",
    neg: "",
  },
];

const COMMON =
  "classical oil painting with rich visible brush strokes, " +
  "NOT purple, NOT violet, NOT blue, " +
  "romantic esoteric occult mysticism, atmospheric golden haze, " +
  "clearly rendered human figures with recognizable faces and anatomy, " +
  "highly detailed, museum quality old master painting, " +
  "NO text, NO letters, NO words, NO writing, NO signature, NO watermark, " +
  "NO frame, NO border, NO split panels, NO collage";

const JOBS = [];
for (const v of VARIANTS) {
  for (const c of CARDS) {
    JOBS.push({
      file: `shots/c${v.tag}-${c.id}.jpg`,
      prompt: `${c.scene}, ${v.extra}, ${COMMON}`,
    });
  }
}

for (const j of JOBS) {
  try {
    const out = execFileSync(
      "node",
      ["scripts/dev/gen-image-ref.mjs", j.prompt, "shots/nt6.jpg", j.file, "3:4"],
      { encoding: "utf-8" }
    );
    console.log(out.trim());
  } catch (e) {
    console.log("✗ " + j.file + " " + (e.stdout || "") + (e.stderr || "").slice(0, 100));
  }
}
