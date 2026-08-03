import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/*
  analyze-clothing
  ----------------
  The ONLY AI call in the pipeline. Takes the background-removed cutout and
  returns categorical metadata using Groq's Llama 4 Scout vision model. The
  Groq API key lives only here as a Supabase secret (GROQ_API_KEY).

  Colors are deliberately NOT asked of the model — the client extracts exact
  colors from the garment's pixels (CIELAB k-means), which is deterministic,
  free, and immune to hallucination. Keeping colors out of the prompt also
  shrinks the response (fewer output tokens per call).

  Request:  POST { image_url: string }   (public URL of the cutout PNG)
  Response: 200  { metadata: { category, clothing_type, pattern, style,
                                season, material, fit } }
*/

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// NOTE: Groq removed the Llama 4 vision models (llama-4-scout returned 404 as
// of 2026-07). qwen3.6-27b is the multimodal model currently available.
const VISION_MODEL = Deno.env.get("GROQ_VISION_MODEL") || "qwen/qwen3.6-27b";
const MAX_BODY_BYTES = 16 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 12;
const rateLimitBuckets = new Map<string, number[]>();

const CLOTHING_TYPES = ["top", "bottom", "footwear", "outerwear", "accessory"] as const;

const SYSTEM_PROMPT = `You are a fashion cataloguing assistant. Look at the single clothing item in the image and return ONLY a JSON object describing it. Do not include prose.

Return exactly these fields:
{
  "category": string,            // specific garment name, e.g. "T-Shirt", "Jeans", "Blazer", "Sneakers", "Watch"
  "clothing_type": string,       // one of: "top", "bottom", "footwear", "outerwear", "accessory"
  "pattern": string,             // e.g. "solid", "striped", "plaid", "floral", "graphic", "checked"
  "style": string,               // one of: "casual", "formal", "smart casual", "streetwear", "sporty", "business"
  "season": string,              // one of: "summer", "winter", "spring", "fall", "all-season"
  "material": string,            // best guess, e.g. "cotton", "denim", "leather", "wool", "polyester", "unknown"
  "fit": string                  // e.g. "slim", "regular", "relaxed", "oversized", "unknown"
}

Rules:
- clothing_type MUST be one of the five allowed values. Map: shirts/tees/tops/sweaters/blouses -> "top"; pants/jeans/shorts/skirts/trousers -> "bottom"; shoes/sneakers/boots/heels/sandals -> "footwear"; jackets/coats/blazers/hoodies-as-outer-layer -> "outerwear"; watches/hats/bags/belts/scarves/jewelry/sunglasses -> "accessory".
- Do NOT describe colors; they are measured separately.
- If a field is genuinely undetectable, use "unknown".`;

function normalizeType(t: unknown): string {
  const v = String(t || "").toLowerCase().trim();
  return (CLOTHING_TYPES as readonly string[]).includes(v) ? v : "top";
}

function requestKey(req: Request): string {
  const auth = req.headers.get("authorization");
  if (auth) return auth.slice(-64);
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anonymous";
}

function rateLimit(key: string): number | null {
  const now = Date.now();
  const active = (rateLimitBuckets.get(key) || []).filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
  );
  if (active.length >= RATE_LIMIT_MAX_REQUESTS) {
    rateLimitBuckets.set(key, active);
    return Math.ceil((RATE_LIMIT_WINDOW_MS - (now - active[0])) / 1000);
  }
  active.push(now);
  rateLimitBuckets.set(key, active);
  return null;
}

function parseImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function coerceMetadata(raw: Record<string, unknown>) {
  const text = (value: unknown, fallback: string, max = 80) => {
    const normalized = String(value || fallback).trim().slice(0, max);
    return normalized || fallback;
  };
  return {
    category: text(raw.category, "Item"),
    clothing_type: normalizeType(raw.clothing_type),
    pattern: text(raw.pattern, "solid", 40).toLowerCase(),
    style: text(raw.style, "casual", 40).toLowerCase(),
    season: text(raw.season, "all-season", 24).toLowerCase(),
    material: text(raw.material, "unknown", 40).toLowerCase(),
    fit: text(raw.fit, "regular", 40).toLowerCase(),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...corsHeaders, Allow: "POST, OPTIONS" },
    });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const contentLength = Number(req.headers.get("content-length") || "0");
    if (contentLength > MAX_BODY_BYTES) {
      return json({ error: "Request body is too large." }, 413);
    }

    const retryAfter = rateLimit(requestKey(req));
    if (retryAfter !== null) {
      return new Response(
        JSON.stringify({ error: "Too many analysis requests. Please try again shortly." }),
        {
          status: 429,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "Retry-After": String(retryAfter),
          },
        },
      );
    }

    const groqKey = Deno.env.get("GROQ_API_KEY");
    if (!groqKey) return json({ error: "GROQ_API_KEY is not configured on the server." }, 500);

    const { image_url } = await req.json().catch(() => ({}));
    const imageUrl = parseImageUrl(image_url);
    if (!imageUrl) {
      return json({ error: "image_url must be a valid HTTPS URL." }, 400);
    }

    const groqRes = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        temperature: 0,
        // qwen3.6 is a reasoning model: disable thinking for this simple
        // labeling task (fewer output tokens, faster) but keep a roomy cap
        // in case a future model ignores reasoning_effort.
        reasoning_effort: "none",
        max_tokens: 2048,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "Analyze this clothing item and return the JSON metadata." },
              { type: "image_url", image_url: { url: imageUrl } },
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
