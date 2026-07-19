import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Helps during first-time setup: a blank screen with this console error
  // means the .env file is missing or the dev server wasn't restarted.
  console.error(
    "Missing Supabase env vars. Copy .env.example to .env, fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then restart `npm run dev`.",
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: true },
});

export const STORAGE_BUCKET = "wardrobe-images";

// Structural slot — drives the mannequin renderer and the outfit generator.
export type ClothingType = "top" | "bottom" | "footwear" | "outerwear" | "accessory";

// Exact color extracted from the garment's pixels (not AI-guessed).
export interface ItemColor {
  hex: string;
  name: string;
  coverage: number;
}

// Tight bounding box of the garment inside its cutout image (fractions 0..1).
export interface AlphaBBox {
  x: number;
  y: number;
  w: number;
  h: number;
  aspect: number; // garment w/h — drives proportional mannequin scaling
}

export interface ClothingItem {
  id: string;
  user_id: string;
  image_url: string;
  original_url: string | null; // untouched upload, kept for reprocessing
  content_hash: string | null; // sha256 of the original file — dedup key
  category: string | null; // specific label e.g. "T-Shirt", "Jeans"
  clothing_type: ClothingType;
  primary_color: string | null;
  secondary_colors: string[];
  colors: ItemColor[] | null; // pixel-exact palette
  bbox: AlphaBBox | null;
  pattern: string | null;
  style: string | null;
  season: string | null;
  material: string | null;
  fit: string | null;
  is_favorite: boolean;
  created_at: string;
}

// AI metadata returned by the analyze-clothing edge function. Colors are NOT
// part of the AI response anymore — they are extracted from pixels locally.
export interface ClothingMetadata {
  category: string;
  clothing_type: ClothingType;
  primary_color: string;
  secondary_colors: string[];
  pattern: string;
  style: string;
  season: string;
  material: string;
  fit: string;
}

// One outfit as returned by the generate-outfits edge function.
export interface GeneratedOutfit {
  name: string;
  item_ids: string[];
  occasion: string;
  score: number;
  reason: string;
}

export interface SavedOutfit {
  id: string;
  user_id: string;
  name: string;
  outfit_data: { item_ids: string[]; [k: string]: unknown };
  ai_reason: string | null;
  occasion: string | null;
  score: number | null;
  created_at: string;
}

export const CLOTHING_TYPES: ClothingType[] = [
  "top",
  "bottom",
  "outerwear",
  "footwear",
  "accessory",
];

export const TYPE_LABELS: Record<ClothingType, string> = {
  top: "Tops",
  bottom: "Bottoms",
  outerwear: "Outerwear",
  footwear: "Footwear",
  accessory: "Accessories",
};

export const TYPE_ICONS: Record<ClothingType, string> = {
  top: "👕",
  bottom: "👖",
  outerwear: "🧥",
  footwear: "👟",
  accessory: "⌚",
};

export const STYLE_OPTIONS = [
  "casual",
  "smart casual",
  "formal",
  "business",
  "streetwear",
  "sporty",
];

export const SEASON_OPTIONS = ["summer", "winter", "spring", "fall", "all-season"];

export const PATTERN_OPTIONS = [
  "solid",
  "striped",
  "plaid",
  "checked",
  "floral",
  "graphic",
  "printed",
];
