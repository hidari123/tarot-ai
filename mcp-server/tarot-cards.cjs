/**
 * MCP Server 用的独立牌库（从 src/data 直接读取，无 TS alias 依赖）
 * 由 src/lib/tarot-cards.ts 的逻辑移植而来（保持同步）
 */

const rawCards = require("../src/data/tarot-lab-cards.json");

const SUIT_MAP = { wands: "wands", cups: "cups", swords: "swords", pents: "pentacles" };
const ELEMENT_BY_SUIT = {
  major: "灵（Spirit）",
  wands: "火（Fire）",
  cups: "水（Water）",
  swords: "风（Air）",
  pentacles: "土（Earth）",
};

function classify(link, nameEn) {
  const minorMatch = nameEn.match(/^(Ace|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Page|Knight|Queen|King)\s+of\s+(Wands|Cups|Swords|Pentacles)/);
  if (minorMatch) {
    const numMap = { Ace: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9, Ten: 10, Page: 11, Knight: 12, Queen: 13, King: 14 };
    const suit = { Wands: "wands", Cups: "cups", Swords: "swords", Pentacles: "pentacles" }[minorMatch[2]];
    return { suit, number: numMap[minorMatch[1]] };
  }
  const majorOrder = ["Fool","Magician","High_Priestess","Empress","Emperor","Hierophant","Lovers","Chariot","Strength","Hermit","Wheel_of_Fortune","Justice","Hanged_Man","Death","Temperance","Devil","Tower","Star","Moon","Sun","Judgement","World"];
  const base = link.replace(/\.jpg$/i, "");
  const idx = majorOrder.indexOf(base);
  return { suit: "major", number: idx >= 0 ? idx : 99 };
}

function extractKeywords(normal, reversed) {
  const all = (normal + "，" + reversed).split(/[，,、]/).map((s) => s.trim()).filter((s) => s.length >= 2 && s.length <= 8);
  return Array.from(new Set(all)).slice(0, 6);
}

const seen = new Set();
const TAROT_CARDS = rawCards
  .filter((c) => { if (seen.has(c.link)) return false; seen.add(c.link); return true; })
  .map((c) => {
    const zhMatch = c.name.match(/[\u4e00-\u9fff][\u4e00-\u9fffA-Za-z0-9]*$/);
    const nameZh = zhMatch ? zhMatch[0] : c.name;
    const nameEn = c.name.slice(0, c.name.length - nameZh.length).trim();
    const { suit, number } = classify(c.link, nameEn);
    return {
      id: c.link.replace(/\.jpg$/i, ""),
      name: c.name, nameZh, nameEn, number, suit,
      element: ELEMENT_BY_SUIT[suit],
      description: c.description,
      upright: c.normal,
      reversed: c.reversed,
      keywords: extractKeywords(c.normal, c.reversed),
      image: `/images/cards/${c.link}`,
    };
  });

function drawCards(n) {
  const pool = [...TAROT_CARDS];
  const drawn = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    const card = pool.splice(idx, 1)[0];
    drawn.push({ card, reversed: Math.random() < 0.35 });
  }
  return drawn;
}

module.exports = { TAROT_CARDS, drawCards };
