import type { ClothingItem, ClothingType } from "../lib/supabase";

/*
  Mannequin
  ---------
  Renders an outfit as a styled figure: a neutral human silhouette with the
  user's actual clothing photos layered onto body zones by clothing_type,
  instead of showing the pieces as a flat collage.

    outerwear -> sits behind/around the torso (like an open jacket)
    top       -> chest / torso
    bottom    -> hips / legs
    footwear  -> feet
    accessory -> small tag near the neck
*/

interface MannequinProps {
  items: ClothingItem[];
  size?: "sm" | "lg";
}

function pick(items: ClothingItem[], type: ClothingType): ClothingItem | undefined {
  return items.find((i) => i.clothing_type === type);
}

// Container is aspect-[3/5], so a zone spanning W% of the width spans
// W% * (3/5) of the height at a square aspect. Given the garment's true
// aspect (from its alpha bounding box, computed at upload), derive the zone
// height that makes the box hug the garment exactly — proportions then come
// from the clothing itself, not from a hardcoded box.
const CONTAINER_RATIO = 3 / 5;

function zoneHeight(
  item: ClothingItem | undefined,
  widthPct: number,
  fallbackPct: number,
  minPct: number,
  maxPct: number,
): number {
  const aspect = item?.bbox?.aspect;
  if (!aspect || aspect <= 0) return fallbackPct;
  const h = (widthPct * CONTAINER_RATIO) / aspect;
  return Math.max(minPct, Math.min(maxPct, h));
}

// A garment cutout placed over a body zone. Images are transparent PNGs
// (background removed at upload) so object-contain makes them look worn
// rather than framed.
function Zone({
  item,
  style,
  zIndex,
}: {
  item?: ClothingItem;
  style: React.CSSProperties;
  zIndex: number;
}) {
  if (!item) return null;
  return (
    <div className="absolute" style={{ ...style, zIndex }}>
      <img
        src={item.image_url}
        alt={item.category || item.clothing_type}
        className="h-full w-full object-contain"
        style={{ filter: "drop-shadow(0 4px 6px rgba(0,0,0,0.18))" }}
      />
    </div>
  );
}

export function Mannequin({ items, size = "lg" }: MannequinProps) {
  const top = pick(items, "top");
  const bottom = pick(items, "bottom");
  const footwear = pick(items, "footwear");
  const outerwear = pick(items, "outerwear");
  const accessory = pick(items, "accessory");

  const hasOuter = Boolean(outerwear);
  const aspect = size === "lg" ? "aspect-[3/5]" : "aspect-[3/5]";

  return (
    <div className={`relative mx-auto w-full ${aspect} max-w-[280px]`}>
      {/* Silhouette backdrop */}
      <svg
        viewBox="0 0 100 166"
        className="absolute inset-0 h-full w-full text-stone-200"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden
      >
        {/* head */}
        <circle cx="50" cy="14" r="9" fill="currentColor" />
        {/* neck + shoulders + torso */}
        <path
          d="M44 22 h12 l3 5 q10 3 12 12 l-4 2 -2 -4 v18 q0 6 -3 10 l1 30 h-9 l-1 -26 h-2 l-1 26 h-9 l1 -30 q-3 -4 -3 -10 v-18 l-2 4 -4 -2 q2 -9 12 -12 z"
          fill="currentColor"
        />
        {/* legs */}
        <path d="M42 78 h16 l-1 60 h-6 l-2 -46 -2 46 h-6 z" fill="currentColor" />
      </svg>

      {/* Outerwear — wider, behind the top, reads like an open jacket */}
      <Zone
        item={outerwear}
        zIndex={1}
        style={{
          left: "6%",
          width: "88%",
          top: "15%",
          height: `${zoneHeight(outerwear, 88, 42, 30, 52)}%`,
        }}
      />

      {/* Top — chest/torso, narrower when layered under outerwear */}
      <Zone
        item={top}
        zIndex={2}
        style={
          hasOuter
            ? {
                left: "26%",
                width: "48%",
                top: "16%",
                height: `${zoneHeight(top, 48, 34, 22, 40)}%`,
              }
            : {
                left: "16%",
                width: "68%",
                top: "15%",
                height: `${zoneHeight(top, 68, 37, 24, 44)}%`,
              }
        }
      />

      {/* Bottom — hips/legs, slightly overlapping the top for a worn look */}
      <Zone
        item={bottom}
        zIndex={2}
        style={{
          left: "22%",
          width: "56%",
          top: "45%",
          height: `${zoneHeight(bottom, 56, 38, 26, 46)}%`,
        }}
      />

      {/* Footwear — feet */}
      <Zone
        item={footwear}
        zIndex={3}
        style={{
          left: "26%",
          width: "48%",
          top: "80%",
          height: `${zoneHeight(footwear, 48, 16, 9, 18)}%`,
        }}
      />

      {/* Accessory — small tag near the neck */}
      <Zone
        item={accessory}
        zIndex={4}
        style={{
          right: "2%",
          width: "24%",
          top: "8%",
          height: `${zoneHeight(accessory, 24, 16, 8, 18)}%`,
        }}
      />
    </div>
  );
}
