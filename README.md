# karaoke-tracker
Live karaoke songbook synced to Supabase

## Structure
- `index.html` — markup and sheet layouts
- `styles.css` — all styling
- `app.js` — app logic (Supabase calls, rendering, vocal range math, recommendations, venue search)

## Tests
`tests.js` unit-tests the pure logic in `app.js` (note/semitone math, range fit scoring, transpose suggestions, string normalization) by extracting those functions straight from the shipped source — not a hand-copied duplicate, so it can't silently drift out of sync. It does not test DOM/UI behavior or Supabase calls.

Run with:
```
node tests.js
```

