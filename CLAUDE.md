# Caterwauler — notes for Claude Code

Karaoke/vocal songbook web app. Solo developer (Kipling, GitHub `kiplingm`) plus a small
invite-only group of testers. Live at https://kiplingm.github.io/caterwauler/. Read `README.md`
for the data model and `docs/SONG_CARD_STANDARD.md` before touching any song card.

## Stack (no build step — keep it that way)
- Vanilla JS / HTML / CSS: `index.html`, `styles.css`, `app.js`. No bundler, no framework, no npm deps.
- Backend: Supabase (Postgres + RLS + Edge Functions), project ID `luykkuptcizkdigwness`.
- Hosting: GitHub Pages, deployed from `main`. Pushing to `main` is a production deploy.
- Data calls are plain `fetch()` against `${SUPABASE_URL}/rest/v1/...` with the shared `HEADERS`
  object (its Authorization is swapped to the user's session token in `onSignedIn()`).
  `authClient` (supabase-js) is used only for sign-in/session management. Follow that split.
- The UI is themed with CSS variables (`--bg`, `--bg-raised`, `--line`, `--cream`, `--gold`,
  `--teal`, `--red`, …) across four themes. Never hardcode colors. Overlays use the existing
  `.sheet` / `.sheet-backdrop` pattern plus `enableSwipeToDismiss()`.

## Pre-commit checklist — every build, no exceptions
1. `node --check app.js`
2. `node tests.js` — all tests must pass (currently 47; tests extract pure functions from
   `app.js` source, so they exercise what actually ships)
3. Bump `BUILD_VERSION` in `app.js` (currently "73")
4. Bump the cache-bust params in `index.html`: `app.js?v=N` and `styles.css?v=N`
   (bump the CSS one whenever `styles.css` changed; they are independent numbers)
Commit messages follow "Build N: what changed and why". Git identity for commits:
`user.name "kiplingm"`, `user.email "kiplingm@users.noreply.github.com"`.
Never put tokens, keys, or PATs in the repo, in commit messages, or in this file.

## Architecture rules that were learned the hard way
- **Song cards:** every song card is rendered by `buildSongCardHtml()` and wired by
  `wireSongCardEvents()`. Never hand-roll a card template in a view. View-specific controls go
  outside the card as a sibling (see `.sl-song-row-wrap` / `.sl-song-controls`).
- **CSS class names are global.** Generic names get reused by unrelated buttons and break
  silently (`.rec-add-btn` / `.rec-dismiss-btn` did — the rec card actions are now
  `.rec-add-action` / `.rec-dismiss-action`). Grep for a class before reusing or renaming it.
- **Impersonation is a real session.** The `admin-impersonate` Edge Function mints a genuine
  session for the tester, so `auth.uid()` IS the tester. The admin's own session is stashed in
  `sessionStorage` key `ss_impersonate_return` (`admin_email` identifies who is driving).
  Don't build features that assume "effective user" differs from `auth.uid()`.
- **Admin gating:** `isAdmin` comes from `profiles.is_admin`; UI is hidden behind it, but real
  enforcement is RLS. Never rely on the hidden button alone.
- Edge Functions (`admin-impersonate`, `admin-list-users`, `admin-view-as`, `similar-artists`)
  are not in this repo; they are deployed directly to Supabase.

## Database changes
- This repo has no migrations folder. Schema changes are applied to Supabase as migrations
  (`apply_migration`), not ad-hoc SQL. If you have no Supabase access in your session, do NOT
  guess at the schema: write the SQL you need into your PR description or a file under `docs/`
  and flag it for Kipling to apply before the frontend change ships.
- A frontend change that needs a new column/table must not go to `main` before that migration
  is applied, or the feature will fail for real users.
- Supabase gotchas: a trigger inserting into an RLS-enabled table with no policies silently rolls
  back the whole transaction (use `SECURITY DEFINER`); RLS pattern is separate
  select/insert/delete policies on `auth.uid() = user_id`; when a function's return signature
  changes, drop it in a separate migration first.

## Working style
- Kipling's messages are terse ("Continue", "Do all", "Yes"). He prefers autonomous execution
  over back-and-forth, and reverses decisions quickly when something doesn't work in practice.
- Mockups are wanted before UX/layout changes; skip them for mechanical refactors and audits.
- Lead with your recommendation. He's often on a phone, so keep summaries short and concrete.

## Where things stand (re-verify against git log)
- Builds 71-73 restructured the app's IA after a strategic (not just heuristic) UX review found
  the nav's visual hierarchy didn't match the product's actual feature hierarchy:
  - **Build 71**: merged the standalone "Sing Now" view into Songbook's own "Best fit" sort
    (`pickSingNowSongs` -> `bestFitScore`, applied to every status, not just Solid — non-Solid
    songs mostly have no performance history so they degrade gracefully to ~the old fit-only
    order) and promoted Recommendations from a header icon + bottom sheet into the freed tab
    slot as a real inline view. View order is now Songbook / Setlists / Recs, Songbook is the
    default/landing view. Also dropped "Test" (the internal marker for unvetted Recommendation
    candidates) from both manual status pickers (`#fStatus`, the inline per-card status editor)
    via `MANUAL_STATUS_OPTIONS` — grandfathers the current value back in via `populateStatusSelect`
    when a song is already Test, so opening the editor on one doesn't silently blank its status
    to `""` on save.
  - **Build 72**: added Perform mode — tapping a setlist opens a read-mostly view (no reorder/
    remove controls) with a big "Mark as sung" button per song (`buildSongCardHtml`'s `footer`
    extension point, now actually used — see `docs/SONG_CARD_STANDARD.md`), logging to
    `performances` the same way manual logging does. Edit (the old full sheet: reorder, add/
    remove songs, gig date/venue) is still one tap away via a dedicated row button or a button
    inside Perform. Also added `computeReadinessBannerHtml`: setlists with a gig date within 14
    days (including overdue) and any non-Solid song get a warning banner, shown in both Edit and
    Perform.
  - **Build 73**: split the Setlists tab into Upcoming (gig date today-or-later, ascending;
    undated/reusable lists included, sorted last within the group) and Past (visually
    de-emphasized, `.setlist-past-group{opacity:0.6}`) via `splitSetlistsByGigDate` — the tab
    read as a history log before this, not a planner.
  - All three verified live against the real account (kiplingm@gmail.com), not just code-reviewed
    — see each build's commit message for exactly what was checked. tests.js is at 59 (was 47
    before Build 71; `pickSingNowSongs`'s tests were replaced by `bestFitScore` ones, plus new
    coverage for `computeReadinessBannerHtml` and `splitSetlistsByGigDate`).
- Build 70 fixed a real sign-in bug (the OTP code field was capped at `maxlength="6"` and labeled
  "6-DIGIT CODE" while Supabase's project Auth settings actually issue 8-digit codes — confirmed
  against emails going back to at least 2026-08-16, so the code fallback has silently never worked)
  and added a desktop/wide-viewport max-width layout (main content + all `.sheet`s, `min-width:820px`)
  after a heuristic usability review of the live app. Two of the review's other flagged issues
  (FAB supposedly hiding the last row of Songbook/Setlists; filter-chip row supposedly having no
  scroll-fade affordance) did not reproduce on direct verification and were left alone — the FAB
  clears the last row by design (108px combined bottom padding vs. an 80px FAB footprint), and the
  fade mask on `.filter-chips` already exists and works. A third flagged issue (Recommendations not
  showing which tier produced a suggestion) also didn't hold up — `.rec-item-source` already shows a
  specific per-row reason (e.g. "Because you're solid on X", "Similar to Y (Last.fm)"), which is
  more informative than a generic tier tag. Only genuinely fix what you've verified reproduces.
- Build 69 added the floating "Report an issue" button (bottom-left) and Admin → Feedback triage
  sheet, backed by the `feedback_reports` table.
- Open manual Supabase dashboard steps: add the Pages URL to Auth redirect URLs; update the
  Magic Link email template.
- Pending: hero banner and wordmark graphics (Kipling generates in Adobe Firefly and supplies
  the files; wordmark goes in `index.html` first, then the tutorial slide, then the login sheet).
- Pending: song "theme" reference data (paused, needs scoping), more vocal-range research batches.
