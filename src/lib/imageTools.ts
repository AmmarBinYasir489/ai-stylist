/*
  imageTools
  ----------
  Deterministic, in-browser image analysis. No AI, no API calls, no cost.

  - sha256Hex:       content hash for dedup (re-uploading the same photo is free)
  - resizeImage:     high-quality multi-step downscale (preserves prints/logos
                     far better than a single-step canvas draw)
  - analyzeCutout:   reads the transparent cutout's pixels to produce
                     * exact colors (k-means in CIELAB, reported as hex + name)
                     * the garment's alpha bounding box (drives proportional
                       scaling on the mannequin)
*/

export interface ItemColor {
  hex: string;
  name: string;
  coverage: number; // 0..1 share of garment pixels
}

export interface AlphaBBox {
  x: number; // fractions of the image, 0..1
  y: number;
  w: number;
  h: number;
  aspect: number; // w/h of the garment itself (not the image)
}

export interface CutoutAnalysis {
  colors: ItemColor[];
  bbox: AlphaBBox | null;
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Downscale in halving steps, then one final high-quality draw. A single
// canvas draw from 4000px -> 1024px destroys fine patterns; stepping keeps them.
export async function resizeImage(
  blob: Blob,
  maxDim: number,
  type: "image/png" | "image/jpeg" = "image/png",
  quality = 0.92,
): Promise<Blob> {
  try {
    let bitmap: ImageBitmap | HTMLCanvasElement = await createImageBitmap(blob);
    let w = bitmap.width;
    let h = bitmap.height;
    if (Math.max(w, h) <= maxDim) {
      // Still re-encode PNGs untouched? No — return the original bytes.
      return blob;
    }
    const targetScale = maxDim / Math.max(w, h);
    const targetW = Math.round(w * targetScale);
    const targetH = Math.round(h * targetScale);

    while (w / 2 > targetW && h / 2 > targetH) {
      const step = document.createElement("canvas");
      step.width = Math.round(w / 2);
      step.height = Math.round(h / 2);
      const ctx = step.getContext("2d");
      if (!ctx) break;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, step.width, step.height);
      bitmap = step;
      w = step.width;
      h = step.height;
    }

    const out = document.createElement("canvas");
    out.width = targetW;
    out.height = targetH;
    const ctx = out.getContext("2d");
    if (!ctx) return blob;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    const result: Blob | null = await new Promise((resolve) =>
      out.toBlob(resolve, type, type === "image/jpeg" ? quality : undefined),
    );
    return result || blob;
  } catch {
    return blob;
  }
}

// Product-style framing: trim the cutout to the garment's alpha bounding box
// and center it on a square transparent canvas with even margins — every
// wardrobe photo ends up framed like a studio flat-lay regardless of how the
// original was shot. Returns hasAlpha=false (blob untouched) when background
// removal produced no transparency, so callers can warn the user.
export async function trimToContent(
  blob: Blob,
  marginFrac = 0.08,
): Promise<{ blob: Blob; hasAlpha: boolean }> {
  try {
    const bitmap = await createImageBitmap(blob);
    const w = bitmap.width;
    const h = bitmap.height;
    const src = document.createElement("canvas");
    src.width = w;
    src.height = h;
    const sctx = src.getContext("2d", { willReadFrequently: true });
    if (!sctx) return { blob, hasAlpha: false };
    sctx.drawImage(bitmap, 0, 0);
    const { data } = sctx.getImageData(0, 0, w, h);

    let minX = w, minY = h, maxX = -1, maxY = -1;
    let transparent = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = data[(y * w + x) * 4 + 3];
        if (a < 30) {
          transparent++;
          continue;
        }
        if (a < 200) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    // Almost no transparent pixels => background removal didn't really run.
    if (transparent / (w * h) < 0.05 || maxX < 0) return { blob, hasAlpha: false };

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const side = Math.ceil(Math.max(bw, bh) * (1 + marginFrac * 2));
    const out = document.createElement("canvas");
    out.width = side;
    out.height = side;
    const octx = out.getContext("2d");
    if (!octx) return { blob, hasAlpha: true };
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = "high";
    octx.drawImage(
      src,
      minX, minY, bw, bh,
      Math.round((side - bw) / 2), Math.round((side - bh) / 2), bw, bh,
    );
    const result: Blob | null = await new Promise((resolve) => out.toBlob(resolve, "image/png"));
    return { blob: result || blob, hasAlpha: true };
  } catch {
    return { blob, hasAlpha: false };
  }
}

// ---------------------------------------------------------------------------
// Color math (sRGB -> CIELAB)
// ---------------------------------------------------------------------------

type Lab = [number, number, number];

function srgbToLab(r: number, g: number, b: number): Lab {
  const lin = (c: number) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const rl = lin(r), gl = lin(g), bl = lin(b);
  // D65
  let x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
  let y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722;
  let z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function labDist(a: Lab, b: Lab): number {
  const dl = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Small named palette used only for human-readable labels and search/filters.
// The exact garment color is always the hex.
const NAMED_COLORS: [string, string][] = [
  ["black", "#1a1a1a"], ["white", "#f5f5f5"], ["gray", "#8a8a8a"],
  ["light gray", "#c8c8c8"], ["charcoal", "#3d3d3d"], ["beige", "#d9c7a7"],
  ["cream", "#f2e8d5"], ["tan", "#c9a878"], ["brown", "#7a5230"],
  ["navy", "#22314f"], ["blue", "#3c6fc4"], ["light blue", "#9cc2e8"],
  ["denim", "#5a7ba6"], ["teal", "#2e7d7d"], ["green", "#3d7a3d"],
  ["olive", "#6f6f3d"], ["mint", "#a8d8c0"], ["yellow", "#e8c937"],
  ["mustard", "#c9a227"], ["orange", "#e07b2e"], ["red", "#c43c3c"],
  ["maroon", "#6f2632"], ["burgundy", "#7d2e46"], ["pink", "#e8a0b4"],
  ["hot pink", "#d4478a"], ["purple", "#6f4a9c"], ["lavender", "#b8a4d4"],
];

const NAMED_LAB: [string, Lab][] = NAMED_COLORS.map(([name, hex]) => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [name, srgbToLab(r, g, b)];
});

export function nearestColorName(lab: Lab): string {
  let best = "unknown";
  let bestD = Infinity;
  for (const [name, ref] of NAMED_LAB) {
    const d = labDist(lab, ref);
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

// Map a stored color name (e.g. user-typed "navy") back to a reference hex so
// the outfit engine can score items saved before pixel extraction existed.
export function hexForColorName(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.toLowerCase().trim();
  const found = NAMED_COLORS.find(([c]) => c === n || n.includes(c));
  return found ? found[1] : null;
}

// ---------------------------------------------------------------------------
// Cutout analysis: bbox from alpha + dominant colors via k-means in LAB
// ---------------------------------------------------------------------------

export async function analyzeCutout(blob: Blob): Promise<CutoutAnalysis> {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 384 / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { colors: [], bbox: null };
    ctx.drawImage(bitmap, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);

    // Collect opaque garment pixels + alpha bounding box.
    let minX = w, minY = h, maxX = -1, maxY = -1;
    const samples: Lab[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] < 200) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        samples.push(srgbToLab(data[i], data[i + 1], data[i + 2]));
      }
    }

    if (maxX < 0 || samples.length < 20) return { colors: [], bbox: null };

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const bbox: AlphaBBox = {
      x: minX / w,
      y: minY / h,
      w: bw / w,
      h: bh / h,
      aspect: bw / bh,
    };

    // k-means (k=4) in LAB, deterministic init: sort by lightness, seed with
    // evenly spaced quantiles so identical images always give identical colors.
    const sorted = [...samples].sort((a, b) => a[0] - b[0]);
    const k = 4;
    let centroids: Lab[] = Array.from({ length: k }, (_, i) => {
      const s = sorted[Math.floor(((i + 0.5) / k) * sorted.length)];
      return [...s] as Lab;
    });
    const assign = new Array<number>(samples.length).fill(0);
    for (let iter = 0; iter < 8; iter++) {
      for (let s = 0; s < samples.length; s++) {
        let best = 0, bestD = Infinity;
        for (let c = 0; c < k; c++) {
          const d = labDist(samples[s], centroids[c]);
          if (d < bestD) { bestD = d; best = c; }
        }
        assign[s] = best;
      }
      const sums: number[][] = Array.from({ length: k }, () => [0, 0, 0, 0]);
      for (let s = 0; s < samples.length; s++) {
        const a = assign[s];
        sums[a][0] += samples[s][0];
        sums[a][1] += samples[s][1];
        sums[a][2] += samples[s][2];
        sums[a][3]++;
      }
      centroids = centroids.map((c, i) =>
        sums[i][3] === 0 ? c : ([sums[i][0] / sums[i][3], sums[i][1] / sums[i][3], sums[i][2] / sums[i][3]] as Lab),
      );
    }

    // Cluster share + merge near-identical clusters (deltaE < 12).
    const counts = new Array<number>(k).fill(0);
    for (const a of assign) counts[a]++;
    const clusters = centroids
      .map((lab, i) => ({ lab, coverage: counts[i] / samples.length }))
      .filter((c) => c.coverage > 0.001)
      .sort((a, b) => b.coverage - a.coverage);

    const merged: { lab: Lab; coverage: number }[] = [];
    for (const c of clusters) {
      const near = merged.find((m) => labDist(m.lab, c.lab) < 12);
      if (near) near.coverage += c.coverage;
      else merged.push({ ...c });
    }

    const colors: ItemColor[] = merged
      .filter((c) => c.coverage >= 0.06)
      .slice(0, 4)
      .map((c) => {
        const rgb = labToSrgb(c.lab);
        return {
          hex: rgbToHex(rgb[0], rgb[1], rgb[2]),
          name: nearestColorName(c.lab),
          coverage: Math.round(c.coverage * 1000) / 1000,
        };
      });

    return { colors, bbox };
  } catch {
    return { colors: [], bbox: null };
  }
}

function labToSrgb(lab: Lab): [number, number, number] {
  const [L, a, b] = lab;
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t: number) => {
    const t3 = t * t * t;
    return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
  };
  const x = inv(fx) * 0.95047;
  const y = inv(fy);
  const z = inv(fz) * 1.08883;
  let rl = x * 3.2406 + y * -1.5372 + z * -0.4986;
  let gl = x * -0.9689 + y * 1.8758 + z * 0.0415;
  let bl = x * 0.0557 + y * -0.204 + z * 1.057;
  const gamma = (c: number) => {
    c = Math.max(0, Math.min(1, c));
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  };
  return [gamma(rl) * 255, gamma(gl) * 255, gamma(bl) * 255];
}
