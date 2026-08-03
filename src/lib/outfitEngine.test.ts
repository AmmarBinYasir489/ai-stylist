import { describe, expect, it } from "vitest";
import { generateOutfits, outfitKey } from "./outfitEngine";
import type { ClothingItem } from "./supabase";

function item(
  id: string,
  clothing_type: ClothingItem["clothing_type"],
  overrides: Partial<ClothingItem> = {},
): ClothingItem {
  return {
    id,
    user_id: "demo-user",
    image_url: "https://example.com/item.png",
    original_url: null,
    content_hash: null,
    category: clothing_type,
    clothing_type,
    primary_color: "navy",
    secondary_colors: [],
    colors: [{ hex: "#22314f", name: "navy", coverage: 1 }],
    bbox: null,
    pattern: "solid",
    style: "casual",
    season: "all-season",
    material: "cotton",
    fit: "regular",
    is_favorite: false,
    created_at: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("outfit engine", () => {
  it("generates a deterministic outfit for compatible wardrobe pieces", () => {
    const wardrobe = [
      item("top", "top"),
      item("bottom", "bottom", { primary_color: "white", colors: [{ hex: "#f5f5f5", name: "white", coverage: 1 }] }),
      item("shoes", "footwear"),
    ];

    const outfits = generateOutfits(wardrobe, "casual");

    expect(outfits.length).toBeGreaterThan(0);
    expect(outfits[0].item_ids).toContain("top");
    expect(outfits[0].item_ids).toContain("bottom");
  });

  it("rejects incompatible seasons", () => {
    const wardrobe = [
      item("summer-top", "top", { season: "summer" }),
      item("winter-bottom", "bottom", { season: "winter" }),
    ];

    expect(generateOutfits(wardrobe, "casual")).toEqual([]);
  });

  it("uses order-independent keys for duplicate prevention", () => {
    expect(outfitKey(["top", "bottom", "shoes"])).toBe(
      outfitKey(["shoes", "top", "bottom"]),
    );
  });
});
