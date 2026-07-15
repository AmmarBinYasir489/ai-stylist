import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/*
  analyze-clothing
  ----------------
  Takes an uploaded clothing image and returns structured metadata using
  Groq's Llama 4 Scout vision model. The Groq API key lives only here as a
  Supabase secret (GROQ_API_KEY) and is never exposed to the browser.

  Request:  POST { image_url: string }   (public URL of the uploaded photo)
  Response: 200  { metadata: { category, clothing_type, primary_color,
                                secondary_colors[], pattern, style, season,
                                material, fit } }
*/

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const VISION_MODEL = Deno.env.get("GROQ_VISION_MODEL") || "meta-llama/llama-4-scout-17b-16e-instruct";

const CLOTHING_TYPES = ["top", "bottom", "footwear", "outerwear", "accessory"] as const;

const SYSTEM_PROMPT = `You are a fashion cataloguing assistant. Look at the single clothing item in the image and return ONLY a JSON object describing it. Do not include prose.

Return exactly these fields:
{
  "category": string,            // specific garment name, e.g. "T-Shirt", "Jeans", "Blazer", "Sneakers", "Watch"
  "clothing_type": string,       // one of: "top", "bottom", "footwear", "outerwear", "accessory"
  "primary_color": string,       // single lowercase color word, e.g. "navy", "white", "olive"
  "secondary_colors": string[],  // 0-3 other lowercase colors present, [] if none
  "pattern": string,             // e.g. "solid", "striped", "plaid", "floral", "graphic", "checked"
  "style": string,               // one of: "casual", "formal", "smart casual", "streetwear", "sporty", "business"
  "season": string,              // one of: "summer", "winter", "spring", "fall", "all-season"
  "material": string,            // best guess, e.g. "cotton", "denim", "leather", "wool", "polyester", "unknown"
  "fit": string                  // e.g. "slim", "regular", "relaxed", "oversized", "unknown"
}

Rules:
- clothing_type MUST be one of the five allowed values. Map: shirts/tees/tops/sweaters/blouses -> "top"; pants/jeans/shorts/skirts/trousers -> "bottom"; shoes/sneakers/boots/heels/sandals -> "footwear"; jackets/coats/blazers/hoodies-as-outer-layer -> "outerwear"; watches/hats/bags/belts/scarves/jewelry/sunglasses -> "accessory".
- Use simple, common color names.
- If a field is genuinely undetectable, use "unknown" (for arrays use []).`;

function normalizeType(t: unknown): string {
  const v = String(t || "").toLowerCase().trim();
  return (CLOTHING_TYPES as readonly string[]).includes(v) ? v : "top";
}

function coerceMetadata(raw: Record<string, unknown>) {
  const secondary = Array.isArray(raw.secondary_colors)
    ? raw.secondary_colors.map((c) => String(c).toLowerCase()).filter(Boolean).slice(0, 3)
    : [];
  return {
    category: String(raw.category || "Item").trim(),
    clothing_type: normalizeType(raw.clothing_type),
    primary_color: String(raw.primary_color || "unknown").toLowerCase().trim(),
    secondary_colors: secondary,
    pattern: String(raw.pattern || "solid").toLowerCase().trim(),
    style: String(raw.style || "casual").toLowerCase().trim(),
    season: String(raw.season || "all-season").toLowerCase().trim(),
    material: String(raw.material || "unknown").toLowerCase().trim(),
    fit: String(raw.fit || "regular").toLowerCase().trim(),
  };
}

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

    const { image_url } = await req.json().catch(() => ({}));
    if (!image_url || typeof image_url !== "string") {
      return json({ error: "image_url is required." }, 400);
    }

    const groqRes = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        temperature: 0.2,
        max_tokens: 500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "Analyze this clothing item and return the JSON metadata." },
              { type: "image_url", image_url: { url: image_url } },
            ],
          },
        ],
      }),
    });

    if (!groqRes.ok) {
      const detail = await groqRes.text().catch(() => "");
      return json({ error: `Groq vision request failed (${groqRes.status}).`, detail }, 502);
    }

    const data = await groqRes.json();
    const content = data?.choices?.[0]?.message?.content ?? "{}";

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch {
      return json({ error: "Could not parse AI response.", raw: content }, 502);
    }

    return json({ metadata: coerceMetadata(parsed) });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Unexpected error." }, 500);
  }
});
