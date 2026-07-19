import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

/*
  generate-outfits  [DEPRECATED — no longer called by the app]
  ----------------
  Outfit generation now runs locally in the client (src/lib/outfitEngine.ts)
  with deterministic rules + CIELAB color-harmony scoring: zero API usage,
  instant results, and the same wardrobe always produces the same ranking.
  This function is kept only as a reference / fallback.

  Sends the user's wardrobe metadata to a Groq LLM which acts as a stylist:
  it evaluates color harmony, style/formality match, season and pattern
  clashes, then returns ONLY the best-scoring outfits, each with a short
  reason. Nothing is brute-forced and nothing is auto-persisted — the client
  decides which outfits to save.

  Request:  POST { occasion?: string }
  Response: 200  { outfits: [{ name, item_ids[], occasion, score, reason }] }
*/

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const TEXT_MODEL = Deno.env.get("GROQ_TEXT_MODEL") || "llama-3.3-70b-versatile";

interface ClothingItem {
  id: string;
  category: string | null;
  clothing_type: string;
  primary_color: string | null;
  secondary_colors: string[] | null;
  pattern: string | null;
  style: string | null;
  season: string | null;
  material: string | null;
  fit: string | null;
}

const SYSTEM_PROMPT = `You are an expert personal fashion stylist. You are given a wardrobe as a list of clothing items, each with an id and attributes (category, clothing_type, colors, pattern, style, season, fit).

Assemble the BEST complete outfits from these items. Judge each outfit on:
- Color harmony. Complementary and neutral pairings both work. IMPORTANT: monochrome and tonal looks are stylish, not a flaw — an all-black outfit (e.g. black top + black bottom), all-white, or neutral-on-neutral (black/grey/white/beige/navy) is a timeless, high-scoring combination. Only penalize genuine clashes (e.g. red + orange + green together, or two clashing bright hues).
- Style & formality consistency (don't mix formal with sporty).
- Season coherence.
- Pattern balance (avoid multiple loud patterns together).

Rules for a valid outfit:
- MUST include exactly one "top" and one "bottom" (or a single item that covers both if present).
- SHOULD include one "footwear" if any exists in the wardrobe.
- MAY include one "outerwear" and/or one "accessory" when it improves the look.
- Never use the same item twice in one outfit. Only use item ids that exist in the wardrobe.

Return ONLY a JSON object of this exact shape:
{
  "outfits": [
    {
      "name": string,                 // short catchy name, e.g. "Smart Weekend"
      "item_ids": string[],           // ids of items in this outfit
      "occasion": string,             // e.g. "casual", "work", "formal", "date", "weekend"
      "score": number,                // 0-100 quality score
      "reason": string                // 1-2 sentences on why this outfit works
    }
  ]
}

Return only genuinely good outfits (score >= 60), best first, at most 6. If the wardrobe cannot form a valid outfit, return {"outfits": []}.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const groqKey = Deno.env.get("GROQ_API_KEY");
    if (!groqKey) return json({ error: "GROQ_API_KEY is not configured on the server." }, 500);

    // Use the caller's JWT so RLS returns only their wardrobe.
    const authHeader = req.headers.get("Authorization") || "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { occasion } = await req.json().catch(() => ({}));

    const { data: items, error } = await supabase
      .from("clothing_items")
      .select("id, category, clothing_type, primary_color, secondary_colors, pattern, style, season, material, fit");

    if (error) return json({ error: error.message }, 500);

    const wardrobe = (items || []) as ClothingItem[];
    const hasTop = wardrobe.some((i) => i.clothing_type === "top");
    const hasBottom = wardrobe.some((i) => i.clothing_type === "bottom");
    if (!hasTop || !hasBottom) {
      return json({ error: "You need at least one top and one bottom to generate outfits." }, 400);
    }

    const userPrompt = [
      occasion ? `Preferred occasion: ${occasion}.` : "No specific occasion — suggest a range.",
      "Wardrobe:",
      JSON.stringify(
        wardrobe.map((i) => ({
          id: i.id,
          category: i.category,
          clothing_type: i.clothing_type,
          primary_color: i.primary_color,
          secondary_colors: i.secondary_colors,
          pattern: i.pattern,
          style: i.style,
          season: i.season,
          fit: i.fit,
        })),
      ),
    ].join("\n");

    const groqRes = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${groqKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: TEXT_MODEL,
        temperature: 0.6,
        max_tokens: 1500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!groqRes.ok) {
      const detail = await groqRes.text().catch(() => "");
      return json({ error: `Groq request failed (${groqRes.status}).`, detail }, 502);
    }

    const data = await groqRes.json();
    const content = data?.choices?.[0]?.message?.content ?? "{}";

    let parsed: { outfits?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch {
      return json({ error: "Could not parse AI response.", raw: content }, 502);
    }

    const validIds = new Set(wardrobe.map((i) => i.id));
    const outfitsRaw = Array.isArray(parsed.outfits) ? parsed.outfits : [];

    // Validate/sanitize the AI output so the UI can trust it.
    const outfits = outfitsRaw
      .map((o: Record<string, unknown>) => {
        const ids = Array.isArray(o.item_ids)
          ? [...new Set(o.item_ids.map(String))].filter((id) => validIds.has(id))
          : [];
        return {
          name: String(o.name || "Outfit").slice(0, 60),
          item_ids: ids,
          occasion: String(o.occasion || occasion || "casual").toLowerCase(),
          score: Math.max(0, Math.min(100, Number(o.score) || 0)),
          reason: String(o.reason || ""),
        };
      })
      .filter((o) => {
        const types = new Set(
          o.item_ids.map((id) => wardrobe.find((w) => w.id === id)?.clothing_type),
        );
        return types.has("top") && types.has("bottom");
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    return json({ outfits });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Unexpected error." }, 500);
  }
});
