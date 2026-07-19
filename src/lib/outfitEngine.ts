/*
  outfitEngine
  ------------
  Deterministic outfit generation — runs entirely in the browser.

  Replaces the generate-outfits edge function (and its LLM call): candidate
  combos are enumerated from the wardrobe, hard-filtered (season, formality,
  pattern balance), then scored on color harmony in CIELAB using the exact
  hex colors extracted from the garment pixels. Same wardrobe + occasion
  always produces the same ranked outfits; "Style Me" again rotates through
  the next-best looks. Zero API usage, <50ms even for large wardrobes.
*/

import type { ClothingItem, GeneratedOutfit } from "./supabase";
import { hexForColorName } from "./imageTools";

// ---------------------------------------------------------------------------
// Attribute tables (the taste rules that used to live in the LLM prompt)
// ---------------------------------------------------------------------------

const FORMALITY: Record<string, number> = {
  sporty: 1,
  streetwear: 2,
  casual: 2,
  "smart casual": 3,
  business: 4,
  formal: 5,
};

const OCCASION_FORMALITY: Record<string, number> = {
  casual: 2,
  weekend: 2,
  date: 3,
  work: 4,
  formal: 5,
};

// How loud a pattern is; at most one "loud" (>=2) piece per outfit.
const PATTERN_LOUDNESS: Record<string, number> = {
  solid: 0,
  striped: 1,
  checked: 1,
  plaid: 2,
  floral: 2,
  graphic: 2,
  printed: 2,
};

function formalityOf(item: ClothingItem): number {
  return FORMALITY[item.style?.toLowerCase() ?? ""] ?? 3;
}

function loudnessOf(item: ClothingItem): number {
  return PATTERN_LOUDNESS[item.pattern?.toLowerCase() ?? ""] ?? 1;
}

function seasonsCompatible(a: string | null, b: string | null): boolean {
  const sa = a?.toLowerCase() || "all-season";
  const sb = b?.toLowerCase() || "all-season";
  if (sa === "all-season" || sb === "all-season" || sa === sb) return true;
  // spring and fall are both mid-weight seasons; they mix fine.
  const mid = new Set(["spring", "fall"]);
  return mid.has(sa) && mid.has(sb);
}

// ---------------------------------------------------------------------------
// Color harmony (LCh hue relationships on real pixel hexes)
// ---------------------------------------------------------------------------

interface Lch {
  l: number;
  c: number;
  h: number; // degrees
}

function hexToLch(hex: string): Lch | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const r = parseInt(m[1].slice(0, 2), 16) / 255;
  const g = parseInt(m[1].slice(2, 4), 16) / 255;
  const b = parseInt(m[1].slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const rl = lin(r), gl = lin(g), bl = lin(b);
  let x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
  let y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722;
  let z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  const L = 116 * y - 16;
  const A = 500 * (x - y);
  const B = 200 * (y - z);
  const C = Math.sqrt(A * A + B * B);
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { l: L, c: C, h: H };
}

function primaryLch(item: ClothingItem): Lch | null {
  const hex =
    item.colors && item.colors.length > 0
      ? item.colors[0].hex
      : hexForColorName(item.primary_color);
  return hex ? hexToLch(hex) : null;
}

function isNeutral(c: Lch): boolean {
  return c.c < 14 || c.l > 92 || c.l < 12;
}

function hueDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// 0..100 for a pair of garments. Monochrome/tonal/neutral pairings score high
// on purpose — that matches the house taste rules, not a bug.
function colorPairScore(a: Lch | null, b: Lch | null): number {
  if (!a || !b) return 72; // unknown color: neutral-ish assumption
  const na = isNeutral(a), nb = isNeutral(b);
  if (na && nb) return 90; // all-neutral (all-black, grey+white, …) is timeless
  if (na || nb) return 86; // neutral anchors any color
  const d = hueDelta(a.h, b.h);
  if (d < 20) return 88; // tonal / monochrome color story
  if (d < 45) return 80; // analogous
  if (d >= 150) return 82; // complementary
  if (d >= 100) return 68; // triadic-ish, workable
  return 52; // 45–100°: the genuine clash zone
}

// ---------------------------------------------------------------------------
// Scoring one candidate outfit
// ---------------------------------------------------------------------------

interface ScoredOutfit {
  items: ClothingItem[];
  score: number;
  colorScore: number;
  formalitySpread: number;
  loudCount: number;
}

function scoreOutfit(items: ClothingItem[], occasion: string | null): ScoredOutfit | null {
  // Season: every pair must be compatible.
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (!seasonsCompatible(items[i].season, items[j].season)) return null;
    }
  }

  const formalities = items.map(formalityOf);
  const spread = Math.max(...formalities) - Math.min(...formalities);
  if (spread > 2) return null; // formal jacket over gym shorts: never

  const loudCount = items.filter((i) => loudnessOf(i) >= 2).length;
  if (loudCount > 1) return null; // max one loud pattern

  // Color: pairwise, top<->bottom weighted heaviest.
  const lchs = items.map(primaryLch);
  let colorSum = 0;
  let colorWeight = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const w =
        (items[i].clothing_type === "top" && items[j].clothing_type === "bottom") ||
        (items[i].clothing_type === "bottom" && items[j].clothing_type === "top")
          ? 3
          : 1;
      colorSum += colorPairScore(lchs[i], lchs[j]) * w;
      colorWeight += w;
    }
  }
  const colorScore = colorWeight > 0 ? colorSum / colorWeight : 75;

  let score = colorScore;
  score -= spread * 6; // formality coherence
  score -= loudCount === 1 && items.length > 2 ? 2 : 0;

  if (occasion) {
    const target = OCCASION_FORMALITY[occasion] ?? 3;
    const avg = formalities.reduce((s, f) => s + f, 0) / formalities.length;
    score -= Math.abs(avg - target) * 7;
  }

  if (items.some((i) => i.clothing_type === "footwear")) score += 4;
  if (items.some((i) => i.is_favorite)) score += 2;

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { items, score, colorScore, formalitySpread: spread, loudCount };
}

// ---------------------------------------------------------------------------
// Names & reasons (templated — no LLM)
// ---------------------------------------------------------------------------

const NAME_ADJECTIVES: Record<string, string[]> = {
  casual: ["Easy", "Laid-Back", "Everyday", "Effortless"],
  weekend: ["Weekend", "Off-Duty", "Sunday", "Relaxed"],
  work: ["Office", "Boardroom", "Workday", "Polished"],
  formal: ["Evening", "Tailored", "Refined", "Black-Tie"],
  date: ["Date-Night", "City", "Golden-Hour", "Uptown"],
  any: ["Signature", "Go-To", "Classic", "Modern"],
};

function outfitName(o: ScoredOutfit, occasion: string, index: number): string {
  const top = o.items.find((i) => i.clothing_type === "top");
  const colorWord = top?.colors?.[0]?.name ?? top?.primary_color ?? "";
  const adjs = NAME_ADJECTIVES[occasion] ?? NAME_ADJECTIVES.any;
  const adj = adjs[index % adjs.length];
  const cap = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
  return colorWord ? `${adj} ${cap(colorWord)} Look` : `${adj} Look`;
}

function outfitReason(o: ScoredOutfit): string {
  const parts: string[] = [];
  const names = (i: ClothingItem) =>
    (i.colors?.[0]?.name ?? i.primary_color ?? "").trim();

  const top = o.items.find((i) => i.clothing_type === "top");
  const bottom = o.items.find((i) => i.clothing_type === "bottom");
  const ct = top ? names(top) : "";
  const cb = bottom ? names(bottom) : "";

  if (o.colorScore >= 85) {
    parts.push(
      ct && cb && ct !== cb
        ? `${cap(ct)} and ${cb} sit naturally together`
        : `The tonal ${ct || "color"} palette keeps it clean`,
    );
  } else if (o.colorScore >= 72) {
    parts.push(`The colors balance without competing`);
  } else {
    parts.push(`A bolder color mix that still holds together`);
  }

  parts.push(
    o.formalitySpread === 0
      ? "every piece matches in formality"
      : "the pieces sit within one step of the same formality",
  );

  if (o.loudCount === 1) parts.push("one statement pattern carries the look");
  else if (o.items.every((i) => loudnessOf(i) === 0)) parts.push("solid pieces keep it sharp");

  return parts.join(", ") + ".";
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export function outfitKey(itemIds: string[]): string {
  return [...itemIds].sort().join(",");
}

export function generateOutfits(
  wardrobe: ClothingItem[],
  occasion: string | null,
  options: { count?: number; exclude?: Set<string> } = {},
): GeneratedOutfit[] {
  const { count = 6, exclude } = options;

  const byType = (t: ClothingItem["clothing_type"]) =>
    wardrobe.filter((i) => i.clothing_type === t);

  const tops = byType("top");
  const bottoms = byType("bottom");
  const shoes = byType("footwear");
  const outers = byType("outerwear");
  const accessories = byType("accessory");
  if (tops.length === 0 || bottoms.length === 0) return [];

  // Stage 1: score every top x bottom core pair.
  const cores: ScoredOutfit[] = [];
  for (const t of tops) {
    for (const b of bottoms) {
      const s = scoreOutfit([t, b], occasion);
      if (s) cores.push(s);
    }
  }
  cores.sort((a, b) => b.score - a.score);

  // Stage 2: extend the best cores with the single best shoe / outer /
  // accessory (greedy — keeps this O(pairs * extras), instant even at scale).
  const results: ScoredOutfit[] = [];
  const usedPairs = new Set<string>();

  for (const core of cores.slice(0, 60)) {
    let current = core;

    const tryExtend = (pool: ClothingItem[]) => {
      let best = current;
      for (const extra of pool) {
        const s = scoreOutfit([...current.items, extra], occasion);
        if (s && s.score >= best.score) best = s;
      }
      current = best;
    };

    tryExtend(shoes);
    tryExtend(outers);
    tryExtend(accessories);

    const key = outfitKey(current.items.map((i) => i.id));
    const pairKey = outfitKey(core.items.map((i) => i.id));
    if (usedPairs.has(pairKey)) continue; // one look per top+bottom pair
    if (exclude?.has(key)) continue; // rotation: skip looks already shown
    usedPairs.add(pairKey);
    results.push(current);
    if (results.length >= count * 2) break;
  }

  return results
    .filter((o) => o.score >= 55)
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map((o, idx) => ({
      name: outfitName(o, occasion ?? "any", idx),
      item_ids: o.items.map((i) => i.id),
      occasion: occasion ?? "casual",
      score: o.score,
      reason: outfitReason(o),
    }));
}
