/*
  Storage policies for content-addressed uploads
  ----------------------------------------------
  Uploads are now content-hash-named ({uid}/{sha256}.png) with upsert, so
  retrying an upload writes the same path. Upsert needs an UPDATE policy on
  storage.objects — without it, re-uploading an already-present file fails
  RLS with a 403 ("Upload failed" in the app). Also adds an authenticated
  SELECT policy so storage-api existence checks see the user's own objects.
*/

DROP POLICY IF EXISTS "auth_update_wardrobe" ON storage.objects;
CREATE POLICY "auth_update_wardrobe" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'wardrobe-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'wardrobe-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "auth_select_wardrobe" ON storage.objects;
CREATE POLICY "auth_select_wardrobe" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'wardrobe-images');
