# Song Card Standard

Every place a **saved song** (a row from the `songs` table) appears in the UI — Songbook,
Sing Now, and inside a Setlist — must be rendered by `buildSongCardHtml()` in `app.js`,
and wired up by `wireSongCardEvents()`. Do not hand-write a new `<div class="card">...`
template for a saved song. This is what kept drifting before (Setlists and Recommendations
each grew their own slightly-different card over time) and is the thing this doc exists to
stop from happening again.

## The contract

A song card always has:

- **Range strip** — `renderCardStrip(low, high)`, the vertical red/green fit indicator.
- **Head** (`.card-top.card-head`, always visible) — title, artist, KaraFun badge if
  applicable, status pill (click to edit inline), chevron, last-played date.
- **Body** (`.card-body`, hidden until expanded) — fit line, key notes, source tag
  (est./verified), transpose suggestion if out of range, Spotify/YouTube links, genre tag,
  and the Performances / +Setlist / Edit action buttons.
- **Expand/collapse** — tapping the head toggles the body via `toggleCardExpand()`, backed
  by the module-level `expandedCardIds` Set so the state survives re-renders (search,
  filter, sort, a status change elsewhere).

Anything a specific view needs beyond that goes in one of `buildSongCardHtml()`'s
extension points instead of a parallel template:

| Option | Use it for |
|---|---|
| `cardKey` | Expand-state/DOM-lookup key, when it must differ from `song.id` — e.g. Setlists key on the `setlist_songs` row id, since the same song can appear in a list twice. |
| `extraClasses` | View-specific class on the outer `.card`, e.g. `sing-now-card`, `sl-song-row`. |
| `contentClass` | View-specific class on `.card-content`, for padding tweaks. |
| `leadingHead` | Extra markup at the start of the head row, e.g. a setlist position number. |
| `keyNotes` | Pass `null` to suppress (Sing Now hides key notes to keep picks terse). |
| `showLastPlayed` | Set `false` to hide the last-played line. |
| `footer` | Always-visible content below the body, outside the expand gate — e.g. Setlist's move/remove row, which needs to work whether or not the card is expanded. |

Call `wireSongCardEvents(container, refresh)` once per render, right after setting
`container.innerHTML`, where `refresh` is whatever re-renders *that view* after a status
edit closes. Songbook and Sing Now pass the default (`render()`, the top-level view
dispatcher). Setlists passes `() => fetchSetlistSongs(currentSetlistId)`, because a
setlist's song sheet keeps its own local copy of song data (`currentSetlistSongs`)
separate from the main `songs` array.

## When you need something a song card doesn't do

Extend `buildSongCardHtml()` / `wireSongCardEvents()` with a new option — don't fork the
template. If a genuinely new interaction is needed (a new action button, a new footer
element), add it as another opt-in parameter so every existing caller stays correct by
default and only opts in where it applies.

## Intentional exceptions (not song cards)

Two UI elements look card-adjacent but are deliberately **not** built from
`buildSongCardHtml()`, because they represent something that isn't a saved song yet:

- **Recommendation candidates** (`.rec-item` in the Recommendations sheet) — these are
  KaraFun catalog matches the person hasn't added to their songbook. They have their own
  collapsed/expanded pattern (`renderRecommendations()` / `expandedRecKeys`) that mirrors
  the song card's head/body/chevron feel, but the actions are Add/Dismiss, not
  Performances/Edit, and there's no DB id or status until the person adds it.
- **KaraFun catalog fallback rows** (`.catalog-fallback-item`, shown when a Songbook search
  matches nothing locally) — a lightweight title/artist/+Add row for the same reason:
  nothing to expand, no status, no id yet.

If either of these ever grows enough behavior to want real parity with a song card (e.g.
Spotify/YouTube preview links, which recommendations already borrowed), that's a sign it
may be time to represent it as a card-shaped view over an unsaved candidate — worth a
deliberate decision, not an accidental copy-paste.

## Where things live

- `buildSongCardHtml(song, opts)` — app.js, just after `renderRangeInfo()`.
- `wireSongCardEvents(container, refresh)` — app.js, immediately after
  `buildSongCardHtml()`.
- `toggleCardExpand(id)` / `expandedCardIds` — app.js, unchanged, shared by all callers.
- Callers: `renderSongbook()`, `renderSingNow()`, `renderSetlistSongs()`.
