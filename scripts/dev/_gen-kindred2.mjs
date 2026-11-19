import { execFileSync } from "node:child_process";

/**
 * ⚠️ 「故人」新意象 —— 出 8 个候选让用户挑
 *
 * ⚠️ 用户反馈：「故人这个三个绳结意象不够漂亮 有没有别的意象 出一些icon」
 * ⚠️ 已排除：手（AI 画不好）、绳结（不够漂亮）、双环（已用但想换）
 *
 * ⚠️ 语义 = 「朋友、同事与距离」→ 关键词：联结、羁绊、同行、陪伴
 */

const CANDIDATES = [
  {
    file: "shots/kk1.jpg",
    motif:
      "two simple birds facing each other on a branch, drawn as clean thick outlined silhouettes, " +
      "only two shapes, very simple and minimal",
  },
  {
    file: "shots/kk2.jpg",
    motif:
      "two trees standing side by side with their canopies touching, drawn as clean thick outlined shapes, " +
      "only two shapes, very simple and minimal",
  },
  {
    file: "shots/kk3.jpg",
    motif:
      "a single elegant arch bridge with two small towers, drawn as clean thick outlined lines, " +
      "completely hollow, very simple and minimal",
  },
  {
    file: "shots/kk4.jpg",
    motif:
      "two overlapping simple leaf shapes forming a heart-like symmetry, drawn as clean thick outlined shapes, " +
      "completely hollow, very simple and minimal",
  },
  {
    file: "shots/kk5.jpg",
    motif:
      "two simple keys crossed diagonally, drawn as clean thick outlined lines, " +
      "completely hollow, very simple and minimal",
  },
  {
    file: "shots/kk6.jpg",
    motif:
      "a single open door with warm light glowing from it, drawn as clean thick outlined lines, " +
      "completely hollow, very simple and minimal",
  },
  {
    file: "shots/kk7.jpg",
    motif:
      "two simple lighthouse beams crossing in the night sky, drawn as clean thick outlined lines, " +
      "completely hollow, very simple and minimal",
  },
  {
    file: "shots/kk8.jpg",
    motif:
      "a single rope loop tied in a beautiful flowing figure eight, drawn as clean thick outlined lines, " +
      "completely hollow, very simple and minimal",
  },
];

const STYLE =
  "flat 2D vector icon, completely flat with no volume no shading no 3d, " +
  "single flat antique gold color on flat solid deep purple background, " +
  "bold uniform thick stroke weight, only two or three big rounded shapes, " +
  "the shape floats alone in the exact center with completely empty deep purple space on all four sides, " +
  "the shape is NOT inside a frame, NOT inside a rectangle, NOT inside a square, NOT inside a circle, NOT inside a badge, " +
  "there is absolutely nothing else in the picture besides the single shape, " +
  "no border, no outline box, no decorative corners, no solid filled big shapes, " +
  "no text, no letters, no people, no hands, no fingers, " +
  "no thin lines, no fine details, no gradient, no shadow, no glow";

for (const c of CANDIDATES) {
  try {
    const out = execFileSync(
      "node",
      ["scripts/dev/gen-image-ref.mjs", `${c.motif}, ${STYLE}`, "shots/nt6.jpg", c.file, "1:1"],
      { encoding: "utf-8" }
    );
    console.log(out.trim());
  } catch (e) {
    console.log("✗ " + c.file + " " + (e.stdout || "") + (e.stderr || "").slice(0, 100));
  }
}
