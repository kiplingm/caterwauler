# Setlist Sherpa
Live, multi-user karaoke songbook synced to Supabase.

This is the one and only app in active use — an earlier separate project
(`karaoke-app`, a React rebuild on Vercel) was retired in favor of adding
multi-user support directly to this app instead. Nothing else reads or
writes this database going forward.

## Structure
- `index.html` — markup and sheet layouts, including the sign-in gate
- `styles.css` — all styling
- `app.js` — app logic (auth, Supabase calls, rendering, vocal range math,
  recommendations, venue search)

## Auth & data model
- Sign-in is magic link / OTP via Supabase Auth (no passwords) — see the
  `authClient`/`onSignedIn` flow at the top and bottom of `app.js`.
- `songs` and `performances` are scoped per-user via a `user_id` column
  and RLS policies (`auth.uid() = user_id`). Each signed-in user only
  ever sees their own songbook.
- `profiles` holds each user's vocal range: either `range_mode = 'auto'`
  (computed from the widest span among Solid-status songs with a known
  range) or `'manual'` (typed in directly under Settings > Vocal Range).
- `karafun_catalog` (~84k songs) and `song_ranges` (shared vocal-range
  lookup, matched by normalized title+artist) are shared reference data,
  open to all signed-in users — not scoped per-user.
- Uses Supabase's newer **publishable key** (`sb_publishable_...`), not
  the legacy anon key.

## Tests
`tests.js` unit-tests the pure logic in `app.js` (note/semitone math, range fit scoring, transpose suggestions, string normalization) by extracting those functions straight from the shipped source — not a hand-copied duplicate, so it can't silently drift out of sync. It does not test DOM/UI behavior, Supabase calls, or auth.

Run with:
```
node tests.js
```

## Known open items
- App icons for `public`/PWA install are still placeholder/empty.
- Some songs in the songbook don't have a matching `karafun_catalog`
  entry due to text normalization gaps (e.g. "and" vs "&" in artist
  names) — catalog-dependent features (autocomplete, range auto-fill)
  just won't fire for those specific songs.

## To do
- Create test users and support admin impersonation of them, restricted
  to admins only. `kiplingm@gmail.com` is the only admin for now — needs
  an `is_admin` flag (or admin allowlist) plus an impersonation flow that
  respects the existing per-user RLS policies rather than bypassing them
  outright.
