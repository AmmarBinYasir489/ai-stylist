import { useCallback, useMemo, useRef, useState } from "react";
import {
  supabase,
  STORAGE_BUCKET,
  type ClothingItem,
  type ClothingType,
  type ClothingMetadata,
  type ItemColor,
  type AlphaBBox,
  CLOTHING_TYPES,
  TYPE_LABELS,
  STYLE_OPTIONS,
  SEASON_OPTIONS,
  PATTERN_OPTIONS,
} from "../lib/supabase";
import { sha256Hex, resizeImage, analyzeCutout } from "../lib/imageTools";
import {
  Upload,
  Trash2,
  Loader2,
  ImageIcon,
  X,
  Sparkles,
  Heart,
  Pencil,
  Search,
} from "lucide-react";

interface WardrobeViewProps {
  items: ClothingItem[];
  loading: boolean;
  onChanged: () => void;
}

const EMPTY_META: ClothingMetadata = {
  category: "",
  clothing_type: "top",
  primary_color: "",
  secondary_colors: [],
  pattern: "solid",
  style: "casual",
  season: "all-season",
  material: "unknown",
  fit: "regular",
};

function pathFromUrl(url: string): string | null {
  const marker = `/${STORAGE_BUCKET}/`;
  const idx = url.indexOf(marker);
  return idx === -1 ? null : url.slice(idx + marker.length);
}

// Cut out the garment on a transparent background (runs entirely in the
// browser, no external API). The model is lazy-loaded on first use. Falls
// back to the original file if removal fails.
async function cutout(file: File): Promise<Blob> {
  try {
    const { removeBackground } = await import("@imgly/background-removal");
    return await removeBackground(file);
  } catch (err) {
    console.warn("Background removal failed, using original image:", err);
    return file;
  }
}

// The only AI call in the whole pipeline: category/style/season/etc. Colors
// are extracted from pixels locally, so they're excluded from the AI response.
async function analyzeImage(imageUrl: string): Promise<Partial<ClothingMetadata> | null> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token || import.meta.env.VITE_SUPABASE_ANON_KEY;
  const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/analyze-clothing`;
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ image_url: imageUrl }),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return data.metadata ?? null;
}

export function WardrobeView({ items, loading, onChanged }: WardrobeViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // Upload + analyze pipeline
  const [busy, setBusy] = useState(false); // working before the modal opens
  const [busyLabel, setBusyLabel] = useState("Uploading…");
  const [analyzing, setAnalyzing] = useState(false);

  // Modal state (shared by "new" and "edit")
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null); // null => new item
  const [previewUrl, setPreviewUrl] = useState("");
  const [uploadedPaths, setUploadedPaths] = useState<string[]>([]); // only for new items, for cancel cleanup
  const [meta, setMeta] = useState<ClothingMetadata>(EMPTY_META);
  // Pixel-derived data for the item being added (exact colors, alpha bbox,
  // dedup hash, original file URL) — saved alongside the AI metadata.
  const [pendingExtras, setPendingExtras] = useState<{
    content_hash: string;
    colors: ItemColor[];
    bbox: AlphaBBox | null;
    original_url: string | null;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  // Filters
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<ClothingType | "all">("all");
  const [seasonFilter, setSeasonFilter] = useState<string>("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  const colorOptions = useMemo(() => {
    const set = new Set<string>();
    items.forEach((i) => i.primary_color && set.add(i.primary_color));
    return ["all", ...Array.from(set).sort()];
  }, [items]);
  const [colorFilter, setColorFilter] = useState<string>("all");

  const handleFileSelect = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    setBusy(true);
    try {
      // 1. Dedup by content hash BEFORE any processing: a re-uploaded photo
      //    costs zero compute, zero storage and zero AI API usage.
      setBusyLabel("Checking for duplicates…");
      const hash = await sha256Hex(file);
      const existing = items.find((i) => i.content_hash === hash);
      if (existing) {
        setBusy(false);
        alert(`This photo is already in your wardrobe as "${existing.category || TYPE_LABELS[existing.clothing_type]}".`);
        return;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData.session?.user?.id;
      if (!userId) throw new Error("Not signed in.");

      // 2. Background removal (local, free) on the untouched original.
      setBusyLabel("Removing background…");
      const cut = await cutout(file);

      // 3. High-quality downscale (multi-step, 1600px) + pixel analysis:
      //    exact colors and the garment's bounding box. All local.
      setBusyLabel("Reading colors…");
      const png = await resizeImage(cut, 1600, "image/png");
      const { colors, bbox } = await analyzeCutout(png);

      // 4. Upload the cutout and a lightly-compressed copy of the original
      //    (kept so the item can always be reprocessed at full quality).
      setBusyLabel("Uploading…");
      const cutoutPath = `${userId}/${hash}.png`;
      const originalPath = `${userId}/${hash}-orig.jpg`;
      const originalJpg = await resizeImage(file, 2048, "image/jpeg", 0.9);

      const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(cutoutPath, png, { contentType: "image/png", upsert: true });
      if (uploadError) throw uploadError;
      const { error: origError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(originalPath, originalJpg, { contentType: "image/jpeg", upsert: true });
      if (origError) console.warn("Original upload failed (continuing):", origError.message);

      const publicUrl = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(cutoutPath).data.publicUrl;
      const originalUrl = origError
        ? null
        : supabase.storage.from(STORAGE_BUCKET).getPublicUrl(originalPath).data.publicUrl;

      // Open the modal immediately; colors are already filled from pixels.
      setEditingId(null);
      setUploadedPaths(origError ? [cutoutPath] : [cutoutPath, originalPath]);
      setPreviewUrl(publicUrl);
      setPendingExtras({ content_hash: hash, colors, bbox, original_url: originalUrl });
      setMeta({
        ...EMPTY_META,
        primary_color: colors[0]?.name ?? "",
        secondary_colors: colors.slice(1).map((c) => c.name),
      });
      setModalOpen(true);
      setBusy(false);

      // 5. The one AI call: categorize the CLEAN CUTOUT (not the original —
      //    background objects no longer contaminate the result).
      setAnalyzing(true);
      const detected = await analyzeImage(publicUrl);
      if (detected) {
        setMeta((prev) => ({
          ...prev,
          ...detected,
          // Pixel-extracted colors always win over anything AI-shaped.
          primary_color: prev.primary_color || detected.primary_color || "",
          secondary_colors: prev.secondary_colors.length
            ? prev.secondary_colors
            : detected.secondary_colors ?? [],
        }));
      }
      setAnalyzing(false);
    } catch (err) {
      console.error("Upload failed:", err);
      alert("Upload failed. Please try again.");
      setBusy(false);
      setAnalyzing(false);
    }
  }, [items]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFileSelect(file);
    },
    [handleFileSelect],
  );

  const openEdit = (item: ClothingItem) => {
    setEditingId(item.id);
    setUploadedPaths([]);
    setPendingExtras(null);
    setPreviewUrl(item.image_url);
    setMeta({
      category: item.category || "",
      clothing_type: item.clothing_type,
      primary_color: item.primary_color || "",
      secondary_colors: item.secondary_colors || [],
      pattern: item.pattern || "solid",
      style: item.style || "casual",
      season: item.season || "all-season",
      material: item.material || "unknown",
      fit: item.fit || "regular",
    });
    setModalOpen(true);
  };

  const closeModal = async () => {
    // If this was a new upload the user abandoned, clean up the orphaned files.
    if (editingId === null && uploadedPaths.length > 0) {
      await supabase.storage.from(STORAGE_BUCKET).remove(uploadedPaths);
    }
    setModalOpen(false);
    setUploadedPaths([]);
    setPendingExtras(null);
    setPreviewUrl("");
    setEditingId(null);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        category: meta.category || null,
        clothing_type: meta.clothing_type,
        primary_color: meta.primary_color || null,
        secondary_colors: meta.secondary_colors,
        pattern: meta.pattern || null,
        style: meta.style || null,
        season: meta.season || null,
        material: meta.material || null,
        fit: meta.fit || null,
      };

      if (editingId) {
        const { error } = await supabase.from("clothing_items").update(payload).eq("id", editingId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("clothing_items").insert({
          ...payload,
          image_url: previewUrl,
          content_hash: pendingExtras?.content_hash ?? null,
          colors: pendingExtras?.colors ?? [],
          bbox: pendingExtras?.bbox ?? null,
          original_url: pendingExtras?.original_url ?? null,
        });
        if (error) throw error;
      }

      setModalOpen(false);
      setUploadedPaths([]);
      setPendingExtras(null);
      setPreviewUrl("");
      setEditingId(null);
      onChanged();
    } catch (err) {
      console.error("Save failed:", err);
      alert("Failed to save. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (item: ClothingItem) => {
    const paths = [item.image_url, item.original_url]
      .map((u) => (u ? pathFromUrl(u) : null))
      .filter((p): p is string => Boolean(p));
    if (paths.length > 0) await supabase.storage.from(STORAGE_BUCKET).remove(paths);
    await supabase.from("clothing_items").delete().eq("id", item.id);
    onChanged();
  };

  const toggleFavorite = async (item: ClothingItem) => {
    await supabase
      .from("clothing_items")
      .update({ is_favorite: !item.is_favorite })
      .eq("id", item.id);
    onChanged();
  };

  // Apply filters
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      if (typeFilter !== "all" && i.clothing_type !== typeFilter) return false;
      if (colorFilter !== "all" && i.primary_color !== colorFilter) return false;
      if (seasonFilter !== "all" && i.season !== seasonFilter) return false;
      if (favoritesOnly && !i.is_favorite) return false;
      if (q) {
        const hay = [i.category, i.primary_color, i.style, i.pattern, i.material, i.season]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, search, typeFilter, colorFilter, seasonFilter, favoritesOnly]);

  const grouped = CLOTHING_TYPES.reduce((acc, cat) => {
    acc[cat] = filtered.filter((i) => i.clothing_type === cat);
    return acc;
  }, {} as Record<ClothingType, ClothingItem[]>);

  return (
    <div>
      {/* Upload Zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => !busy && fileInputRef.current?.click()}
        className={`group cursor-pointer rounded-2xl border-2 border-dashed p-8 sm:p-12 text-center transition-all ${
          dragOver ? "border-stone-900 bg-stone-100" : "border-stone-300 bg-white hover:border-stone-400 hover:bg-stone-50"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFileSelect(file);
            e.target.value = "";
          }}
          className="hidden"
        />
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-stone-900 text-white transition-transform group-hover:scale-110">
          {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <Upload className="h-6 w-6" />}
        </div>
        <h3 className="mt-4 text-lg font-semibold text-stone-900">
          {busy ? busyLabel : "Drop a photo of your clothing here"}
        </h3>
        <p className="mt-1 flex items-center justify-center gap-1.5 text-sm text-stone-500">
          <Sparkles className="h-3.5 w-3.5" />
          Background removed + category, color, style &amp; season detected automatically
        </p>
      </div>

      {/* Filters */}
      {items.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search your wardrobe…"
              className="w-full rounded-lg border border-stone-300 py-2 pl-9 pr-3 text-sm outline-none focus:border-stone-900"
            />
          </div>
          <Select value={typeFilter} onChange={(v) => setTypeFilter(v as ClothingType | "all")}
            options={[["all", "All types"], ...CLOTHING_TYPES.map((t) => [t, TYPE_LABELS[t]] as [string, string])]} />
          <Select value={colorFilter} onChange={setColorFilter}
            options={colorOptions.map((c) => [c, c === "all" ? "All colors" : c] as [string, string])} />
          <Select value={seasonFilter} onChange={setSeasonFilter}
            options={[["all", "All seasons"], ...SEASON_OPTIONS.map((s) => [s, s] as [string, string])]} />
          <button
            onClick={() => setFavoritesOnly((v) => !v)}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-all ${
              favoritesOnly ? "border-rose-300 bg-rose-50 text-rose-600" : "border-stone-300 text-stone-600 hover:bg-stone-50"
            }`}
          >
            <Heart className={`h-4 w-4 ${favoritesOnly ? "fill-rose-500 text-rose-500" : ""}`} />
            Favorites
          </button>
        </div>
      )}

      {loading && (
        <div className="mt-12 flex items-center justify-center gap-2 text-stone-500">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Loading your wardrobe…</span>
        </div>
      )}

      {!loading && items.length > 0 && (
        <div className="mt-6 space-y-8">
          {CLOTHING_TYPES.map((cat) =>
            grouped[cat].length > 0 ? (
              <div key={cat}>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
                    {TYPE_LABELS[cat]}
                    <span className="ml-2 text-stone-400">({grouped[cat].length})</span>
                  </h2>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                  {grouped[cat].map((item) => (
                    <ClothingCard
                      key={item.id}
                      item={item}
                      onDelete={handleDelete}
                      onEdit={openEdit}
                      onToggleFavorite={toggleFavorite}
                    />
                  ))}
                </div>
              </div>
            ) : null,
          )}
          {filtered.length === 0 && (
            <p className="py-8 text-center text-sm text-stone-500">No items match your filters.</p>
          )}
        </div>
      )}

      {!loading && items.length === 0 && (
        <div className="mt-8 flex flex-col items-center justify-center rounded-2xl bg-white py-12 text-center">
          <ImageIcon className="h-10 w-10 text-stone-300" />
          <p className="mt-3 text-sm text-stone-500">
            Your wardrobe is empty. Upload your first piece above — the AI does the rest.
          </p>
        </div>
      )}

      {/* Add / Edit Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-stone-200 px-6 py-4">
              <h2 className="text-lg font-bold">{editingId ? "Edit Item" : "New Clothing Item"}</h2>
              <button onClick={closeModal} className="rounded-lg p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-6">
              <div className="relative mb-4 overflow-hidden rounded-xl bg-stone-100">
                {previewUrl && <img src={previewUrl} alt="Preview" className="h-48 w-full object-cover" />}
                {analyzing && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/40 text-white">
                    <Loader2 className="h-6 w-6 animate-spin" />
                    <span className="text-sm font-medium">AI is analyzing…</span>
                  </div>
                )}
              </div>

              {!analyzing && !editingId && (
                <p className="mb-4 flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                  <Sparkles className="h-3.5 w-3.5" />
                  AI-detected details below — edit anything before saving.
                </p>
              )}

              <Field label="Category">
                <input
                  value={meta.category}
                  onChange={(e) => setMeta({ ...meta, category: e.target.value })}
                  placeholder="e.g. T-Shirt"
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-900"
                />
              </Field>

              <Field label="Type (mannequin slot)">
                <div className="flex flex-wrap gap-2">
                  {CLOTHING_TYPES.map((t) => (
                    <Chip key={t} active={meta.clothing_type === t} onClick={() => setMeta({ ...meta, clothing_type: t })}>
                      {TYPE_LABELS[t]}
                    </Chip>
                  ))}
                </div>
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Primary color">
                  <input
                    value={meta.primary_color}
                    onChange={(e) => setMeta({ ...meta, primary_color: e.target.value })}
                    placeholder="e.g. navy"
                    className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-900"
                  />
                </Field>
                <Field label="Secondary colors">
                  <input
                    value={meta.secondary_colors.join(", ")}
                    onChange={(e) =>
                      setMeta({ ...meta, secondary_colors: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })
                    }
                    placeholder="comma separated"
                    className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-900"
                  />
                </Field>
              </div>

              <Field label="Pattern">
                <div className="flex flex-wrap gap-2">
                  {PATTERN_OPTIONS.map((p) => (
                    <Chip key={p} active={meta.pattern === p} onClick={() => setMeta({ ...meta, pattern: p })}>{p}</Chip>
                  ))}
                </div>
              </Field>

              <Field label="Style">
                <div className="flex flex-wrap gap-2">
                  {STYLE_OPTIONS.map((s) => (
                    <Chip key={s} active={meta.style === s} onClick={() => setMeta({ ...meta, style: s })}>{s}</Chip>
                  ))}
                </div>
              </Field>

              <Field label="Season">
                <div className="flex flex-wrap gap-2">
                  {SEASON_OPTIONS.map((s) => (
                    <Chip key={s} active={meta.season === s} onClick={() => setMeta({ ...meta, season: s })}>{s}</Chip>
                  ))}
                </div>
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Material">
                  <input
                    value={meta.material}
                    onChange={(e) => setMeta({ ...meta, material: e.target.value })}
                    className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-900"
                  />
                </Field>
                <Field label="Fit">
                  <input
                    value={meta.fit}
                    onChange={(e) => setMeta({ ...meta, fit: e.target.value })}
                    className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-900"
                  />
                </Field>
              </div>

              <div className="mt-6 flex gap-3">
                <button onClick={closeModal} className="flex-1 rounded-lg border border-stone-300 px-4 py-2.5 text-sm font-medium text-stone-700 hover:bg-stone-50">
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving || analyzing}
                  className="flex-1 rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50"
                >
                  {saving ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                    </span>
                  ) : editingId ? "Save Changes" : "Add to Wardrobe"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <label className="mb-1.5 block text-sm font-medium text-stone-700">{label}</label>
      {children}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize transition-all ${
        active ? "bg-stone-900 text-white" : "bg-stone-100 text-stone-600 hover:bg-stone-200"
      }`}
    >
      {children}
    </button>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-stone-300 px-3 py-2 text-sm capitalize text-stone-700 outline-none focus:border-stone-900"
    >
      {options.map(([v, label]) => (
        <option key={v} value={v} className="capitalize">
          {label}
        </option>
      ))}
    </select>
  );
}

function ClothingCard({
  item,
  onDelete,
  onEdit,
  onToggleFavorite,
}: {
  item: ClothingItem;
  onDelete: (item: ClothingItem) => void;
  onEdit: (item: ClothingItem) => void;
  onToggleFavorite: (item: ClothingItem) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="group relative overflow-hidden rounded-xl bg-stone-100 shadow-sm transition-all hover:shadow-md">
      <div className="aspect-square overflow-hidden">
        <img
          src={item.image_url}
          alt={item.category || item.clothing_type}
          className="h-full w-full object-cover transition-transform group-hover:scale-105"
        />
      </div>

      {/* Favorite */}
      <button
        onClick={() => onToggleFavorite(item)}
        className={`absolute left-2 top-2 rounded-lg p-1.5 backdrop-blur transition-all ${
          item.is_favorite ? "bg-white/80 text-rose-500" : "bg-black/30 text-white opacity-0 group-hover:opacity-100"
        }`}
        title={item.is_favorite ? "Unfavorite" : "Favorite"}
      >
        <Heart className={`h-3.5 w-3.5 ${item.is_favorite ? "fill-rose-500" : ""}`} />
      </button>

      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2">
        <p className="truncate text-xs font-medium text-white">{item.category || TYPE_LABELS[item.clothing_type]}</p>
        <p className="truncate text-[10px] text-white/70">
          {[item.primary_color, item.style].filter(Boolean).join(" · ")}
        </p>
      </div>

      {confirming ? (
        <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/60">
          <button onClick={() => onDelete(item)} className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600">
            Delete
          </button>
          <button onClick={() => setConfirming(false)} className="rounded-lg bg-white/20 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/30">
            Cancel
          </button>
        </div>
      ) : (
        <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button onClick={() => onEdit(item)} className="rounded-lg bg-black/40 p-1.5 text-white hover:bg-black/60" title="Edit">
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button onClick={() => setConfirming(true)} className="rounded-lg bg-black/40 p-1.5 text-white hover:bg-red-500" title="Delete">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
