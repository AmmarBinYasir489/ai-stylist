# AI Closet Stylist — Setup

A wardrobe app that (1) auto-analyzes uploaded clothing with Groq vision, (2) has
a Groq LLM assemble & rank complete outfits with reasons, and (3) previews each
look layered on a mannequin. Backend is Supabase (auth + storage + Postgres +
Edge Functions). **Your Groq key lives only in a Supabase secret — never in the browser.**

---

## 1. Create the Supabase project

1. Go to https://supabase.com → sign in → **New project**.
2. Name it (e.g. `closet-stylist`), set a database password, pick a region, create.
3. Wait ~2 min for it to provision.

## 2. Run the database migration

1. In the dashboard: **SQL Editor → New query**.
2. Paste the entire contents of
   [`supabase/migrations/20260714090000_create_stylist_schema.sql`](supabase/migrations/20260714090000_create_stylist_schema.sql)
   and click **Run**.
   - This creates `profiles`, `clothing_items`, `saved_outfits`, the
     `wardrobe-images` storage bucket, and all row-level-security policies.

## 3. Turn OFF email confirmation (so sign-up logs you straight in)

**Authentication → Providers → Email →** disable *Confirm email* → Save.

## 4. Add your frontend env vars

1. **Project Settings → API.** Copy the **Project URL** and the **anon public** key.
2. In this folder: `cp .env.example .env` and paste both values in.

## 5. Deploy the two Edge Functions (holds the Groq key)

Install the Supabase CLI once: https://supabase.com/docs/guides/cli
(`npm i -g supabase`, or `scoop install supabase` on Windows).

```bash
supabase login
supabase link --project-ref YOUR-PROJECT-REF        # ref is in the dashboard URL / Settings→General

# Store your Groq key as a server-side secret (NOT in the frontend):
supabase secrets set GROQ_API_KEY=gsk_your_groq_key_here

# Deploy both functions:
supabase functions deploy analyze-clothing
supabase functions deploy generate-outfits
```

Optional model overrides (defaults shown):
```bash
supabase secrets set GROQ_VISION_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
supabase secrets set GROQ_TEXT_MODEL=llama-3.3-70b-versatile
```

## 6. Run it

```bash
npm install      # already done
npm run dev
```

Open the printed URL, create an account, and:
- **Wardrobe tab** → drop clothing photos. Each is auto-analyzed; edit any field, then save. Filter/search, favorite, edit, delete.
- **Outfits tab** → pick an occasion, hit **Style Me**. The AI ranks the best complete looks, each shown on a mannequin with a reason. Save the ones you like.

---

### Troubleshooting
- **Blank screen + console error about env vars** → `.env` missing/empty, or you didn't restart `npm run dev`.
- **Upload works but no AI details** → the `analyze-clothing` function isn't deployed, or `GROQ_API_KEY` secret isn't set.
- **"GROQ_API_KEY is not configured"** → run the `supabase secrets set` step, then redeploy the functions.
- **Outfit generation 401/403** → make sure email confirmation is OFF and you're signed in.
