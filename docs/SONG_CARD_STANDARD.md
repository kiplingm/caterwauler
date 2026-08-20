# Song Card Standard

Every place a song appears as a card in the UI — a **saved song** (a row from the `songs`
table) in Songbook, Sing Now, or a Setlist, or an **unsaved candidate** in Recommendations —
must be rendered by `buildSongCardHtml()` in `app.js`, and wired up by
`wireSongCardEvents()`. Do not hand-write a new `<div class="card">...` template. This is
what kept drifting before — Setlists and Recommendations each grew their own
slightly-different lookalike over time, styled and structured just differently enough to
feel inconsistent — and is the thing this doc exists to stop from happening again.

## The contract

A song card always has:

- **Range strip** — `renderCardStrip(low, high)`, the vertical red/green fit indicator.
- **Head** (`.card-top.card-head`, always visible) — title, artist, KaraFun badge if
  applicable, status pill (click to edit inline), chevron, last-played date.
- **Body** (`.card-body`, hidden until expanded) — fit line, key notes, source tag
  (est./verified), transpose suggestion if out of range, Spotify/YouTube links, genre tag,
  and the Performances / +Setlist / Edit action buttons.

**The card itself should never carry view-specific controls that aren't part of the
contract above.** If a view needs something a plain song card doesn't have — Setlist's
reorder/remove buttons, for instance — that thing goes *outside* the card, as a sibling
element in a wrapper the view owns, not inside `buildSongCardHtml()`'s output. That keeps
every card visually and structurally identical no matter where it's rendered, which is
the whole point of this doc. See `renderSetlistSongs()` / `.sl-song-row-wrap` for the
pattern: the card is unmodified, and `.sl-song-controls` sits next to it as its own
column.
- **Expand/collapse** — tapping the head toggles the body via `toggleCardExpand()`, backed
  by the module-level `expandedCardIds` Set so the state survives re-renders (search,
  filter, sort, a status change elsewhere).

Anything a specific view needs beyond that goes in one of `buildSongCardHtml()`'s
extension points instead of a parallel template:

| Option | Use it for |
|---|---|
| `cardKey` | Expand-state/DOM-lookup key, when it must differ from `song.id` — e.g. Setlists key on the `setlist_songs` row id (duplicate songs in one list), Recommendations key on a `"title\|artist"` string (no id exists yet). |
| `extraClasses` | View-specific class on the outer `.card`, e.g. `sing-now-card`, `sl-song-row`, `rec-item`. |
| `contentClass` | View-specific class on `.card-content`, for padding tweaks. |
| `leadingHead` | Extra markup at the start of the head row, e.g. a setlist position number. |
| `headExtra` | Extra markup in the head's right side, before the chevron — alongside or instead of the status pill, e.g. a recommendation's fit badge. |
| `bodyPrefix` | Extra markup at the top of the body, before the range info, e.g. a recommendation's source label ("By Ed Sheeran" / genre match). |
| `bodyActions` | Override the default Performances/+Setlist/Edit block with different action buttons — for candidates that aren't saved songs yet, e.g. a recommendation's Add/Dismiss. Pass raw HTML; `null` (default) keeps the standard actions when `song.id` is set. |
| `keyNotes` | Pass `null` to suppress (Sing Now hides key notes to keep picks terse). |
| `showLastPlayed` | Set `false` to hide the last-played line. |
| `footer` | Always-visible content below the body, inside the card, outside the expand gate. Not currently used by any caller — Setlist's move/remove controls turned out to belong *outside* the card entirely (see below), not just outside the expand gate, so they're a sibling in `.sl-song-row-wrap` instead. Kept as an option for a future case where something genuinely belongs inside the card but outside the body. |

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

## Intentional exception (not a song card)

One UI element looks card-adjacent but is deliberately **not** built from
`buildSongCardHtml()`, because it represents something with even less shape than a
recommendation candidate:

- **KaraFun catalog fallback rows** (`.catalog-fallback-item`, shown when a Songbook search
  matches nothing locally) — a lightweight title/artist/+Add row. No range data, no fit,
  no source, nothing to expand — just enough to offer "add this." If this ever grows
  real content (a fit estimate, a preview link), that's the moment to reconsider whether
  it should become a `buildSongCardHtml()` call with its own `bodyActions`/`bodyPrefix`,
  the same way recommendation candidates are.

Recommendation candidates (`.rec-item` in the Recommendations sheet) *are* built from
`buildSongCardHtml()` — they're not saved songs, so they have no `song.id`/status, but
they use `headExtra` for the fit badge, `bodyPrefix` for the source label, and
`bodyActions` for Add/Dismiss in place of Performances/+Setlist/Edit. This used to be a
hand-rolled lookalike with its own CSS and its own expand-state tracking
(`expandedRecKeys`) — it looked similar to a song card but wasn't actually built from the
same code, which is exactly the kind of drift this doc exists to prevent. Don't reintroduce
a parallel `.rec-item` template if it needs to change; extend `buildSongCardHtml()` instead.

## Where things live

- `buildSongCardHtml(song, opts)` — app.js, just after `renderRangeInfo()`.
- `wireSongCardEvents(container, refresh)` — app.js, immediately after
  `buildSongCardHtml()`.
- `toggleCardExpand(id)` / `expandedCardIds` — app.js, unchanged, shared by all callers
  (including recommendation candidates, keyed by `"title|artist"` instead of a DB id).
- Callers: `renderSongbook()`, `renderSingNow()`, `renderSetlistSongs()`,
  `renderRecommendations()`.
