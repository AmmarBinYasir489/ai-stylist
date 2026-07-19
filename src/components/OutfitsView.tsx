import { useMemo, useRef, useState } from "react";
import {
  supabase,
  type ClothingItem,
  type GeneratedOutfit,
  type SavedOutfit,
  TYPE_LABELS,
} from "../lib/supabase";
import { generateOutfits, outfitKey } from "../lib/outfitEngine";
import { Mannequin } from "./Mannequin";
import { Sparkles, Loader2, Trash2, Star, Check, Bookmark } from "lucide-react";

interface OutfitsViewProps {
  items: ClothingItem[];
  savedOutfits: SavedOutfit[];
  onSavedChanged: () => void;
}

const OCCASIONS = ["any", "casual", "work", "formal", "date", "weekend"];

const OCCASION_COLORS: Record<string, string> = {
  casual: "bg-green-100 text-green-700",
  work: "bg-blue-100 text-blue-700",
  formal: "bg-stone-800 text-white",
  date: "bg-rose-100 text-rose-700",
  weekend: "bg-amber-100 text-amber-700",
  streetwear: "bg-orange-100 text-orange-700",
};

export function OutfitsView({ items, savedOutfits, onSavedChanged }: OutfitsViewProps) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [occasion, setOccasion] = useState("any");
  const [results, setResults] = useState<GeneratedOutfit[]>([]);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [view, setView] = useState<"suggestions" | "saved">("suggestions");

  const itemMap = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const hasTop = items.some((i) => i.clothing_type === "top");
  const hasBottom = items.some((i) => i.clothing_type === "bottom");
  const savedKeys = useMemo(
    () => new Set(savedOutfits.map((o) => [...o.outfit_data.item_ids].sort().join(","))),
    [savedOutfits],
  );

  // Looks already shown for the current occasion — clicking "Style Me" again
  // rotates through the next-best combinations instead of repeating.
  const shownKeys = useRef<Map<string, Set<string>>>(new Map());

  // Outfits are generated locally (deterministic rules + color-harmony
  // scoring on the garments' exact pixel colors). No API call, no cost.
  const handleGenerate = () => {
    setGenerating(true);
    setError("");
    try {
      const occ = occasion === "any" ? null : occasion;
      const bucket = occasion;
      let exclude = shownKeys.current.get(bucket);
      if (!exclude) {
        exclude = new Set<string>();
        shownKeys.current.set(bucket, exclude);
      }

      let outfits = generateOutfits(items, occ, { exclude });
      if (outfits.length === 0 && exclude.size > 0) {
        // Every strong look has been shown — start the rotation over.
        exclude.clear();
        outfits = generateOutfits(items, occ, { exclude });
      }
      for (const o of outfits) exclude.add(outfitKey(o.item_ids));

      setResults(outfits);
      setView("suggestions");
      if (outfits.length === 0) {
        setError("No strong outfit found for this occasion yet — try adding more variety.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate outfits.");
    } finally {
      setGenerating(false);
    }
  };

  const handleSave = async (outfit: GeneratedOutfit) => {
    const key = [...outfit.item_ids].sort().join(",");
    setSavingKey(key);
    try {
      const { error } = await supabase.from("saved_outfits").insert({
        name: outfit.name,
        outfit_data: { item_ids: outfit.item_ids, occasion: outfit.occasion, score: outfit.score },
        ai_reason: outfit.reason,
        occasion: outfit.occasion,
        score: outfit.score,
      });
      if (error) throw error;
      onSavedChanged();
    } catch (err) {
      console.error("Save outfit failed:", err);
      alert("Could not save outfit.");
    } finally {
      setSavingKey(null);
    }
  };

  const handleDeleteSaved = async (o: SavedOutfit) => {
    await supabase.from("saved_outfits").delete().eq("id", o.id);
    onSavedChanged();
  };

  if (!hasTop || !hasBottom) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl bg-white py-16 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-stone-100">
          <Sparkles className="h-6 w-6 text-stone-400" />
        </div>
        <h3 className="mt-4 text-lg font-semibold text-stone-900">Add tops and bottoms first</h3>
        <p className="mt-1 max-w-xs text-sm text-stone-500">
          The stylist needs at least one top and one bottom in your wardrobe to build a look.
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Controls */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-stone-900">AI Stylist</h2>
          <p className="mt-0.5 text-sm text-stone-500">
            Complete looks curated from your {items.length} pieces — shown on a mannequin.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={occasion}
            onChange={(e) => setOccasion(e.target.value)}
            className="rounded-lg border border-stone-300 px-3 py-2.5 text-sm capitalize text-stone-700 outline-none focus:border-stone-900"
          >
            {OCCASIONS.map((o) => (
              <option key={o} value={o} className="capitalize">{o === "any" ? "Any occasion" : o}</option>
            ))}
          </select>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="flex items-center gap-2 rounded-xl bg-stone-900 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:bg-stone-800 disabled:opacity-50"
          >
            {generating ? <><Loader2 className="h-4 w-4 animate-spin" /> Styling…</> : <><Sparkles className="h-4 w-4" /> Style Me</>}
          </button>
        </div>
      </div>

      {/* View toggle */}
      <div className="mb-6 flex gap-1 rounded-xl bg-stone-200/60 p-1 w-full max-w-xs">
        <button
          onClick={() => setView("suggestions")}
          className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-all ${
            view === "suggestions" ? "bg-white text-stone-900 shadow-sm" : "text-stone-600 hover:text-stone-900"
          }`}
        >
          Suggestions
        </button>
        <button
          onClick={() => setView("saved")}
          className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-all ${
            view === "saved" ? "bg-white text-stone-900 shadow-sm" : "text-stone-600 hover:text-stone-900"
          }`}
        >
          Saved ({savedOutfits.length})
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{error}</div>
      )}

      {/* Suggestions */}
      {view === "suggestions" && (
        <>
          {generating && (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-stone-500">
              <Loader2 className="h-7 w-7 animate-spin" />
              <p className="text-sm">The AI stylist is putting looks together…</p>
            </div>
          )}

          {!generating && results.length > 0 && (
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {results.map((outfit) => {
                const key = [...outfit.item_ids].sort().join(",");
                const outfitItems = outfit.item_ids.map((id) => itemMap.get(id)).filter(Boolean) as ClothingItem[];
                const alreadySaved = savedKeys.has(key);
                return (
                  <OutfitCard
                    key={key}
                    name={outfit.name}
                    occasion={outfit.occasion}
                    score={outfit.score}
                    reason={outfit.reason}
                    items={outfitItems}
                    saved={alreadySaved}
                    saving={savingKey === key}
                    onSave={() => handleSave(outfit)}
                  />
                );
              })}
            </div>
          )}

          {!generating && results.length === 0 && !error && (
            <div className="flex flex-col items-center justify-center rounded-2xl bg-white py-16 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-stone-100">
                <Sparkles className="h-6 w-6 text-stone-400" />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-stone-900">Ready when you are</h3>
              <p className="mt-1 max-w-xs text-sm text-stone-500">
                Pick an occasion and hit <span className="font-medium">Style Me</span> — the AI ranks the best looks and shows them on a mannequin.
              </p>
            </div>
          )}
        </>
      )}

      {/* Saved */}
      {view === "saved" && (
        savedOutfits.length > 0 ? (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {savedOutfits.map((o) => {
              const outfitItems = o.outfit_data.item_ids.map((id) => itemMap.get(id)).filter(Boolean) as ClothingItem[];
              return (
                <OutfitCard
                  key={o.id}
                  name={o.name}
                  occasion={o.occasion || ""}
                  score={o.score || 0}
                  reason={o.ai_reason || ""}
                  items={outfitItems}
                  saved
                  onDelete={() => handleDeleteSaved(o)}
                />
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center rounded-2xl bg-white py-16 text-center">
            <Bookmark className="h-8 w-8 text-stone-300" />
            <p className="mt-3 max-w-xs text-sm text-stone-500">No saved outfits yet. Save looks you love from the Suggestions tab.</p>
          </div>
        )
      )}
    </div>
  );
}

function OutfitCard({
  name,
  occasion,
  score,
  reason,
  items,
  saved,
  saving,
  onSave,
  onDelete,
}: {
  name: string;
  occasion: string;
  score: number;
  reason: string;
  items: ClothingItem[];
  saved: boolean;
  saving?: boolean;
  onSave?: () => void;
  onDelete?: () => void;
}) {
  const occasionClass = OCCASION_COLORS[occasion] || "bg-stone-100 text-stone-700";
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl bg-white shadow-sm transition-all hover:shadow-lg">
      {/* Mannequin */}
      <div className="relative bg-gradient-to-b from-stone-50 to-stone-100 p-4">
        {occasion && (
          <span className={`absolute left-3 top-3 z-10 rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${occasionClass}`}>
            {occasion}
          </span>
        )}
        {score > 0 && (
          <span className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-full bg-white/90 px-2.5 py-1 text-xs font-semibold text-stone-700 shadow-sm">
            <Star className="h-3 w-3 fill-amber-400 text-amber-400" /> {score}
          </span>
        )}
        <Mannequin items={items} />
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col p-4">
        <h3 className="text-base font-bold text-stone-900">{name}</h3>
        {reason && <p className="mt-1 text-sm leading-snug text-stone-600">{reason}</p>}

        <div className="mt-3 flex flex-wrap gap-1.5">
          {items.map((i) => (
            <span key={i.id} className="rounded-md bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-600">
              {i.category || TYPE_LABELS[i.clothing_type]}
            </span>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between">
          <span className="text-xs text-stone-400">{items.length} pieces</span>
          {onDelete ? (
            <button onClick={onDelete} className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-stone-500 hover:bg-red-50 hover:text-red-600">
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </button>
          ) : saved ? (
            <span className="flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-600">
              <Check className="h-3.5 w-3.5" /> Saved
            </span>
          ) : (
            <button
              onClick={onSave}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-800 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bookmark className="h-3.5 w-3.5" />} Save
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
