import { useCallback, useMemo, useRef, useState } from "react";
import {
  supabase,
  STORAGE_BUCKET,
  type ClothingItem,
  type ClothingType,
  type ClothingMetadata,
  CLOTHING_TYPES,
  TYPE_LABELS,
  STYLE_OPTIONS,
  SEASON_OPTIONS,
  PATTERN_OPTIONS,
} from "../lib/supabase";
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

// Resize a blob, preserving transparency, and encode as PNG. Keeps uploads
// small (a 4MB phone photo becomes a few hundred KB) so the Supabase free-tier
// storage lasts far longer. Returns the original blob if anything goes wrong.
async function resizePng(blob: Blob, maxDim = 1024): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return blob;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const out: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return out || blob;
  } catch {
    return blob;
  }
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

async function analyzeImage(imageUrl: string): Promise<ClothingMetadata | null> {
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
  const [uploadedPath, setUploadedPath] = useState<string | null>(null); // only for new items, for cancel cleanup
  const [meta, setMeta] = useState<ClothingMetadata>(EMPTY_META);
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
      setBusyLabel("Removing background…");
      const cut = await cutout(file);
      setBusyLabel("Uploading…");
      const png = await resizePng(cut);
      const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
      const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(fileName, png, { contentType: "image/png" });
      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(fileName);
      const publicUrl = urlData.publicUrl;

      // Open the modal immediately with the image, analyze in the background.
      setEditingId(null);
      setUploadedPath(fileName);
      setPreviewUrl(publicUrl);
      setMeta(EMPTY_META);
      setModalOpen(true);
      setBusy(false);

      setAnalyzing(true);
      const detected = await analyzeImage(publicUrl);
      if (detected) setMeta(detected);
      setAnalyzing(false);
    } catch (err) {
      console.error("Upload failed:", err);
      alert("Upload failed. Please try again.");
      setBusy(false);
      setAnalyzing(false);
    }
  }, []);

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
    setUploadedPath(null);
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
    // If this was a new upload the user abandoned, clean up the orphaned file.
    if (editingId === null && uploadedPath) {
      await supabase.storage.from(STORAGE_BUCKET).remove([uploadedPath]);
    }
    setModalOpen(false);
    setUploadedPath(null);
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
        const { error } = await supabase
          .from("clothing_items")
          .insert({ ...payload, image_url: previewUrl });
        if (error) throw error;
      }

      setModalOpen(false);
      setUploadedPath(null);
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
    const path = pathFromUrl(item.image_url);
    if (path) await supabase.storage.from(STORAGE_BUCKET).remove([path]);
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
