/*
  # AI Closet Stylist — full schema

  Tables
  --------
  - profiles         : one row per auth user (name, avatar_url). Auto-created on sign-up.
  - clothing_items   : wardrobe pieces with AI-extracted metadata.
  - saved_outfits    : outfits the user chose to keep, with the AI's reasoning.

  Storage
  --------
  - `wardrobe-images` public bucket for uploaded clothing photos.

  Security
  --------
  - RLS enabled on every table, scoped to the owning user (auth.uid()).
  - Storage: authenticated users upload to / delete from the bucket; objects are
    served via public URL (no SELECT policy needed for a public bucket).

  Notes
  --------
  - clothing_type is the structural slot used by the mannequin renderer and the
    outfit generator: one of top / bottom / footwear / outerwear / accessory.
  - category is the specific garment label (e.g. "T-Shirt", "Jeans", "Sneakers").
*/

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profiles (
  id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name       text,
  avatar_url text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_profile" ON profiles;
CREATE POLICY "select_own_profile" ON profiles
  FOR SELECT TO authenticated USING (auth.uid() = id);

DROP POLICY IF EXISTS "insert_own_profile" ON profiles;
CREATE POLICY "insert_own_profile" ON profiles
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "update_own_profile" ON profiles;
CREATE POLICY "update_own_profile" ON profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- Auto-create a profile row whenever a new auth user signs up.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, name)
  VALUES (NEW.id, split_part(NEW.email, '@', 1))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ---------------------------------------------------------------------------
-- clothing_items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clothing_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  image_url        text NOT NULL,
  category         text,
  clothing_type    text NOT NULL DEFAULT 'top'
                     CHECK (clothing_type IN ('top', 'bottom', 'footwear', 'outerwear', 'accessory')),
  primary_color    text,
  secondary_colors text[] DEFAULT '{}',
  pattern          text,
  style            text,
  season           text,
  material         text,
  fit              text,
  is_favorite      boolean DEFAULT false,
  created_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS clothing_items_user_id_idx ON clothing_items(user_id);

ALTER TABLE clothing_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_clothing_items" ON clothing_items;
CREATE POLICY "select_own_clothing_items" ON clothing_items
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "insert_own_clothing_items" ON clothing_items;
CREATE POLICY "insert_own_clothing_items" ON clothing_items
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "update_own_clothing_items" ON clothing_items;
CREATE POLICY "update_own_clothing_items" ON clothing_items
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "delete_own_clothing_items" ON clothing_items;
CREATE POLICY "delete_own_clothing_items" ON clothing_items
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- saved_outfits
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_outfits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  name        text NOT NULL DEFAULT 'Outfit',
  outfit_data jsonb NOT NULL,       -- { item_ids: uuid[], occasion, score, ... }
  ai_reason   text,
  occasion    text,
  score       int,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS saved_outfits_user_id_idx ON saved_outfits(user_id);

ALTER TABLE saved_outfits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_saved_outfits" ON saved_outfits;
CREATE POLICY "select_own_saved_outfits" ON saved_outfits
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "insert_own_saved_outfits" ON saved_outfits;
CREATE POLICY "insert_own_saved_outfits" ON saved_outfits
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "delete_own_saved_outfits" ON saved_outfits;
CREATE POLICY "delete_own_saved_outfits" ON saved_outfits
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- storage: wardrobe-images bucket
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('wardrobe-images', 'wardrobe-images', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DROP POLICY IF EXISTS "auth_upload_wardrobe" ON storage.objects;
CREATE POLICY "auth_upload_wardrobe" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'wardrobe-images');

DROP POLICY IF EXISTS "auth_delete_wardrobe" ON storage.objects;
CREATE POLICY "auth_delete_wardrobe" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'wardrobe-images' AND owner = auth.uid());
