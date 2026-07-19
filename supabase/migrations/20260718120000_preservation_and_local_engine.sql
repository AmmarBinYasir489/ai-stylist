/*
  Preservation & local-engine upgrade
  -----------------------------------
  - content_hash  : sha256 of the original upload. Enables dedup — re-uploading
                    the same photo skips background removal, storage AND the
                    AI analysis call entirely.
  - colors        : pixel-exact palette [{hex, name, coverage}] extracted
                    client-side in CIELAB (replaces LLM color guessing).
  - bbox          : garment's alpha bounding box {x,y,w,h,aspect} — drives
                    proportional garment scaling on the mannequin.
  - original_url  : the untouched upload, preserved so items can always be
                    reprocessed at full quality later.

  Outfit generation now runs locally in the client (deterministic rules +
  CIELAB color-harmony scoring). The generate-outfits edge function is no
  longer called by the app.
*/

ALTER TABLE clothing_items
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS colors jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS bbox jsonb,
  ADD COLUMN IF NOT EXISTS original_url text;

-- One wardrobe entry per unique source photo per user.
CREATE UNIQUE INDEX IF NOT EXISTS clothing_items_user_hash_idx
  ON clothing_items (user_id, content_hash)
  WHERE content_hash IS NOT NULL;

-- Scope uploads to the user's own folder (was: any authed user could write
-- anywhere in the bucket).
DROP POLICY IF EXISTS "auth_upload_wardrobe" ON storage.objects;
CREATE POLICY "auth_upload_wardrobe" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'wardrobe-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- Cascade: deleting a clothing item deletes every saved outfit that uses it.
-- saved_outfits references items only inside outfit_data->'item_ids' (jsonb),
-- so a normal FK cascade can't cover it — a trigger does.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_outfits_containing_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.saved_outfits
  WHERE user_id = OLD.user_id
    AND outfit_data->'item_ids' @> to_jsonb(OLD.id::text);
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS on_clothing_item_deleted ON clothing_items;
CREATE TRIGGER on_clothing_item_deleted
  AFTER DELETE ON clothing_items
  FOR EACH ROW EXECUTE FUNCTION public.delete_outfits_containing_item();

-- One-time cleanup: remove saved outfits that already reference items which
-- no longer exist (deleted before this trigger was in place).
DELETE FROM saved_outfits so
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements_text(so.outfit_data->'item_ids') AS ref(id)
  WHERE NOT EXISTS (SELECT 1 FROM clothing_items ci WHERE ci.id::text = ref.id)
);
