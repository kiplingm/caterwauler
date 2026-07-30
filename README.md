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
- `setlists` (name, optional gig date/venue/notes) and `setlist_songs`
  (join table with a `position` column for ordering) let a user build
  named, ordered song lists — either a reusable collection or one tied
  to a specific gig date. Both are scoped per-user via `user_id` and RLS,
  same pattern as `songs`/`performances`. Songs are added manually —
  either from a setlist's own "Add songs" search, or via a "+ Setlist"
  button on every song card in the main songbook list, which opens a
  picker to add that song straight to an existing setlist or a
  newly-named one (`openAddToSetlist` in `app.js`). Reordering
  re-numbers every row's `position` rather than patching just the two
  swapped rows, since positions can develop gaps after a song is removed.
- Uses Supabase's newer **publishable key** (`sb_publishable_...`), not
  the legacy anon key.

## Recommendations
The Recs sheet (✨) searches `karafun_catalog` for songs by artists related
to your Solid songs, gates every candidate on vocal range via
`song_ranges`, and groups results into in-range / would-need-a-key-change
/ range-unconfirmed. Seed artists come from three tiers (`buildSeedArtists`
in `app.js`), each with a smaller per-artist cap the further it gets from
a proven Solid artist:
- **Solid** — artists you're already Solid on (cap 10 songs/artist).
- **Genre** — other artists already in your songbook (any status but
  Retired) sharing a genre tag with a Solid song (cap 4).
- **Similar** — real similar-artist data from Last.fm's `artist.getsimilar`
  API, for your top 8 Solid artists by song count (cap 4). Only runs if a
  free Last.fm API key is saved under Settings > Recommendations; the key
  lives in `localStorage` only, not Supabase.

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
- Shazam-style song ID: let a user record/hum a snippet (or point at a
  live speaker) to identify a song and jump straight to adding/rating it
  in the songbook, instead of manual search entry.
