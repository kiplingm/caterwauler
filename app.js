// Bumped manually with each deploy — there's no build pipeline here, just
// static files served by GitHub Pages, so this is a simple manual marker
// to confirm which version is actually live (useful given Pages/browser
// caching can lag behind a push by a minute or two).
const BUILD_VERSION = "42";
const BUILD_DATE = "2026-07-30T11:54:11-07:00";

const buildInfoEl = document.getElementById("buildInfo");
if(buildInfoEl){
  const formatted = new Date(BUILD_DATE).toLocaleString(undefined, {
    year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit"
  });
  buildInfoEl.textContent = `Build ${BUILD_VERSION} — ${formatted}`;
}

const SUPABASE_URL = "https://luykkuptcizkdigwness.supabase.co";
// Publishable key (replaces the old static anon key). Same low privileges,
// RLS-gated, safe to ship in client code — see Supabase's migration away
// from the legacy anon key format.
const PUBLISHABLE_KEY = "sb_publishable_xBonZeSOCmOIJ1dNb5kJBg_RIIYl0Dl";

const HEADERS = {
  "apikey": PUBLISHABLE_KEY,
  "Authorization": "Bearer " + PUBLISHABLE_KEY, // replaced with the signed-in user's session token in onSignedIn()
  "Content-Type": "application/json"
};

// Used only for sign-in / session management (magic link, getSession,
// onAuthStateChange, signOut). All the existing data calls below are left
// exactly as they were — plain fetch() against HEADERS — so this stays a
// small, additive change rather than a rewrite of 1000+ lines of working
// fetch calls.
const authClient = supabase.createClient(SUPABASE_URL, PUBLISHABLE_KEY);
// Remembers which address the OTP was sent to, so the code-entry fallback
// knows which email to verify against without asking the user to retype it.
let lastAuthEmail = null;

// Vocal range — loaded per-user from the `profiles` table after sign-in
// (see loadProfileRange()). Starts as null/unset rather than a hardcoded
// fallback: a brand new user with an empty songbook has no computed range
// yet, and showing a fake "A2-B4" as if it were real was misleading. The
// UI treats COMFORT_LOW === null as "not calculated yet" throughout
// (header, range strip, fit scoring) until either auto mode computes a
// real one from Solid songs or the user saves one manually in Settings.
let COMFORT_LOW = null, COMFORT_HIGH = null;
// 'auto' (derived from Solid-status songs) or 'manual' (typed in directly).
// Shared with the other karaoke-app project via the same profiles row.
let currentRangeMode = "manual";
// The last range the user typed in manually, kept separate from
// COMFORT_LOW/HIGH above so that switching to auto (which overwrites
// those active values) doesn't lose it — switching back to manual restores
// from this instead of leaving whatever auto last computed.
let manualComfortLow = null, manualComfortHigh = null;

const NOTE_VALUES = {C:0,"C#":1,DB:1,D:2,"D#":3,EB:3,E:4,F:5,"F#":6,GB:6,G:7,"G#":8,AB:8,A:9,"A#":10,BB:10,B:11};

function noteToSemitone(note){
  if(!note) return null;
  const m = note.trim().toUpperCase().match(/^([A-G])(#|B)?(-?\d)$/);
  if(!m) return null;
  let [, letter, acc, octave] = m;
  let key = letter + (acc || "");
  if(!(key in NOTE_VALUES)) return null;
  return NOTE_VALUES[key] + (parseInt(octave)+1)*12;
}

let comfortLowS = noteToSemitone(COMFORT_LOW);
let comfortHighS = noteToSemitone(COMFORT_HIGH);

function updateRangeLineDisplay(){
  const el = document.getElementById("rangeLine");
  if(el){
    el.textContent = (COMFORT_LOW && COMFORT_HIGH)
      ? `YOUR RANGE — ${COMFORT_LOW}–${COMFORT_HIGH}`
      : "YOUR RANGE — Not calculated yet. Mark a few songs Solid, or set one manually in Settings.";
  }
}
updateRangeLineDisplay();

// Called after the profile loads post-sign-in, and after saving a new
// range in Settings. Recomputes the derived semitone values and refreshes
// both the header display and (via the caller) fit scoring across the
// songbook.
function applyRange(comfortLow, comfortHigh){
  COMFORT_LOW = comfortLow; COMFORT_HIGH = comfortHigh;
  comfortLowS = noteToSemitone(COMFORT_LOW);
  comfortHighS = noteToSemitone(COMFORT_HIGH);
  updateRangeLineDisplay();
}


let songs = [];
let activeFilter = "All";
// Songbook cards are collapsed (title/artist/status only) by default and
// expand on tap to reveal range/meta/actions. Session-only (not persisted
// anywhere) — resets to all-collapsed on next load, same as search/sort/
// filter state.
let expandedCardIds = new Set();
let searchTerm = "";
let sortMode = "fit";
// Sing Now is the landing view: a short, ranked stack of Solid songs meant
// for picking your next song live at karaoke, as opposed to the full
// Songbook view (search/filter/sort over everything). Persisted so the
// app reopens on whichever mode was last used.
let currentView = ["songbook","setlists"].includes(localStorage.getItem("ss_view")) ? localStorage.getItem("ss_view") : "singNow";
// Ids excluded from the current Sing Now stack — populated by "Give me
// different picks" so reshuffling doesn't just show the same songs again
// until every eligible song has had a turn, then it resets.
let singNowExcludeIds = new Set();
// Main search bar's KaraFun-catalog fallback: when a search matches nothing
// anywhere in the user's own songbook, we debounce a lookup against the
// shared catalog and offer results as "not in your songbook yet" adds.
// The token guards against a slow response from an earlier keystroke
// landing after a newer one has already redrawn the list.
let catalogFallbackToken = 0;
let catalogFallbackDebounce = null;
let editingStatusId = null;
const STATUS_OPTIONS = ["Solid","Learning","Maybe","Suggested","Retired","Test"];
const STATUS_ICONS = {Solid:"✓", Learning:"◐", Maybe:"?", Suggested:"★", Retired:"✕", Test:"🧪"};

// The Add/Edit song form's status field is the one place STATUS_OPTIONS
// isn't consumed generically at render time (the filter chips and the
// per-song status editor both are) — populate it here instead of hardcoding
// the option list a second time in index.html, so a future status addition
// can't silently miss this form the way "Test" originally did.
document.getElementById("fStatus").innerHTML = STATUS_OPTIONS
  .map(opt => `<option ${opt==="Maybe"?"selected":""}>${opt}</option>`).join("");

document.getElementById("sortSelect").addEventListener("change", e=>{
  sortMode = e.target.value;
  render();
});

const listEl = document.getElementById("list");
const countRow = document.getElementById("countRow");
const chipsEl = document.getElementById("chips");
const FILTERS = ["All","Solid","Learning","Maybe","Suggested","Retired","Test"];

FILTERS.forEach(f=>{
  const c = document.createElement("button");
  c.className = "chip" + (f==="All" ? " active" : "");
  c.textContent = f;
  c.onclick = () => { activeFilter = f; document.querySelectorAll(".chip").forEach(x=>x.classList.remove("active")); c.classList.add("active"); render(); };
  chipsEl.appendChild(c);
});

document.getElementById("search").addEventListener("input", e=>{
  searchTerm = e.target.value.toLowerCase();
  render();
});

// Sync the switcher/controls/list visibility to the persisted view before
// any songs have loaded — fetchSongs() -> render() will redraw content
// into whichever container is already showing. Deliberately not calling
// render() here, so the static skeleton-card markup in index.html stays
// visible until fetchSongs() actually resolves post-auth.
syncViewVisibility(currentView);

function showToast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(()=>t.classList.remove("show"), 1800);
}

// Plays the .removing exit animation on an element, then removes it from the DOM.
function animateRemove(el, delay=200){
  return new Promise(resolve=>{
    if(!el){ resolve(); return; }
    el.classList.add("removing");
    setTimeout(()=>{ el.remove(); resolve(); }, delay);
  });
}

function buildRangePrompt(missingSongs){
  const list = missingSongs.map(s => `- "${s.title}" by ${s.artist} (row id: ${s.id})`).join("\n");
  return `Please research the vocal range (low and high note, e.g. "A2") for these songs from my karaoke tracker, then update them in my Supabase project (karaoke-prod, ref luykkuptcizkdigwness), table "songs", columns low_note/high_note, matched by each song's row id (not by title/artist alone — the table has other users' songs in it too):\n\n${list}\n\nFor context: my vocal range is ${COMFORT_LOW}–${COMFORT_HIGH}.`;
}

async function askClaude(promptText, boxEl){
  let copied = false;
  try{
    await navigator.clipboard.writeText(promptText);
    copied = true;
  }catch(e){ /* clipboard permission unavailable — fall back to manual copy below */ }

  if(boxEl){
    boxEl.style.display = "block";
    boxEl.innerHTML = `
      <div class="ask-claude-label">${copied ? "Copied — paste it into the chat that opens." : "Copy this, then paste it into the chat that opens:"}</div>
      <textarea class="ask-claude-textarea" id="askClaudeTextarea" readonly></textarea>
      ${copied ? "" : `<button class="ask-claude-copy-btn" id="askClaudeCopyBtn">Copy</button>`}
    `;
    document.getElementById("askClaudeTextarea").value = promptText;
    const copyBtn = document.getElementById("askClaudeCopyBtn");
    if(copyBtn){
      copyBtn.onclick = () => {
        const ta = document.getElementById("askClaudeTextarea");
        ta.select();
        try{ document.execCommand("copy"); showToast("Copied"); }catch(e){ showToast("Select the text above and copy it manually"); }
      };
    }
  }
  showToast(copied ? "Prompt copied — opening Claude…" : "Opening Claude — copy the prompt below first");
  // claude.ai/new no longer accepts a prefill query parameter (removed for security reasons),
  // so we open a fresh chat and rely on the clipboard copy / visible textarea above.
  window.open("https://claude.ai/new", "_blank");
}

async function fetchSongs(){
  try{
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/songs?select=*,performances(performance_date)&order=title.asc`,
      {headers: HEADERS}
    );
    if(!res.ok) throw new Error("Fetch failed: " + res.status);
    const raw = await res.json();
    songs = raw.map(s => {
      const dates = (s.performances || [])
        .map(p => p.performance_date)
        .filter(Boolean)
        .sort();
      return {
        ...s,
        last_played: dates.length ? dates[dates.length-1] : null,
        fit_score: fitScore(s.low_note, s.high_note)
        // in_karafun comes straight from the row — a DB trigger sets it
        // whenever a song's title/artist is inserted or changed, so there's
        // no catalog check to run client-side on every load anymore.
      };
    });
    render();
  }catch(err){
    listEl.innerHTML = `
      <div class="empty">
        Couldn't load your songbook.<br>${escapeHtml(err.message)}
        <br><button class="retry-btn" id="retryFetchBtn">Retry</button>
      </div>`;
    const retryBtn = document.getElementById("retryFetchBtn");
    if(retryBtn) retryBtn.onclick = fetchSongs;
  }
}

function fitLabel(lowS, highS){
  if(comfortLowS === null || comfortHighS === null) return {cls:"fit-unknown", text:"○ YOUR RANGE NOT SET"};
  if(lowS===null || highS===null) return {cls:"fit-unknown", text:"○ RANGE NOT SET"};
  if(lowS >= comfortLowS && highS <= comfortHighS) return {cls:"fit-easy", text:"✓ IN RANGE"};
  return {cls:"fit-out", text:"✕ OUT OF RANGE"};
}

// Ranks Solid-status songs for the "Sing Now" quick-pick stack: songs you
// haven't sung in a while are favored (or have never been logged at all),
// with a known-good range fit as a lighter-weight tiebreaker. Pure/testable
// on purpose — takes the already-shaped `songs` array (with last_played and
// fit_score already computed by fetchSongs) plus an `excludeIds` set for
// reshuffling, and returns the top `count` picks, best-first.
//
// Lower internal score = picked sooner. Staleness (days since last sung,
// capped so "3 months ago" and "a year ago" aren't wildly different) is
// weighted far more than fit, since every candidate is already Solid —
// fit only breaks near-ties. Never-sung songs are treated as maximally
// stale so they surface early rather than languishing unpicked forever.
const SING_NOW_STALENESS_CAP_DAYS = 90;
const SING_NOW_FIT_TIEBREAK_WEIGHT = 0.3;

function pickSingNowSongs(allSongs, options){
  options = options || {};
  const count = options.count === undefined ? 5 : options.count;
  const excludeIds = options.excludeIds || new Set();
  const now = options.now || new Date();
  const eligible = allSongs.filter(s => s.status === "Solid" && !excludeIds.has(s.id));

  const scored = eligible.map(s => {
    const daysSince = s.last_played
      ? Math.floor((now - new Date(s.last_played)) / 86400000)
      : Infinity;
    const staleness = isFinite(daysSince)
      ? Math.min(daysSince, SING_NOW_STALENESS_CAP_DAYS)
      : SING_NOW_STALENESS_CAP_DAYS + 1; // never logged — nudge above the cap so it's not tied with "just old"
    const fitPenalty = isFinite(s.fit_score) ? s.fit_score : 0; // unknown range = neutral, not penalized
    const score = fitPenalty * SING_NOW_FIT_TIEBREAK_WEIGHT - staleness;
    return {song: s, score};
  });

  scored.sort((a, b) => {
    if(a.score !== b.score) return a.score - b.score;
    return (a.song.title || "").localeCompare(b.song.title || "");
  });

  return scored.slice(0, count).map(x => x.song);
}

// Lower score = better fit against comfort zone. Unknown ranges (song's or
// the user's own, if not set yet) sort last.
function fitScore(low, high){
  if(comfortLowS === null || comfortHighS === null) return Infinity;
  const lowS = noteToSemitone(low), highS = noteToSemitone(high);
  if(lowS===null || highS===null) return Infinity;
  const below = Math.max(0, comfortLowS - lowS);
  const above = Math.max(0, highS - comfortHighS);
  return below + above;
}

const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
function semitoneToNoteName(s){
  const pc = ((s % 12) + 12) % 12;
  const octave = Math.floor(s / 12) - 1;
  return NOTE_NAMES[pc] + octave;
}

// For an out-of-range song, suggest a semitone shift that best fits it into
// the comfort zone.
function suggestTransposition(lowS, highS){
  if(lowS===null || highS===null) return null;
  const songSpan = highS - lowS;
  const comfortSpan = comfortHighS - comfortLowS;

  if(songSpan <= comfortSpan){
    const minShift = comfortLowS - lowS;
    const maxShift = comfortHighS - highS;
    const shift = Math.round((minShift + maxShift) / 2);
    return {shift, zone: "comfort"};
  }
  return {shift: 0, zone: "none"};
}

function transpositionMessage(lowS, highS){
  const suggestion = suggestTransposition(lowS, highS);
  if(!suggestion) return "";
  const {shift, zone} = suggestion;
  if(zone === "none"){
    return "Spans more than your range — no key change fixes this.";
  }
  const dir = shift > 0 ? "up" : shift < 0 ? "down" : null;
  if(!dir){
    return "Already centered in your range.";
  }
  const newLow = semitoneToNoteName(lowS + shift);
  const newHigh = semitoneToNoteName(highS + shift);
  return `${dir==="up"?"+":"−"}${Math.abs(shift)} semitone${Math.abs(shift)===1?"":"s"} → ${newLow}–${newHigh}`;
}

// Reads the active theme's brighter gradient-only colors as RGB triples,
// so the range bar stays punchy/saturated regardless of which theme is
// selected, independent of the softer --green/--gold/--red used by status
// pills and badges elsewhere in the UI.
function getFitColors(){
  const style = getComputedStyle(document.body);
  const parse = varName => {
    const hex = style.getPropertyValue(varName).trim();
    const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
    if(!m) return [61,220,132]; // fallback bright green
    return [parseInt(m[1],16), parseInt(m[2],16), parseInt(m[3],16)];
  };
  return { green: parse("--grad-green"), gold: parse("--grad-gold"), red: parse("--grad-red") };
}

function lerpColor(a, b, t){
  t = Math.max(0, Math.min(1, t));
  const rgb = [0,1,2].map(i => Math.round(a[i] + (b[i]-a[i])*t));
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

// The colored vertical strip that runs down the left edge of the whole
// card (a sibling of card-top/card-body, not nested inside the text
// content) — replaces the old horizontal range-track bar. Red padding
// top/bottom, green in the middle for the comfort zone, with a glowing
// marker showing exactly where this song's own notes fall within that
// span. Unlike the old bar, this stays visible even when a Songbook
// card is collapsed, since it's part of the card's own edge.
function renderCardStrip(low, high){
  const lowS = noteToSemitone(low), highS = noteToSemitone(high);

  if(comfortLowS === null || comfortHighS === null){
    return `<div class="card-strip card-strip-unset"></div>`;
  }

  // Same padding logic as before: a few semitones past comfort on each
  // side, widened further if the song's own range would otherwise get
  // clipped at the edge.
  let spanLow = comfortLowS - 4, spanHigh = comfortHighS + 4;
  if(lowS !== null) spanLow = Math.min(spanLow, lowS - 1);
  if(highS !== null) spanHigh = Math.max(spanHigh, highS + 1);
  const span = spanHigh - spanLow;
  // pct is "percent of the way up from the bottom" — bottom = lowest
  // pitch, top = highest, like a thermometer.
  const pct = v => Math.max(0, Math.min(100, ((v - spanLow)/span)*100));

  const comfortBottom = pct(comfortLowS), comfortTop = pct(comfortHighS);
  // CSS linear-gradient(180deg,...) reads top-to-bottom, so convert
  // "percent from bottom" into "percent from top" for the gradient stops.
  const zoneTopPct = 100 - comfortTop, zoneBottomPct = 100 - comfortBottom;
  const c = getFitColors();
  const rgb = ([r,g,b]) => `rgb(${r},${g},${b})`;
  const background = `linear-gradient(180deg,
    ${rgb(c.red)} 0%, ${rgb(c.red)} ${zoneTopPct}%,
    ${rgb(c.green)} ${zoneTopPct}%, ${rgb(c.green)} ${zoneBottomPct}%,
    ${rgb(c.red)} ${zoneBottomPct}%, ${rgb(c.red)} 100%)`;

  let markerHtml = "";
  if(lowS !== null && highS !== null){
    const songBottom = pct(lowS), songTop = pct(highS);
    const markerTop = 100 - songTop;
    const markerHeight = Math.max(songTop - songBottom, 4); // floor so a narrow song is still visible
    markerHtml = `<div class="card-strip-marker" style="top:${markerTop}%; height:${markerHeight}%;"></div>`;
  }

  return `<div class="card-strip" style="background:${background};">${markerHtml}</div>`;
}

// Key notes + the fit line ("IN RANGE - A2-E4") + the Spotify/YouTube
// icon links — the text/action content that lives in the card body,
// separate from the visual strip above.
function renderRangeInfo(low, high, rangeSource, keyNotes, title, artist){
  const lowS = noteToSemitone(low), highS = noteToSemitone(high);
  const fit = fitLabel(lowS, highS);

  const sourceTag = (lowS!==null && highS!==null && rangeSource === "estimated")
    ? `<span class="range-source-tag" title="Filled in as a best-guess estimate, not individually verified">est.</span>`
    : (lowS!==null && highS!==null && rangeSource === "verified")
    ? `<span class="range-source-tag range-source-verified" title="Checked against a specific vocal reference">✓ verified</span>`
    : "";
  const suggestionHtml = fit.cls === "fit-out"
    ? `<span class="transpose-suggestion">${transpositionMessage(lowS, highS)}</span>`
    : "";
  const iconLinksHtml = (title && artist) ? externalLinksHtml(title, artist) : "";

  return `
    <div class="range-info-row">
      <div class="range-text-stack">
        <div class="range-key-notes">${keyNotes ? escapeHtml(keyNotes) : ""}</div>
        <div class="range-fit ${fit.cls}">${fit.text}${lowS!==null&&highS!==null ? ` · ${low}–${high}` : ""}${sourceTag}${suggestionHtml}</div>
      </div>
      ${iconLinksHtml}
    </div>`;
}

function render(){
  if(currentView === "singNow"){
    renderSingNow();
  }else if(currentView === "setlists"){
    fetchSetlists();
  }else{
    renderSongbook();
  }
}

function syncViewVisibility(view){
  document.getElementById("viewSingNowBtn").classList.toggle("active", view === "singNow");
  document.getElementById("viewSongbookBtn").classList.toggle("active", view === "songbook");
  document.getElementById("viewSetlistsBtn").classList.toggle("active", view === "setlists");
  document.getElementById("singNowList").style.display = view === "singNow" ? "flex" : "none";
  document.getElementById("list").style.display = view === "songbook" ? "flex" : "none";
  document.getElementById("setlistsView").style.display = view === "setlists" ? "flex" : "none";
  document.getElementById("controls").style.display = view === "songbook" ? "flex" : "none";
  countRow.style.display = view === "songbook" ? "block" : "none";
  // The FAB's job changes with the view: add a song on Songbook, start a
  // new setlist on Setlists, and it has no clear job on Sing Now (that
  // view's own "Give me different picks" button is the primary action
  // there), so it's hidden rather than doing something off-topic.
  document.getElementById("fabAdd").style.display = view === "singNow" ? "none" : "flex";
  document.getElementById("fabAdd").textContent = view === "setlists" ? "📝" : "+";
  document.getElementById("fabAdd").setAttribute("aria-label", view === "setlists" ? "New setlist" : "Add song");
}

function setView(view){
  currentView = view;
  localStorage.setItem("ss_view", view);
  syncViewVisibility(view);
  render();
}

document.getElementById("viewSingNowBtn").onclick = () => setView("singNow");
document.getElementById("viewSongbookBtn").onclick = () => setView("songbook");
document.getElementById("viewSetlistsBtn").onclick = () => setView("setlists");

function renderSingNow(){
  const listEl = document.getElementById("singNowList");
  const solidCount = songs.filter(s => s.status === "Solid").length;

  if(solidCount === 0){
    listEl.innerHTML = `
      <div class="empty">
        Mark a few songs Solid to get started — Sing Now picks from those,
        favoring ones you haven't sung in a while.
      </div>`;
    return;
  }

  const picks = pickSingNowSongs(songs, {excludeIds: singNowExcludeIds});

  if(picks.length === 0){
    // Every Solid song has been excluded via reshuffling — reset and
    // start the rotation over rather than showing a dead end.
    singNowExcludeIds = new Set();
    renderSingNow();
    return;
  }

  listEl.innerHTML = `
    <div class="sing-now-intro">Your next best picks, right now:</div>
    ${picks.map(s => `
      <div class="card sing-now-card ${expandedCardIds.has(s.id) ? "expanded" : ""}" data-id="${s.id}">
        ${renderCardStrip(s.low_note, s.high_note)}
        <div class="card-content">
          <div class="card-top card-head" data-id="${s.id}">
            <div>
              <div class="title">${escapeHtml(s.title)}${s.in_karafun ? `<span class="karafun-badge" title="In the KaraFun catalog">K</span>` : ""}</div>
              <div class="artist">${escapeHtml(s.artist)}</div>
            </div>
            <div class="card-head-right">
              ${editingStatusId === s.id ? `
                <select class="status-edit-select" data-id="${s.id}">
                  ${STATUS_OPTIONS.map(opt => `<option value="${opt}" ${opt===s.status?"selected":""}>${opt}</option>`).join("")}
                </select>
              ` : `
                <div class="status-pill status-${s.status}" data-id="${s.id}"><span class="status-icon">${STATUS_ICONS[s.status]||""}</span> ${s.status}</div>
              `}
              <span class="card-chevron">${expandedCardIds.has(s.id) ? "▲" : "▼"}</span>
            </div>
          </div>
          <div class="card-body">
            ${renderRangeInfo(s.low_note, s.high_note, s.range_source, null, s.title, s.artist)}
            <div class="card-meta">
              ${s.last_played ? `<span>Last played ${formatDate(s.last_played)}</span>` : `<span>Never logged</span>`}
            </div>
            <div class="card-actions">
              <button class="logBtn primary" data-id="${s.id}">Performances</button>
              <button class="setlistAddBtn" data-id="${s.id}">+ Setlist</button>
              <button class="editBtn" data-id="${s.id}">Edit</button>
            </div>
          </div>
        </div>
      </div>
    `).join("")}
    <button class="reshuffle-btn" id="reshuffleBtn">🔀 Give me different picks</button>
  `;

  listEl.querySelectorAll(".card-head").forEach(el=>{
    el.onclick = (e) => {
      if(e.target.closest(".status-pill") || e.target.closest(".status-edit-select")) return;
      toggleCardExpand(el.dataset.id);
    };
  });
  listEl.querySelectorAll(".status-pill").forEach(el=>{
    el.onclick = (e) => { e.stopPropagation(); editingStatusId = el.dataset.id; render(); };
  });
  listEl.querySelectorAll(".status-edit-select").forEach(sel=>{
    sel.onclick = (e) => e.stopPropagation();
    sel.onchange = () => updateStatus(sel.dataset.id, sel.value);
    sel.onblur = () => { editingStatusId = null; render(); };
    setTimeout(()=>sel.focus(), 0);
  });
  document.querySelectorAll(".logBtn").forEach(b=>b.onclick = ()=>openLog(b.dataset.id));
  document.querySelectorAll(".setlistAddBtn").forEach(b=>b.onclick = ()=>openAddToSetlist(b.dataset.id));
  document.querySelectorAll(".editBtn").forEach(b=>b.onclick = ()=>openEdit(b.dataset.id));
  document.getElementById("reshuffleBtn").onclick = () => {
    picks.forEach(s => singNowExcludeIds.add(s.id));
    renderSingNow();
  };
}

function renderSongbook(){
  let filtered = songs.filter(s=>{
    const matchesFilter = activeFilter==="All" || s.status===activeFilter;
    const matchesSearch = !searchTerm || (s.title||"").toLowerCase().includes(searchTerm) || (s.artist||"").toLowerCase().includes(searchTerm);
    return matchesFilter && matchesSearch;
  });

  filtered = filtered.slice().sort((a,b)=>{
    if(sortMode === "title"){
      return (a.title||"").localeCompare(b.title||"");
    }
    if(sortMode === "lastPlayed"){
      // Most recently played first; never-played songs sort last.
      if(!a.last_played && !b.last_played) return (a.title||"").localeCompare(b.title||"");
      if(!a.last_played) return 1;
      if(!b.last_played) return -1;
      return b.last_played.localeCompare(a.last_played);
    }
    if(sortMode === "lastAdded"){
      // Most recently added to the songbook first.
      return (b.created_at||"").localeCompare(a.created_at||"");
    }
    if(sortMode === "challenging"){
      // Worst fit first (most semitones outside comfort zone). Songs with
      // no saved range (fit_score === Infinity) still sort to the bottom
      // here, same as they do for "Best fit" — "challenging" means "hard
      // but known," not "unknown."
      const aUnknown = !isFinite(a.fit_score), bUnknown = !isFinite(b.fit_score);
      if(aUnknown !== bUnknown) return aUnknown ? 1 : -1;
      if(aUnknown && bUnknown) return (a.title||"").localeCompare(b.title||"");
      if(a.fit_score !== b.fit_score) return b.fit_score - a.fit_score;
      return (a.title||"").localeCompare(b.title||"");
    }
    if(sortMode === "highest" || sortMode === "lowest"){
      // Sort by actual pitch (converted to semitones, not string compare —
      // "G4" > "A2" alphabetically would be wrong). Songs missing a note
      // sort to the bottom either way.
      const noteField = sortMode === "highest" ? "high_note" : "low_note";
      const aS = noteToSemitone(a[noteField]), bS = noteToSemitone(b[noteField]);
      const aUnknown = aS===null, bUnknown = bS===null;
      if(aUnknown !== bUnknown) return aUnknown ? 1 : -1;
      if(aUnknown && bUnknown) return (a.title||"").localeCompare(b.title||"");
      if(aS !== bS) return sortMode === "highest" ? bS - aS : aS - bS;
      return (a.title||"").localeCompare(b.title||"");
    }
    // fit: best range match first, tie-broken by title
    if(a.fit_score !== b.fit_score) return a.fit_score - b.fit_score;
    return (a.title||"").localeCompare(b.title||"");
  });

  countRow.textContent = `${filtered.length} of ${songs.length} songs`;

  if(filtered.length===0){
    const term = searchTerm.trim();
    // Only worth offering a catalog fallback if the term truly matches
    // nothing in the user's songbook at all — if it matches under a
    // different status filter, it's already in their catalog, just
    // hidden by the current chip, so a "not in your songbook" prompt
    // would be misleading.
    const matchesAnywhere = songs.some(s =>
      (s.title||"").toLowerCase().includes(searchTerm) || (s.artist||"").toLowerCase().includes(searchTerm)
    );

    if(term.length >= 2 && !matchesAnywhere){
      const myToken = ++catalogFallbackToken;
      listEl.innerHTML = `
        <div class="empty">No songs match in your songbook.</div>
        <div class="catalog-fallback" id="catalogFallback">
          <div class="catalog-fallback-label">Searching the KaraFun catalog…</div>
        </div>`;
      clearTimeout(catalogFallbackDebounce);
      catalogFallbackDebounce = setTimeout(async () => {
        const results = await searchCatalog(term);
        if(myToken !== catalogFallbackToken) return; // a newer search superseded this one
        renderCatalogFallback(results, term);
      }, 300);
    }else{
      clearTimeout(catalogFallbackDebounce);
      catalogFallbackToken++; // invalidate any in-flight fallback lookup
      listEl.innerHTML = `<div class="empty">No songs match. Try a different search or filter — or add one with the + button.</div>`;
    }
    return;
  }

  listEl.innerHTML = filtered.map(s => `
    <div class="card ${expandedCardIds.has(s.id) ? "expanded" : ""}" data-id="${s.id}">
      ${renderCardStrip(s.low_note, s.high_note)}
      <div class="card-content">
        <div class="card-top card-head" data-id="${s.id}">
          <div>
            <div class="title">${escapeHtml(s.title)}${s.in_karafun ? `<span class="karafun-badge" title="In the KaraFun catalog">K</span>` : ""}</div>
            <div class="artist">${escapeHtml(s.artist)}</div>
          </div>
          <div class="card-head-right">
            ${editingStatusId === s.id ? `
              <select class="status-edit-select" data-id="${s.id}">
                ${STATUS_OPTIONS.map(opt => `<option value="${opt}" ${opt===s.status?"selected":""}>${opt}</option>`).join("")}
              </select>
            ` : `
              <div class="status-pill status-${s.status}" data-id="${s.id}"><span class="status-icon">${STATUS_ICONS[s.status]||""}</span> ${s.status}</div>
            `}
            <span class="card-chevron">${expandedCardIds.has(s.id) ? "▲" : "▼"}</span>
          </div>
        </div>
        <div class="card-body">
          ${renderRangeInfo(s.low_note, s.high_note, s.range_source, s.key_notes, s.title, s.artist)}
          <div class="card-meta">
            ${s.genre ? `<span>${escapeHtml(s.genre)}</span>` : ""}
            ${s.last_played ? `<span>Last played ${formatDate(s.last_played)}</span>` : ""}
          </div>
          <div class="card-actions">
            <button class="logBtn primary" data-id="${s.id}">Performances</button>
            <button class="setlistAddBtn" data-id="${s.id}">+ Setlist</button>
            <button class="editBtn" data-id="${s.id}">Edit</button>
          </div>
        </div>
      </div>
    </div>
  `).join("");

  document.querySelectorAll(".card-head").forEach(el=>{
    el.onclick = (e) => {
      // Don't toggle expand when the click was actually on the status
      // pill or its editor — those have their own handlers below.
      if(e.target.closest(".status-pill") || e.target.closest(".status-edit-select")) return;
      toggleCardExpand(el.dataset.id);
    };
  });
  document.querySelectorAll(".status-pill").forEach(el=>{
    el.onclick = (e) => { e.stopPropagation(); editingStatusId = el.dataset.id; render(); };
  });
  document.querySelectorAll(".status-edit-select").forEach(sel=>{
    sel.onclick = (e) => e.stopPropagation();
    sel.onchange = () => updateStatus(sel.dataset.id, sel.value);
    sel.onblur = () => { editingStatusId = null; render(); };
    setTimeout(()=>sel.focus(), 0);
  });
  document.querySelectorAll(".logBtn").forEach(b=>b.onclick = ()=>openLog(b.dataset.id));
  document.querySelectorAll(".setlistAddBtn").forEach(b=>b.onclick = ()=>openAddToSetlist(b.dataset.id));
  document.querySelectorAll(".editBtn").forEach(b=>b.onclick = ()=>openEdit(b.dataset.id));
}

// Toggles one card's expanded state directly in the DOM (no full render(),
// so scroll position and every other card stay untouched) while keeping
// expandedCardIds in sync so a later render() for an unrelated reason
// (search, filter, sort, a status change) still shows this card the way
// the person left it.
function toggleCardExpand(id){
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if(!card) return;
  const isExpanded = card.classList.toggle("expanded");
  if(isExpanded) expandedCardIds.add(id); else expandedCardIds.delete(id);
  const chevron = card.querySelector(".card-chevron");
  if(chevron) chevron.textContent = isExpanded ? "▲" : "▼";
}

async function updateStatus(id, newStatus){
  editingStatusId = null;
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/songs?id=eq.${id}`, {
      method:"PATCH", headers:{...HEADERS, "Prefer":"return=representation"},
      body: JSON.stringify({status: newStatus, updated_at: new Date().toISOString()})
    });
    if(!res.ok) throw new Error("Status update failed");
    showToast(`Status set to ${newStatus}`);
    fetchSongs();
  }catch(err){
    showToast("Error: " + err.message);
    render();
  }
}

// Renders the KaraFun catalog fallback results into the placeholder left
// by render(). Bails silently if that placeholder is no longer in the DOM
// (the list has since re-rendered for some other reason).
function renderCatalogFallback(results, term){
  const container = document.getElementById("catalogFallback");
  if(!container) return;

  if(results.length === 0){
    container.innerHTML = `<div class="catalog-fallback-label">No KaraFun catalog matches for "${escapeHtml(term)}" either.</div>`;
    return;
  }

  container.innerHTML = `
    <div class="catalog-fallback-label">Not in your songbook — found in the KaraFun catalog:</div>
    ${results.map((r, i) => `
      <div class="catalog-fallback-item">
        <div>
          <div class="ac-title">${escapeHtml(r.title)}</div>
          <div class="ac-artist">${escapeHtml(r.artist)}</div>
        </div>
        <button class="catalog-fallback-add" data-idx="${i}">+ Add</button>
      </div>
    `).join("")}
  `;
  container.querySelectorAll(".catalog-fallback-add").forEach(btn => {
    btn.onclick = () => {
      const picked = results[btn.dataset.idx];
      openAddFromCatalog(picked.title, picked.artist);
    };
  });
}

// Opens the add-song sheet pre-filled from a KaraFun catalog pick (either
// the main search's fallback or, in principle, any other catalog result).
// Mirrors the fabAdd handler's reset logic, then tries to auto-fill the
// vocal range from song_ranges the same way the add form's own autocomplete
// does.
function openAddFromCatalog(title, artist){
  document.getElementById("sheetTitle").textContent = "Add song";
  document.getElementById("editId").value = "";
  document.getElementById("fTitle").value = title || "";
  document.getElementById("fArtist").value = artist || "";
  document.getElementById("fLow").value = "";
  document.getElementById("fHigh").value = "";
  document.getElementById("fGenre").value = "";
  document.getElementById("fKeyNotes").value = "";
  document.getElementById("fStatus").value = "Maybe";
  document.getElementById("fRangeSource").value = "manual";
  document.getElementById("titleSuggestions").classList.remove("open");
  document.getElementById("artistSuggestions").classList.remove("open");
  document.getElementById("btnDeleteSong").style.display = "none";
  openSheet();
  tryAutoFillRange(title, artist);
}

function formatDate(iso){
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", {month:"short", day:"numeric", year:"numeric"});
}

function escapeHtml(str){
  if(!str) return "";
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function youtubeSearchUrl(title, artist){
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(title + " " + artist)}`;
}

const SPOTIFY_ICON_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.56 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>`;
const YOUTUBE_ICON_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>`;

// Small circular icon-only Spotify/YouTube links, meant to sit inline in
// a song card's meta row rather than as their own full-width button row.
function externalLinksHtml(title, artist){
  return `
    <div class="icon-links">
      <a class="icon-link icon-link-spotify" href="https://open.spotify.com/search/${encodeURIComponent(title + ' ' + artist)}" target="_blank" rel="noopener" aria-label="Find on Spotify" title="Find on Spotify">${SPOTIFY_ICON_SVG}</a>
      <a class="icon-link icon-link-youtube" href="${youtubeSearchUrl(title, artist)}" target="_blank" rel="noopener" aria-label="Find on YouTube" title="Find on YouTube">${YOUTUBE_ICON_SVG}</a>
    </div>`;
}

function mapsDirectionsUrl(venue){
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(venue)}`;
}

// --- Sheet (add/edit) ---
const sheet = document.getElementById("sheet");
const backdrop = document.getElementById("backdrop");

function openSheet(){ backdrop.classList.add("open"); sheet.classList.add("open"); }
function closeSheet(){ backdrop.classList.remove("open"); sheet.classList.remove("open"); }

document.getElementById("fabAdd").onclick = ()=>{
  if(currentView === "setlists"){
    openSetlistDetail(null);
    return;
  }
  document.getElementById("sheetTitle").textContent = "Add song";
  document.getElementById("editId").value = "";
  ["fTitle","fArtist","fLow","fHigh","fGenre","fKeyNotes"].forEach(id=>document.getElementById(id).value="");
  document.getElementById("fStatus").value = "Maybe";
  document.getElementById("fRangeSource").value = "manual";
  document.getElementById("titleSuggestions").classList.remove("open");
  document.getElementById("artistSuggestions").classList.remove("open");
  document.getElementById("btnDeleteSong").style.display = "none";
  openSheet();
};
document.getElementById("btnCancel").onclick = closeSheet;
backdrop.onclick = closeSheet;

document.getElementById("btnDeleteSong").onclick = async () => {
  const id = document.getElementById("editId").value;
  if(!id) return;
  // deleteSong() shows its own confirm, which mentions logged performance
  // count when relevant — more informative than a plain "Delete this
  // song?" here, so let it handle confirmation rather than asking twice.
  const deleted = await deleteSong(id);
  if(deleted !== false) closeSheet();
};

function openEdit(id){
  const s = songs.find(x=>x.id===id);
  if(!s) return;
  document.getElementById("sheetTitle").textContent = "Edit song";
  document.getElementById("editId").value = s.id;
  document.getElementById("fTitle").value = s.title || "";
  document.getElementById("fArtist").value = s.artist || "";
  document.getElementById("fLow").value = s.low_note || "";
  document.getElementById("fHigh").value = s.high_note || "";
  document.getElementById("fRangeSource").value = s.range_source || "manual";
  document.getElementById("fStatus").value = s.status || "Maybe";
  document.getElementById("fGenre").value = s.genre || "";
  document.getElementById("fKeyNotes").value = s.key_notes || "";
  document.getElementById("btnDeleteSong").style.display = "block";
  openSheet();
}

document.getElementById("btnSave").onclick = async ()=>{
  const id = document.getElementById("editId").value;
  const title = document.getElementById("fTitle").value.trim();
  const artist = document.getElementById("fArtist").value.trim();
  if(!title || !artist){ showToast("Title and artist required"); return; }

  if(!id){
    const dupe = songs.find(s => normalizeForMatch(s.title) === normalizeForMatch(title) && normalizeForMatch(s.artist) === normalizeForMatch(artist));
    if(dupe && !confirm(`"${dupe.title}" by ${dupe.artist} is already in your songbook (status: ${dupe.status}). Add it again as a duplicate?`)){
      return;
    }
  }

  const payload = {
    title,
    artist,
    low_note: document.getElementById("fLow").value.trim() || null,
    high_note: document.getElementById("fHigh").value.trim() || null,
    status: document.getElementById("fStatus").value,
    genre: document.getElementById("fGenre").value.trim() || null,
    key_notes: document.getElementById("fKeyNotes").value.trim() || null,
    range_source: document.getElementById("fRangeSource").value || "manual",
    updated_at: new Date().toISOString()
  };

  try{
    if(id){
      const res = await fetch(`${SUPABASE_URL}/rest/v1/songs?id=eq.${id}`, {
        method:"PATCH", headers:{...HEADERS, "Prefer":"return=representation"}, body: JSON.stringify(payload)
      });
      if(!res.ok) throw new Error("Update failed");
      showToast("Song updated");
    }else{
      const res = await fetch(`${SUPABASE_URL}/rest/v1/songs`, {
        method:"POST", headers:{...HEADERS, "Prefer":"return=representation"}, body: JSON.stringify(payload)
      });
      if(!res.ok) throw new Error("Insert failed");
      showToast("Song added");
    }
    closeSheet();
    fetchSongs();
  }catch(err){
    showToast("Error: " + err.message);
  }
};

async function deleteSong(id, opts={}){
  if(!opts.skipConfirm){
    const s = songs.find(x=>x.id===id);
    const perfCount = s && s.performances ? s.performances.length : 0;
    const warning = perfCount > 0
      ? `Delete this song? This also permanently deletes its ${perfCount} logged performance${perfCount===1?"":"s"} (venue, dates, notes).`
      : "Delete this song?";
    if(!confirm(warning)) return false;
  }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/songs?id=eq.${id}`, {method:"DELETE", headers: HEADERS});
    if(!res.ok) throw new Error("Delete failed");
    showToast("Song removed");
    const cardEl = document.querySelector(`.card[data-id="${id}"]`);
    if(cardEl) await animateRemove(cardEl);
    fetchSongs();
    return true;
  }catch(err){
    showToast("Error: " + err.message);
    return false;
  }
}

// --- Performances sheet: list view (history) + form view (add/edit) ---
const logSheet = document.getElementById("logSheet");
const logBackdrop = document.getElementById("logBackdrop");
const logListView = document.getElementById("logListView");
const logFormView = document.getElementById("logFormView");
let currentLogEntries = [];

async function fetchPerformances(songId){
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/performances?song_id=eq.${songId}&order=performance_date.desc`, {headers: HEADERS});
    if(!res.ok) throw new Error("Fetch failed");
    return await res.json();
  }catch(e){
    return [];
  }
}

function renderLogHistory(entries){
  currentLogEntries = entries;
  const el = document.getElementById("logHistory");
  if(entries.length === 0){
    el.innerHTML = `<div class="log-history-title">Past performances</div><div class="log-history-empty">No logged performances yet.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="log-history-title">Past performances (${entries.length})</div>
    <div class="log-history-list">
      ${entries.map(e => `
        <div class="log-history-item logHistoryItem" data-id="${e.id}">
          <div class="log-history-top">
            <div class="log-history-date">${formatDate(e.performance_date)}</div>
            ${e.crowd_response ? `<div class="log-history-crowd">${escapeHtml(e.crowd_response)}</div>` : ""}
          </div>
          ${e.venue ? `<div class="log-history-venue">${escapeHtml(e.venue)} <a class="directions-link" href="${mapsDirectionsUrl(e.venue)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Directions ↗</a></div>` : ""}
          ${e.notes ? `<div class="log-history-notes">${escapeHtml(e.notes)}</div>` : ""}
          <div class="log-history-actions">
            <button class="logDelBtn danger" data-id="${e.id}">Delete</button>
          </div>
        </div>
      `).join("")}
    </div>
  `;
  el.querySelectorAll(".logHistoryItem").forEach(item=>{
    item.onclick = (ev) => {
      if(ev.target.closest(".logDelBtn")) return;
      const entry = currentLogEntries.find(x=>String(x.id)===item.dataset.id);
      if(entry) showFormView(entry);
    };
  });
  el.querySelectorAll(".logDelBtn").forEach(b=>{
    b.onclick = (ev) => { ev.stopPropagation(); deletePerformance(b.dataset.id, b.closest(".log-history-item")); };
  });
}

function showListView(){
  logFormView.style.display = "none";
  logListView.style.display = "block";
  document.getElementById("logSheetTitle").textContent = "Performances";
}

function showFormView(entry){
  document.getElementById("logEntryId").value = entry ? entry.id : "";
  document.getElementById("lDate").value = entry ? entry.performance_date : new Date().toISOString().slice(0,10);
  document.getElementById("lVenue").value = entry ? (entry.venue || "") : "";
  document.getElementById("lCrowd").value = entry ? (entry.crowd_response || "") : "";
  document.getElementById("lNotes").value = entry ? (entry.notes || "") : "";
  document.getElementById("logSheetTitle").textContent = entry ? "Edit performance" : "Log performance";
  document.getElementById("btnLogSave").textContent = entry ? "Update" : "Save";
  const banner = document.getElementById("logEditingBanner");
  if(entry){
    document.getElementById("logEditingText").textContent = `Editing ${formatDate(entry.performance_date)} entry`;
    banner.style.display = "flex";
  }else{
    banner.style.display = "none";
  }
  updateVenueDirectionsLink();
  logListView.style.display = "none";
  logFormView.style.display = "block";
}

document.getElementById("btnAddPerformance").onclick = () => showFormView(null);
document.getElementById("btnLogCancel").onclick = showListView;

async function openLog(id){
  const s = songs.find(x=>x.id===id);
  if(!s) return;
  document.getElementById("logSongId").value = id;
  document.getElementById("logSongLabel").textContent = `${s.title} — ${s.artist}`;
  showListView();
  document.getElementById("logHistory").innerHTML = `<div class="log-history-title">Past performances</div><div class="log-history-empty">Loading…</div>`;
  logBackdrop.classList.add("open");
  logSheet.classList.add("open");
  renderLogHistory(await fetchPerformances(id));
}
function closeLog(){
  logBackdrop.classList.remove("open");
  logSheet.classList.remove("open");
}
document.getElementById("btnLogListClose").onclick = closeLog;
logBackdrop.onclick = closeLog;

async function deletePerformance(entryId, itemEl){
  if(!confirm("Delete this performance log entry?")) return;
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/performances?id=eq.${entryId}`, {method:"DELETE", headers: HEADERS});
    if(!res.ok) throw new Error("Delete failed");
    showToast("Entry deleted");
    if(itemEl) await animateRemove(itemEl);
    const songId = document.getElementById("logSongId").value;
    renderLogHistory(await fetchPerformances(songId));
    venueHistory = null; // invalidate venue cache since a venue entry changed
    fetchSongs();
  }catch(err){
    showToast("Error: " + err.message);
  }
}

document.getElementById("btnLogSave").onclick = async ()=>{
  const songId = document.getElementById("logSongId").value;
  const entryId = document.getElementById("logEntryId").value;
  const date = document.getElementById("lDate").value;
  if(!songId || !date){ showToast("Date required"); return; }

  const payload = {
    song_id: songId,
    performance_date: date,
    venue: document.getElementById("lVenue").value.trim() || null,
    crowd_response: document.getElementById("lCrowd").value || null,
    notes: document.getElementById("lNotes").value.trim() || null
  };

  try{
    let res;
    if(entryId){
      res = await fetch(`${SUPABASE_URL}/rest/v1/performances?id=eq.${entryId}`, {
        method:"PATCH", headers:{...HEADERS, "Prefer":"return=representation"}, body: JSON.stringify(payload)
      });
      if(!res.ok) throw new Error("Update failed");
      showToast("Performance updated");
    }else{
      res = await fetch(`${SUPABASE_URL}/rest/v1/performances`, {
        method:"POST", headers:{...HEADERS, "Prefer":"return=representation"}, body: JSON.stringify(payload)
      });
      if(!res.ok) throw new Error("Log failed");
      showToast("Performance logged");
    }
    venueHistory = null; // invalidate venue cache since a venue entry changed
    closeLog();
    fetchSongs();
  }catch(err){
    showToast("Error: " + err.message);
  }
};

// --- Venue autocomplete: previous venues you've logged, then real-world places ---
let venueHistory = null;
let venueDebounce = null;

async function loadVenueHistory(){
  if(venueHistory) return venueHistory;
  try{
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/performances?select=venue,performance_date&venue=not.is.null&order=performance_date.desc&limit=500`,
      {headers: HEADERS}
    );
    if(!res.ok) throw new Error();
    const rows = await res.json();
    const seen = new Set();
    venueHistory = [];
    rows.forEach(r=>{
      const v = (r.venue || "").trim();
      const key = v.toLowerCase();
      if(v && !seen.has(key)){ seen.add(key); venueHistory.push(v); }
    });
  }catch(e){
    venueHistory = [];
  }
  return venueHistory;
}

// --- Geolocation bias: use the device's real location when available so
// nearby venues rank first and small local businesses are more likely to
// surface at all. Falls back to a fixed Tacoma-area point if permission is
// denied, unavailable, or the browser doesn't support it. Cached for the
// session so we only ever prompt once.
const DEFAULT_VENUE_COORDS = {lat: 47.2529, lon: -122.4443};
let venueCoordsPromise = null;

function getVenueSearchCoords(){
  if(venueCoordsPromise) return venueCoordsPromise;
  venueCoordsPromise = new Promise((resolve) => {
    if(!navigator.geolocation){ resolve(DEFAULT_VENUE_COORDS); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({lat: pos.coords.latitude, lon: pos.coords.longitude}),
      () => resolve(DEFAULT_VENUE_COORDS),
      {enableHighAccuracy: false, timeout: 5000, maximumAge: 10 * 60 * 1000}
    );
  });
  return venueCoordsPromise;
}

// Peels generic venue-type descriptor words off the end of a query, e.g.
// "Porchlight Bar and Grill" -> "Porchlight". Map data (OSM) frequently only
// has the distinctive part of a business name indexed, or omits very new
// businesses' full "dba" style names, so retrying on just the core name
// catches matches the full phrase would miss.
const GENERIC_VENUE_SUFFIX = /\s+(bar\s*(?:and|&)\s*grill|grill\s*(?:and|&)\s*bar|sports\s*bar|bar\s*(?:and|&)\s*lounge|tap\s*house|taphouse|brewing\s*co\.?|brewery|tavern|saloon|pub|lounge|caf[eé]|restaurant|kitchen|bar)\s*$/i;

function stripGenericVenueSuffix(q){
  let stripped = q;
  let prev;
  do{
    prev = stripped;
    stripped = stripped.replace(GENERIC_VENUE_SUFFIX, "").trim();
  }while(stripped !== prev && stripped.length > 0);
  return stripped.replace(/\s+(?:and|&)\s*$/i, "").trim();
}

async function queryPhoton(q, coords){
  const bias = coords ? `&lat=${coords.lat}&lon=${coords.lon}&location_bias_scale=0.2` : "";
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6${bias}`;
  const res = await fetch(url);
  if(!res.ok) return [];
  const data = await res.json();
  return (data.features || []).map(f=>{
    const p = f.properties || {};
    const locality = [p.city || p.county, p.state].filter(Boolean).join(", ");
    return {label: p.name || p.street || "", sub: locality};
  }).filter(p => p.label);
}

async function queryNominatim(q, coords){
  const c = coords || DEFAULT_VENUE_COORDS;
  // Roughly a 15-20 mile box around the search origin, used only as a
  // soft ranking hint (bounded=0 still allows results outside it).
  const latSpan = 0.25, lonSpan = 0.35;
  const viewbox = `${c.lon - lonSpan},${c.lat + latSpan},${c.lon + lonSpan},${c.lat - latSpan}`;
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&limit=6&viewbox=${viewbox}&bounded=0`;
  const res = await fetch(url);
  if(!res.ok) return [];
  const data = await res.json();
  return (data || []).map(r => ({
    label: (r.display_name || "").split(",")[0].trim(),
    sub: (r.display_name || "").split(",").slice(1, 3).join(",").trim()
  })).filter(p => p.label);
}

async function searchPlaces(query){
  const q = query.trim();
  const coords = await getVenueSearchCoords();
  const stripped = stripGenericVenueSuffix(q);
  const hasStripped = stripped && stripped.toLowerCase() !== q.toLowerCase();
  let results = [];

  try{ results = await queryPhoton(q, coords); }catch(e){}
  if(results.length === 0){
    try{ results = await queryPhoton(q, null); }catch(e){}
  }
  if(results.length === 0 && hasStripped){
    try{ results = await queryPhoton(stripped, coords); }catch(e){}
  }
  // If a multi-word query with a leading word (e.g. an informal nickname like "Jim's")
  // comes up empty, retry against just the trailing words.
  const words = q.split(/\s+/);
  if(results.length === 0 && words.length > 1){
    try{ results = await queryPhoton(words.slice(1).join(" "), null); }catch(e){}
  }
  if(results.length === 0){
    try{ results = await queryNominatim(q, coords); }catch(e){}
  }
  if(results.length === 0 && hasStripped){
    try{ results = await queryNominatim(stripped, coords); }catch(e){}
  }
  return results;
}

const placeSearchCache = new Map(); // query (lowercased, trimmed) -> places[]

async function searchVenues(query){
  const q = query.trim().toLowerCase();
  const history = await loadVenueHistory();
  const previous = history.filter(v => v.toLowerCase().includes(q)).slice(0, 5);

  let places = [];
  if(query.trim().length >= 3){
    if(placeSearchCache.has(q)){
      places = placeSearchCache.get(q).filter(p => !previous.some(v=>v.toLowerCase()===p.label.toLowerCase()));
    }else{
      try{
        const raw = await searchPlaces(query);
        places = raw.filter(p => !previous.some(v=>v.toLowerCase()===p.label.toLowerCase()));
        // De-dupe by label since Nominatim can return near-duplicate rows
        const seen = new Set();
        places = places.filter(p=>{
          const key = p.label.toLowerCase();
          if(seen.has(key)) return false;
          seen.add(key);
          return true;
        }).slice(0, 5);
        placeSearchCache.set(q, places);
      }catch(e){
        // No network access or providers unreachable — fall back to previous-venue matches only
      }
    }
  }
  return {previous, places};
}

function renderVenueSuggestions({previous, places}){
  const list = document.getElementById("venueSuggestions");
  if(previous.length === 0 && places.length === 0){
    list.innerHTML = `<div class="autocomplete-empty">No matches — keep typing, or enter a new venue</div>`;
    list.classList.add("open");
    positionAutocompleteList(list);
    return;
  }
  let html = "";
  if(previous.length){
    html += `<div class="ac-group-label">Previous venues</div>`;
    html += previous.map(v => `
      <div class="autocomplete-item venue-item" data-value="${escapeHtml(v)}">
        <div class="ac-title">${escapeHtml(v)}</div>
      </div>
    `).join("");
  }
  if(places.length){
    html += `<div class="ac-group-label">Places</div>`;
    html += places.map(p => `
      <div class="autocomplete-item venue-item" data-value="${escapeHtml(p.label)}">
        <div class="ac-title">${escapeHtml(p.label)}</div>
        ${p.sub ? `<div class="ac-artist">${escapeHtml(p.sub)}</div>` : ""}
      </div>
    `).join("");
  }
  list.innerHTML = html;
  list.querySelectorAll(".venue-item").forEach(el=>{
    el.onclick = () => {
      document.getElementById("lVenue").value = el.dataset.value;
      updateVenueDirectionsLink();
      list.classList.remove("open");
    };
  });
  list.classList.add("open");
  positionAutocompleteList(list);
}

function updateVenueDirectionsLink(){
  const venue = document.getElementById("lVenue").value.trim();
  const row = document.getElementById("venueDirectionsRow");
  if(venue){
    document.getElementById("venueDirectionsLink").href = mapsDirectionsUrl(venue);
    row.style.display = "block";
  }else{
    row.style.display = "none";
  }
}

document.getElementById("lVenue").addEventListener("input", () => {
  clearTimeout(venueDebounce);
  const q = document.getElementById("lVenue").value;
  updateVenueDirectionsLink();
  const list = document.getElementById("venueSuggestions");
  if(q.trim().length < 2){ list.classList.remove("open"); return; }
  venueDebounce = setTimeout(async () => {
    renderVenueSuggestions(await searchVenues(q));
  }, 250);
});
document.getElementById("lVenue").addEventListener("blur", () => {
  setTimeout(() => document.getElementById("venueSuggestions").classList.remove("open"), 150);
});
document.getElementById("lVenue").addEventListener("focus", () => {
  const list = document.getElementById("venueSuggestions");
  if(list.innerHTML.trim()){ list.classList.add("open"); positionAutocompleteList(list); }
});

// --- Catalog autocomplete (searches your 84k-song karafun_catalog table) ---
let acDebounce = null;

// --- Mobile keyboard awareness -------------------------------------------
// On phones, opening the on-screen keyboard shrinks the *visible* area
// without necessarily shrinking the layout viewport our fixed-position
// sheets are sized against. Two consequences we correct for:
//   1) An autocomplete dropdown anchored below its input (top:100%) can
//      render partly or fully behind the keyboard.
//   2) A bottom sheet's fixed `bottom:0` can end up below the visible area
//      entirely, so its lower fields (and their dropdowns) are unreachable.
// window.visualViewport reports the actual visible viewport, so we use it
// to flip dropdowns upward when there's no room below, and to nudge the
// open sheet up to sit just above the keyboard.
const vv = window.visualViewport;

function positionAutocompleteList(list){
  const input = list.previousElementSibling;
  if(!input || !vv) return;
  const inputRect = input.getBoundingClientRect();
  const visibleBottom = vv.offsetTop + vv.height;
  const spaceBelow = visibleBottom - inputRect.bottom;
  const spaceAbove = inputRect.top - vv.offsetTop;
  const MARGIN = 12;
  const PREFERRED = 220; // matches the CSS max-height

  if(spaceBelow < 140 && spaceAbove > spaceBelow){
    list.classList.add("flip-up");
    list.style.maxHeight = Math.max(100, Math.min(PREFERRED, spaceAbove - MARGIN)) + "px";
  }else{
    list.classList.remove("flip-up");
    list.style.maxHeight = Math.max(100, Math.min(PREFERRED, spaceBelow - MARGIN)) + "px";
  }
}

function repositionOpenAutocompleteLists(){
  document.querySelectorAll(".autocomplete-list.open").forEach(positionAutocompleteList);
}

function keepActiveSheetAboveKeyboard(){
  if(!vv) return;
  const keyboardInset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  document.querySelectorAll(".sheet.open").forEach(sheet => {
    sheet.style.bottom = keyboardInset ? `${keyboardInset}px` : "";
    sheet.style.maxHeight = keyboardInset ? `${vv.height - 16}px` : "";
  });
  repositionOpenAutocompleteLists();
}

if(vv){
  vv.addEventListener("resize", keepActiveSheetAboveKeyboard);
  vv.addEventListener("scroll", keepActiveSheetAboveKeyboard);
}

async function searchCatalog(query){
  if(!query || query.trim().length < 2) return [];
  const term = `*${query.trim()}*`;
  const url = `${SUPABASE_URL}/rest/v1/karafun_catalog?select=title,artist&or=(title.ilike.${encodeURIComponent(term)},artist.ilike.${encodeURIComponent(term)})&limit=8&order=title.asc`;
  try{
    const res = await fetch(url, {headers: HEADERS});
    if(!res.ok) return [];
    return await res.json();
  }catch(e){
    return [];
  }
}

function renderSuggestions(listEl, results, onPick){
  if(results.length === 0){
    listEl.innerHTML = `<div class="autocomplete-empty">No catalog matches</div>`;
  }else{
    listEl.innerHTML = results.map((r, i) => `
      <div class="autocomplete-item" data-idx="${i}">
        <div class="ac-title">${escapeHtml(r.title)}</div>
        <div class="ac-artist">${escapeHtml(r.artist)}</div>
      </div>
    `).join("");
    listEl.querySelectorAll(".autocomplete-item").forEach(el=>{
      el.onclick = () => onPick(results[el.dataset.idx]);
    });
  }
  listEl.classList.add("open");
  positionAutocompleteList(listEl);
}

function wireAutocomplete(inputId, listId){
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);

  input.addEventListener("input", () => {
    clearTimeout(acDebounce);
    const q = input.value;
    if(q.trim().length < 2){ list.classList.remove("open"); return; }
    acDebounce = setTimeout(async () => {
      const results = await searchCatalog(q);
      renderSuggestions(list, results, (picked) => {
        document.getElementById("fTitle").value = picked.title;
        document.getElementById("fArtist").value = picked.artist;
        list.classList.remove("open");
        tryAutoFillRange(picked.title, picked.artist);
      });
    }, 250);
  });

  input.addEventListener("blur", () => {
    // Delay so a click on a suggestion registers before the list closes
    setTimeout(() => {
      list.classList.remove("open");
      // Fallback for manually-typed title/artist (no autocomplete pick) —
      // once both fields have something and focus leaves, try a lookup.
      const title = document.getElementById("fTitle").value.trim();
      const artist = document.getElementById("fArtist").value.trim();
      if(title && artist) tryAutoFillRange(title, artist);
    }, 150);
  });
  input.addEventListener("focus", () => {
    if(list.innerHTML.trim()){ list.classList.add("open"); positionAutocompleteList(list); }
  });
}

wireAutocomplete("fTitle", "titleSuggestions");
wireAutocomplete("fArtist", "artistSuggestions");

// If a range was auto-filled from the catalog and the user then edits it
// by hand, that's now their own manual value, not the catalog's.
["fLow","fHigh"].forEach(id => {
  document.getElementById(id).addEventListener("input", () => {
    document.getElementById("fRangeSource").value = "manual";
  });
});
// --- Recommendations (v1: catalog-based — matches artists you're Solid on, gated by vocal range) ---
const recSheet = document.getElementById("recSheet");
const recBackdrop = document.getElementById("recBackdrop");

document.getElementById("recBtn").onclick = openRecommendations;
document.getElementById("btnRecClose").onclick = closeRecommendations;
recBackdrop.onclick = closeRecommendations;

function closeRecommendations(){
  recBackdrop.classList.remove("open");
  recSheet.classList.remove("open");
}

function normalizeForMatch(str){
  return (str || "").replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();
}

// Songs the user has explicitly dismissed from recommendations, so they
// don't keep resurfacing every time openRecommendations() runs. Keyed by
// normalized title+artist, same convention as fetchSongRanges() below.
async function fetchDismissedRecommendations(){
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/dismissed_recommendations?select=title_normalized,artist_normalized`, {headers: HEADERS});
    if(!res.ok) return new Set();
    const rows = await res.json();
    return new Set(rows.map(r => `${r.title_normalized}|${r.artist_normalized}`));
  }catch(e){
    return new Set();
  }
}

async function fetchSongRanges(){
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/song_ranges?select=title,artist,low_note,high_note`, {headers: HEADERS});
    if(!res.ok) return new Map();
    const rows = await res.json();
    const map = new Map();
    rows.forEach(r => map.set(`${normalizeForMatch(r.title)}|${normalizeForMatch(r.artist)}`, r));
    return map;
  }catch(e){
    return new Map();
  }
}

// Looks up a single song in the shared song_ranges table by normalized
// title+artist match. Used to auto-fill low/high note when adding a song
// that's already been researched, instead of leaving it blank for the
// user to fill in (or duplicate work someone already did).
async function lookupSongRange(title, artist){
  const tNorm = normalizeForMatch(title);
  const aNorm = normalizeForMatch(artist);
  if(!tNorm || !aNorm) return null;
  try{
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/song_ranges?select=low_note,high_note&title_normalized=eq.${encodeURIComponent(tNorm)}&artist_normalized=eq.${encodeURIComponent(aNorm)}&limit=1`,
      {headers: HEADERS}
    );
    if(!res.ok) return null;
    const rows = await res.json();
    return rows[0] || null;
  }catch(e){
    return null;
  }
}

// Fills fLow/fHigh from song_ranges if there's a match and the fields are
// currently empty (never overwrites something the user already has, e.g.
// when editing an existing song). Marks the source so it's visually
// distinguishable and so a later manual edit can override it cleanly.
async function tryAutoFillRange(title, artist){
  const lowEl = document.getElementById("fLow");
  const highEl = document.getElementById("fHigh");
  if(lowEl.value.trim() || highEl.value.trim()) return; // don't clobber existing values

  const match = await lookupSongRange(title, artist);
  if(match && match.low_note && match.high_note){
    lowEl.value = match.low_note;
    highEl.value = match.high_note;
    document.getElementById("fRangeSource").value = "estimated";
    showToast(`Range filled in from the catalog (${match.low_note}–${match.high_note})`);
  }
}

// Builds the ranked list of artists to search the catalog for, in three
// tiers: solid (your own proven artists — highest weight/cap), genre
// (other artists already in your songbook sharing a genre tag with a
// Solid song), and similar (Last.fm's real similar-artist data for your
// top Solid artists, only if a key is saved in Settings). Each entry
// carries a `label` used directly in the UI and a `cap` limiting how many
// catalog songs from that artist get pulled in, since genre/similar
// matches are hunches and shouldn't crowd out proven-artist results.
//
// Solid artists are seeded least-represented first: an artist you're
// already deep on (lots of Solid songs) doesn't need more backfill from
// recommendations, but one you're only solid on one song for has real
// room to grow. Each tier also gets its own candidate budget (see
// openRecommendations) so a long solid-artist list can't starve out
// genre/similar before they're ever queried.
async function buildSeedArtists(solidSongs){
  const seeds = [];
  const seenArtistKeys = new Set();

  const artistCounts = {};
  solidSongs.forEach(s=>{
    const a = (s.artist || "").trim();
    if(a) artistCounts[a] = (artistCounts[a] || 0) + 1;
  });
  const solidArtistNames = Object.keys(artistCounts).sort((a, b) => artistCounts[a] - artistCounts[b]);
  solidArtistNames.forEach(name=>{
    seeds.push({name, type:"solid", cap:4, label:`Because you're solid on ${name}`});
    seenArtistKeys.add(name.toLowerCase());
  });

  // Genre neighbors: other artists already in the songbook (any status
  // but Retired) sharing a genre tag with a Solid song.
  const solidGenres = new Set(solidSongs.map(s => (s.genre||"").trim().toLowerCase()).filter(Boolean));
  if(solidGenres.size > 0){
    songs.forEach(s=>{
      if(s.status === "Retired") return;
      const genre = (s.genre||"").trim();
      const artist = (s.artist||"").trim();
      const genreLower = genre.toLowerCase();
      if(!genre || !artist || !solidGenres.has(genreLower)) return;
      if(seenArtistKeys.has(artist.toLowerCase())) return;
      seenArtistKeys.add(artist.toLowerCase());
      const buddy = solidSongs.find(ss => (ss.genre||"").trim().toLowerCase() === genreLower);
      seeds.push({
        name: artist, type:"genre", cap:4,
        label: buddy ? `${genre} — like your ${buddy.artist}` : `Also tagged ${genre}`
      });
    });
  }

  // Last.fm similar artists — optional, only runs if a key is saved.
  // Similar artists via Last.fm, proxied through a Supabase Edge Function
  // so the API key lives server-side (one shared key for the whole app)
  // instead of requiring every signed-in user to get and paste their own.
  // Anchored on your *most*-represented solid artists (your signature
  // sound), not the ascending backfill order above — "similar to the
  // artist you're only solid on once" is a much weaker signal than
  // "similar to the artist you have eight solid songs for."
  if(solidArtistNames.length > 0){
    const topArtists = [...solidArtistNames].sort((a, b) => artistCounts[b] - artistCounts[a]).slice(0, 8);
    try{
      const res = await fetch(`${SUPABASE_URL}/functions/v1/similar-artists`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({artists: topArtists, limitPerArtist: 5})
      });
      if(res.ok){
        const data = await res.json();
        const resultsByArtist = data.results || {};
        topArtists.forEach(artist=>{
          const names = resultsByArtist[artist] || [];
          names.forEach(name=>{
            if(!name || seenArtistKeys.has(name.toLowerCase())) return;
            seenArtistKeys.add(name.toLowerCase());
            seeds.push({name, type:"similar", cap:4, label:`Similar to ${artist} (Last.fm)`});
          });
        });
      }
    }catch(e){
      // A Last.fm/Edge Function hiccup shouldn't block genre/solid recommendations.
    }
  }

  return seeds;
}

// Fetches karafun_catalog candidates for one tier's seed list only,
// stopping once `budget` candidates have been collected *for this tier*.
// Each seed's own `cap` still limits how many songs come from any one
// artist. `seenKeys` is shared across all three tier calls so the same
// song is never pulled in twice even if it happens to match seeds from
// more than one tier.
async function fetchTierCandidates(seedList, budget, known, dismissed, seenKeys){
  const candidates = [];
  const perArtistCount = {};
  const CHUNK_SIZE = 8; // keeps the OR-query URL reasonably short
  const seedByName = new Map(seedList.map(s => [s.name.toLowerCase(), s]));
  const artists = seedList.map(s => s.name);

  for(let i = 0; i < artists.length && candidates.length < budget; i += CHUNK_SIZE){
    const chunk = artists.slice(i, i + CHUNK_SIZE);
    // Postgrest OR syntax needs literal commas between conditions, so artists
    // containing a comma (rare) are skipped from batching and looked up individually below.
    const batchable = chunk.filter(a => !a.includes(","));
    const skipped = chunk.filter(a => a.includes(","));

    if(batchable.length > 0){
      const orClause = batchable.map(a => `artist.ilike.${encodeURIComponent(`*${a}*`)}`).join(",");
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/karafun_catalog?select=title,artist&or=(${orClause})&limit=200&order=artist.asc`,
        {headers: HEADERS}
      );
      if(res.ok){
        const rows = await res.json();
        rows.forEach(r=>{
          if(candidates.length >= budget) return;
          const matchedArtist = batchable.find(a => (r.artist||"").toLowerCase().includes(a.toLowerCase()));
          if(!matchedArtist) return;
          const key = `${(r.title||"").toLowerCase()}|${(r.artist||"").toLowerCase()}`;
          const normKey = `${normalizeForMatch(r.title)}|${normalizeForMatch(r.artist)}`;
          if(known.has(key) || seenKeys.has(key) || dismissed.has(normKey)) return;
          const seed = seedByName.get(matchedArtist.toLowerCase());
          const cap = seed ? seed.cap : 10;
          if((perArtistCount[matchedArtist]||0) >= cap) return;
          perArtistCount[matchedArtist] = (perArtistCount[matchedArtist]||0) + 1;
          seenKeys.add(key);
          candidates.push({...r, sourceArtist: matchedArtist, sourceLabel: seed ? seed.label : `By ${matchedArtist}`});
        });
      }
    }

    for(const artist of skipped){
      if(candidates.length >= budget) break;
      const term = `*${artist}*`;
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/karafun_catalog?select=title,artist&artist=ilike.${encodeURIComponent(term)}&limit=10&order=title.asc`,
        {headers: HEADERS}
      );
      if(!res.ok) continue;
      const rows = await res.json();
      const seed = seedByName.get(artist.toLowerCase());
      rows.forEach(r=>{
        if(candidates.length >= budget) return;
        const key = `${(r.title||"").toLowerCase()}|${(r.artist||"").toLowerCase()}`;
        const normKey = `${normalizeForMatch(r.title)}|${normalizeForMatch(r.artist)}`;
        if(known.has(key) || seenKeys.has(key) || dismissed.has(normKey)) return;
        seenKeys.add(key);
        candidates.push({...r, sourceArtist: artist, sourceLabel: seed ? seed.label : `By ${artist}`});
      });
    }
  }

  return candidates;
}

// Round-robins multiple tier candidate lists into one — one from each
// list in turn, cycling until all are exhausted — so the final order
// isn't dominated by whichever tier happens to be biggest, even though
// each tier already has its own budget.
function interleaveTiers(tierLists){
  const merged = [];
  let idx = 0;
  let any = tierLists.some(l => l.length > 0);
  while(any){
    any = false;
    for(const list of tierLists){
      if(idx < list.length){ merged.push(list[idx]); any = true; }
    }
    idx++;
  }
  return merged;
}

async function openRecommendations(){
  recBackdrop.classList.add("open");
  recSheet.classList.add("open");
  const listEl = document.getElementById("recList");
  listEl.innerHTML = `<div class="rec-loading">Finding matches and checking vocal range…</div>`;

  const solidSongs = songs.filter(s => s.status === "Solid");
  if(solidSongs.length === 0){
    listEl.innerHTML = `<div class="rec-empty">Mark a few songs Solid to get started — recommendations are built from what's already working for you.</div>`;
    return;
  }

  const seeds = await buildSeedArtists(solidSongs);
  const known = new Set(songs.map(s => `${(s.title||"").toLowerCase()}|${(s.artist||"").toLowerCase()}`));
  const dismissed = await fetchDismissedRecommendations();

  try{
    // Each tier gets its own candidate budget, fetched independently, so
    // a long solid-artist list can't starve out genre/similar before
    // they're ever queried — previously all three shared one running
    // counter processed solid-first, which meant genre/similar frequently
    // never ran at all once solid alone filled the shared cap.
    const TIER_BUDGETS = {solid: 35, genre: 30, similar: 25};
    const seenKeys = new Set();
    const solidCandidates = await fetchTierCandidates(seeds.filter(s=>s.type==="solid"), TIER_BUDGETS.solid, known, dismissed, seenKeys);
    const genreCandidates = await fetchTierCandidates(seeds.filter(s=>s.type==="genre"), TIER_BUDGETS.genre, known, dismissed, seenKeys);
    const similarCandidates = await fetchTierCandidates(seeds.filter(s=>s.type==="similar"), TIER_BUDGETS.similar, known, dismissed, seenKeys);
    const candidates = interleaveTiers([solidCandidates, genreCandidates, similarCandidates]);

    // Gate every candidate on vocal range before it's shown for consideration.
    const rangeMap = await fetchSongRanges();
    const fitResults = [];
    const outOfRangeResults = [];
    const unconfirmedSongs = [];
    candidates.forEach(c=>{
      const rangeRow = rangeMap.get(`${normalizeForMatch(c.title)}|${normalizeForMatch(c.artist)}`);
      if(!rangeRow){ unconfirmedSongs.push({title: c.title, artist: c.artist}); return; }
      const lowS = noteToSemitone(rangeRow.low_note), highS = noteToSemitone(rangeRow.high_note);
      const fit = fitLabel(lowS, highS);
      const enriched = {...c, low_note: rangeRow.low_note, high_note: rangeRow.high_note, fit};
      if(fit.cls === "fit-easy"){
        fitResults.push(enriched);
      }else if(fit.cls === "fit-out"){
        enriched.transposeMsg = transpositionMessage(lowS, highS);
        outOfRangeResults.push(enriched);
      }
      // fit-unknown (no range data) is the only case excluded from consideration.
    });
    renderRecommendations(fitResults, outOfRangeResults, unconfirmedSongs);
  }catch(err){
    listEl.innerHTML = `<div class="rec-empty">Couldn't load recommendations: ${err.message}</div>`;
  }
}

function renderRecommendations(results, outOfRangeResults, unconfirmedSongs){
  const listEl = document.getElementById("recList");
  const unconfirmedNote = unconfirmedSongs.length > 0
    ? `<div class="rec-unconfirmed-note">
        ${unconfirmedSongs.length} more song${unconfirmedSongs.length===1?"":"s"} matched by artist but ${unconfirmedSongs.length===1?"hasn't":"haven't"} had its vocal range checked yet, so ${unconfirmedSongs.length===1?"it's":"they're"} left out of consideration.
        <button class="ask-claude-btn" id="askClaudeRecBtn">Ask Claude to research these ranges</button>
        <div id="askClaudeRecBox" style="display:none;"></div>
      </div>`
    : "";

  if(results.length === 0 && outOfRangeResults.length === 0){
    listEl.innerHTML = `<div class="rec-empty">No range-confirmed matches right now.</div>${unconfirmedNote}`;
    wireAskClaudeRecBtn(unconfirmedSongs);
    return;
  }

  const renderItem = (r, i, group) => `
    <div class="rec-item">
      <div class="rec-item-info">
        <div class="rec-item-title">${escapeHtml(r.title)}</div>
        <div class="rec-item-artist">${escapeHtml(r.artist)}</div>
        <div class="rec-item-source">
          ${escapeHtml(r.sourceLabel)} ·
          <span class="rec-fit-badge ${r.fit.cls}">${r.fit.text}</span>
        </div>
        ${r.transposeMsg ? `<div class="rec-transpose">${escapeHtml(r.transposeMsg)}</div>` : ""}
      </div>
      <div class="rec-item-actions">
        <button class="rec-add-btn" data-group="${group}" data-idx="${i}">+ Learning</button>
        <button class="rec-dismiss-btn" data-group="${group}" data-idx="${i}">Dismiss</button>
      </div>
    </div>
  `;

  let html = results.map((r, i) => renderItem(r, i, "fit")).join("");
  if(outOfRangeResults.length > 0){
    html += `<div class="rec-section-label">Would need a key change</div>`;
    html += outOfRangeResults.map((r, i) => renderItem(r, i, "out")).join("");
  }
  html += unconfirmedNote;
  listEl.innerHTML = html;

  listEl.querySelectorAll(".rec-add-btn").forEach(b=>{
    const source = b.dataset.group === "fit" ? results : outOfRangeResults;
    b.onclick = () => addRecommendation(source[b.dataset.idx], b.closest(".rec-item"));
  });
  listEl.querySelectorAll(".rec-dismiss-btn").forEach(b=>{
    const source = b.dataset.group === "fit" ? results : outOfRangeResults;
    b.onclick = () => dismissRecommendation(source[b.dataset.idx], b.closest(".rec-item"));
  });
  wireAskClaudeRecBtn(unconfirmedSongs);
}

function wireAskClaudeRecBtn(unconfirmedSongs){
  const btn = document.getElementById("askClaudeRecBtn");
  if(!btn) return;
  btn.onclick = () => {
    const prompt = buildRecommendationRangePrompt(unconfirmedSongs);
    askClaude(prompt, document.getElementById("askClaudeRecBox"));
  };
}

// Unlike buildRangePrompt (which updates the user's own songs by row id),
// these are catalog candidates not yet in the songbook — so this asks
// Claude to add/update rows in the shared song_ranges table instead,
// matched by title+artist since there's no existing row id to reference.
function buildRecommendationRangePrompt(unconfirmedSongs){
  const CAP = 40;
  const capped = unconfirmedSongs.slice(0, CAP);
  const list = capped.map(s => `- "${s.title}" by ${s.artist}`).join("\n");
  const overflowNote = unconfirmedSongs.length > capped.length
    ? `\n\n(${unconfirmedSongs.length - capped.length} more were left off to keep this list manageable — ask again for the rest if useful.)`
    : "";
  return `Please research the vocal range (low and high note, e.g. "A2") for these songs, then add or update them in my Supabase project (karaoke-prod, ref luykkuptcizkdigwness), table "song_ranges" (shared reference data, not my personal songbook) — columns low_note/high_note, matched by title + artist (insert a new row if one doesn't already exist for that title_normalized/artist_normalized pair):\n\n${list}${overflowNote}\n\nThese are recommendation candidates — artists I'm already Solid on, songs I haven't added to my own songbook yet — so I can see whether they're actually in my range before deciding whether to learn them.`;
}

async function addRecommendation(rec, itemEl){
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/songs`, {
      method:"POST", headers:{...HEADERS, "Prefer":"return=representation"},
      body: JSON.stringify({title: rec.title, artist: rec.artist, status: "Learning", low_note: rec.low_note || null, high_note: rec.high_note || null, range_source: rec.low_note ? "estimated" : "manual"})
    });
    if(!res.ok) throw new Error("Add failed");
    showToast(`Added "${rec.title}" to Learning`);
    await animateRemove(itemEl);
    fetchSongs();
  }catch(err){
    showToast("Error: " + err.message);
  }
}

// Persists a recommendation dismissal so it's excluded from future
// openRecommendations() runs (see fetchDismissedRecommendations() /
// the `dismissed` filter above). Uses upsert so re-dismissing something
// already dismissed (e.g. a race between tabs) doesn't error.
async function dismissRecommendation(rec, itemEl){
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/dismissed_recommendations`, {
      method:"POST",
      headers:{...HEADERS, "Prefer":"return=minimal,resolution=merge-duplicates"},
      body: JSON.stringify({title: rec.title, artist: rec.artist})
    });
    if(!res.ok) throw new Error("Dismiss failed");
  }catch(err){
    showToast("Error: " + err.message);
  }
  await animateRemove(itemEl);
}

// --- Setlists: named, ordered song lists optionally tied to a gig date/venue ---
const setlistDetailSheet = document.getElementById("setlistDetailSheet");
const setlistDetailBackdrop = document.getElementById("setlistDetailBackdrop");

let setlists = [];
let currentSetlistId = null;
let currentSetlistSongs = []; // [{id: setlist_songs row id, song_id, title, artist}], in position order
let slAddSearchTerm = "";

document.getElementById("btnSetlistDetailCancel").onclick = closeSetlistDetail;

function closeSetlistDetail(){
  setlistDetailBackdrop.classList.remove("open");
  setlistDetailSheet.classList.remove("open");
}

async function fetchSetlists(){
  const listEl = document.getElementById("setlistsList");
  listEl.innerHTML = `<div class="loading">Loading setlists…</div>`;
  try{
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/setlists?select=*,setlist_songs(count)&order=gig_date.desc.nullslast,created_at.desc`,
      {headers: HEADERS}
    );
    if(!res.ok) throw new Error("Fetch failed: " + res.status);
    setlists = await res.json();
    renderSetlistsList();
  }catch(err){
    listEl.innerHTML = `<div class="empty">Couldn't load setlists.<br>${escapeHtml(err.message)}</div>`;
  }
}

function renderSetlistsList(){
  const listEl = document.getElementById("setlistsList");
  if(setlists.length === 0){
    listEl.innerHTML = `<div class="empty">No setlists yet. Build one with the button below.</div>`;
    return;
  }
  listEl.innerHTML = setlists.map(sl => {
    const count = (sl.setlist_songs && sl.setlist_songs[0] && sl.setlist_songs[0].count) || 0;
    const metaParts = [];
    if(sl.gig_date) metaParts.push(formatDate(sl.gig_date));
    if(sl.venue) metaParts.push(sl.venue);
    metaParts.push(`${count} song${count===1?"":"s"}`);
    return `
      <div class="setlist-item" data-id="${sl.id}">
        <div class="setlist-item-info">
          <div class="setlist-item-title">${escapeHtml(sl.name)}</div>
          <div class="setlist-item-meta">${escapeHtml(metaParts.join(" · "))}</div>
        </div>
        <div class="setlist-item-actions">
          <button class="rec-dismiss-btn setlist-dup-btn" data-id="${sl.id}">Duplicate</button>
          <button class="rec-dismiss-btn setlist-delete-btn" data-id="${sl.id}">Delete</button>
        </div>
      </div>
    `;
  }).join("");

  listEl.querySelectorAll(".setlist-item").forEach(el=>{
    el.onclick = (e) => {
      if(e.target.closest(".setlist-delete-btn") || e.target.closest(".setlist-dup-btn")) return;
      openSetlistDetail(el.dataset.id);
    };
  });
  listEl.querySelectorAll(".setlist-dup-btn").forEach(b=>{
    b.onclick = (e) => { e.stopPropagation(); duplicateSetlist(b.dataset.id); };
  });
  listEl.querySelectorAll(".setlist-delete-btn").forEach(b=>{
    b.onclick = (e) => { e.stopPropagation(); deleteSetlist(b.dataset.id); };
  });
}

async function duplicateSetlist(id){
  const source = setlists.find(s => s.id === id);
  if(!source) return;
  try{
    const createRes = await fetch(`${SUPABASE_URL}/rest/v1/setlists`, {
      method:"POST", headers:{...HEADERS, "Prefer":"return=representation"},
      body: JSON.stringify({
        name: `${source.name} (copy)`,
        // Gig date is intentionally left blank on the copy — a duplicate
        // is normally being reused for a *different* date, and carrying
        // the old one over is more likely to be wrong than right.
        gig_date: null,
        venue: source.venue || null,
        notes: source.notes || null
      })
    });
    if(!createRes.ok) throw new Error("Duplicate failed");
    const created = (await createRes.json())[0];

    const songsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/setlist_songs?setlist_id=eq.${id}&select=song_id,position&order=position.asc`,
      {headers: HEADERS}
    );
    if(!songsRes.ok) throw new Error("Couldn't copy songs");
    const rows = await songsRes.json();
    if(rows.length > 0){
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/setlist_songs`, {
        method:"POST", headers: HEADERS,
        body: JSON.stringify(rows.map(r => ({
          setlist_id: created.id, song_id: r.song_id, position: r.position
        })))
      });
      if(!insertRes.ok) throw new Error("Couldn't copy songs");
    }

    showToast(`Duplicated as "${created.name}"`);
    await fetchSetlists();
  }catch(err){
    showToast("Error: " + err.message);
  }
}

async function deleteSetlist(id, opts={}){
  if(!opts.skipConfirm && !confirm("Delete this setlist? Its songs stay in your songbook.")) return false;
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/setlists?id=eq.${id}`, {method:"DELETE", headers: HEADERS});
    if(!res.ok) throw new Error("Delete failed");
    showToast("Setlist deleted");
    fetchSetlists();
    return true;
  }catch(err){
    showToast("Error: " + err.message);
    return false;
  }
}

// --- Quick add: jump straight from a song card to a new or existing setlist ---
const addToSetlistSheet = document.getElementById("addToSetlistSheet");
const addToSetlistBackdrop = document.getElementById("addToSetlistBackdrop");
let addToSetlistSongId = null;

async function openAddToSetlist(songId){
  addToSetlistSongId = songId;
  const song = songs.find(s => s.id === songId);
  document.getElementById("addToSetlistSongLabel").textContent = song ? `${song.title} — ${song.artist}` : "";
  document.getElementById("atsNewName").value = "";
  document.getElementById("addToSetlistList").innerHTML = `<div class="loading">Loading setlists…</div>`;
  addToSetlistBackdrop.classList.add("open");
  addToSetlistSheet.classList.add("open");
  await fetchSetlists(); // keeps this sheet's counts current with the Setlists sheet
  renderAddToSetlistList();
}
function closeAddToSetlist(){
  addToSetlistBackdrop.classList.remove("open");
  addToSetlistSheet.classList.remove("open");
  addToSetlistSongId = null;
}
document.getElementById("btnAddToSetlistClose").onclick = closeAddToSetlist;

function renderAddToSetlistList(){
  const listEl = document.getElementById("addToSetlistList");
  if(setlists.length === 0){
    listEl.innerHTML = `<div class="empty" style="padding:16px 4px;">No setlists yet — create one below.</div>`;
    return;
  }
  listEl.innerHTML = setlists.map(sl => {
    const count = (sl.setlist_songs && sl.setlist_songs[0] && sl.setlist_songs[0].count) || 0;
    const metaParts = [];
    if(sl.gig_date) metaParts.push(formatDate(sl.gig_date));
    if(sl.venue) metaParts.push(sl.venue);
    metaParts.push(`${count} song${count===1?"":"s"}`);
    return `
      <div class="setlist-item" style="cursor:default;">
        <div class="setlist-item-info">
          <div class="setlist-item-title">${escapeHtml(sl.name)}</div>
          <div class="setlist-item-meta">${escapeHtml(metaParts.join(" · "))}</div>
        </div>
        <button class="rec-add-btn ats-add-btn" data-id="${sl.id}">+ Add</button>
      </div>
    `;
  }).join("");
  listEl.querySelectorAll(".ats-add-btn").forEach(b=>{
    b.onclick = () => addSongToSetlistById(b.dataset.id, addToSetlistSongId);
  });
}

async function addSongToSetlistById(setlistId, songId){
  if(!songId) return;
  const sl = setlists.find(s => s.id === setlistId);
  const count = sl ? ((sl.setlist_songs && sl.setlist_songs[0] && sl.setlist_songs[0].count) || 0) : 0;
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/setlist_songs`, {
      method:"POST", headers:{...HEADERS, "Prefer":"return=representation"},
      body: JSON.stringify({setlist_id: setlistId, song_id: songId, position: count})
    });
    if(res.status === 409){
      showToast("Already in that setlist");
      return;
    }
    if(!res.ok) throw new Error("Add failed");
    showToast(`Added to "${sl ? sl.name : "setlist"}"`);
    closeAddToSetlist();
    fetchSetlists();
    // Keep the detail sheet's song list in sync if it happens to be open on this setlist.
    if(currentSetlistId === setlistId) fetchSetlistSongs(setlistId);
  }catch(err){
    showToast("Error: " + err.message);
  }
}

document.getElementById("btnAddToSetlistCreate").onclick = async () => {
  const name = document.getElementById("atsNewName").value.trim();
  if(!name){ showToast("Name is required"); return; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/setlists`, {
      method:"POST", headers:{...HEADERS, "Prefer":"return=representation"},
      body: JSON.stringify({name})
    });
    if(!res.ok) throw new Error("Create failed");
    const created = (await res.json())[0];
    await fetchSetlists(); // pulls the new row into the cache addSongToSetlistById reads from
    await addSongToSetlistById(created.id, addToSetlistSongId);
  }catch(err){
    showToast("Error: " + err.message);
  }
};

async function openSetlistDetail(id){
  currentSetlistId = id;
  document.getElementById("setlistEditId").value = id || "";
  document.getElementById("setlistDetailTitle").textContent = id ? "Edit setlist" : "New setlist";
  document.getElementById("btnDeleteSetlist").style.display = id ? "block" : "none";
  document.getElementById("setlistSongsSection").style.display = id ? "block" : "none";

  const sl = id ? setlists.find(s => s.id === id) : null;
  document.getElementById("slName").value = sl ? sl.name : "";
  document.getElementById("slDate").value = sl && sl.gig_date ? sl.gig_date : "";
  document.getElementById("slVenue").value = sl && sl.venue ? sl.venue : "";
  document.getElementById("slNotes").value = sl && sl.notes ? sl.notes : "";

  document.getElementById("slAddSearch").value = "";
  slAddSearchTerm = "";
  document.getElementById("slAddResults").innerHTML = "";

  if(id){
    await fetchSetlistSongs(id);
  }else{
    currentSetlistSongs = [];
  }

  setlistDetailBackdrop.classList.add("open");
  setlistDetailSheet.classList.add("open");
}

document.getElementById("btnSetlistDetailSave").onclick = async () => {
  const name = document.getElementById("slName").value.trim();
  if(!name){ showToast("Name is required"); return; }
  const payload = {
    name,
    gig_date: document.getElementById("slDate").value || null,
    venue: document.getElementById("slVenue").value.trim() || null,
    notes: document.getElementById("slNotes").value.trim() || null,
    updated_at: new Date().toISOString()
  };
  try{
    if(currentSetlistId){
      const res = await fetch(`${SUPABASE_URL}/rest/v1/setlists?id=eq.${currentSetlistId}`, {
        method:"PATCH", headers:{...HEADERS, "Prefer":"return=representation"},
        body: JSON.stringify(payload)
      });
      if(!res.ok) throw new Error("Save failed");
      showToast("Setlist saved");
      await fetchSetlists();
      closeSetlistDetail();
    }else{
      const res = await fetch(`${SUPABASE_URL}/rest/v1/setlists`, {
        method:"POST", headers:{...HEADERS, "Prefer":"return=representation"},
        body: JSON.stringify(payload)
      });
      if(!res.ok) throw new Error("Create failed");
      const created = await res.json();
      showToast("Setlist created — now add some songs");
      await fetchSetlists();
      // Reopen the newly-created setlist so songs can be added right away
      // instead of dumping the user back at the list.
      openSetlistDetail(created[0].id);
    }
  }catch(err){
    showToast("Error: " + err.message);
  }
};

document.getElementById("btnDeleteSetlist").onclick = async () => {
  if(!currentSetlistId) return;
  const ok = await deleteSetlist(currentSetlistId);
  if(ok) closeSetlistDetail();
};

async function fetchSetlistSongs(setlistId){
  try{
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/setlist_songs?setlist_id=eq.${setlistId}&select=id,song_id,position,songs(title,artist)&order=position.asc`,
      {headers: HEADERS}
    );
    if(!res.ok) throw new Error("Fetch failed");
    const raw = await res.json();
    currentSetlistSongs = raw.map(r => ({
      id: r.id,
      song_id: r.song_id,
      title: (r.songs && r.songs.title) || "(song removed from songbook)",
      artist: (r.songs && r.songs.artist) || ""
    }));
  }catch(err){
    currentSetlistSongs = [];
    showToast("Couldn't load setlist songs: " + err.message);
  }
  renderSetlistSongs();
}

function renderSetlistSongs(){
  const listEl = document.getElementById("setlistSongsList");
  if(currentSetlistSongs.length === 0){
    listEl.innerHTML = `<div class="empty" style="padding:16px 4px;">No songs yet — search below to add some.</div>`;
    return;
  }
  listEl.innerHTML = currentSetlistSongs.map((s, i) => `
    <div class="sl-song-row" data-id="${s.id}">
      <div class="sl-song-num">${i+1}</div>
      <div class="sl-song-info">
        <div class="sl-song-title">${escapeHtml(s.title)}</div>
        <div class="sl-song-artist">${escapeHtml(s.artist)}</div>
      </div>
      <div class="sl-song-actions">
        <button class="sl-move-btn" data-id="${s.id}" data-dir="up" ${i===0 ? "disabled" : ""} aria-label="Move up">↑</button>
        <button class="sl-move-btn" data-id="${s.id}" data-dir="down" ${i===currentSetlistSongs.length-1 ? "disabled" : ""} aria-label="Move down">↓</button>
        <button class="sl-remove-btn" data-id="${s.id}" aria-label="Remove">✕</button>
      </div>
    </div>
  `).join("");

  listEl.querySelectorAll(".sl-move-btn").forEach(b=>{
    b.onclick = () => moveSetlistSong(b.dataset.id, b.dataset.dir);
  });
  listEl.querySelectorAll(".sl-remove-btn").forEach(b=>{
    b.onclick = () => removeSetlistSong(b.dataset.id);
  });
}

async function moveSetlistSong(id, dir){
  const idx = currentSetlistSongs.findIndex(s => s.id === id);
  const swapIdx = dir === "up" ? idx - 1 : idx + 1;
  if(idx < 0 || swapIdx < 0 || swapIdx >= currentSetlistSongs.length) return;

  [currentSetlistSongs[idx], currentSetlistSongs[swapIdx]] = [currentSetlistSongs[swapIdx], currentSetlistSongs[idx]];
  renderSetlistSongs();
  await persistSetlistOrder();
}

// Renumbers every row to match the current in-memory order. Simpler and
// more robust than patching just the two swapped rows, since positions
// can develop gaps after a song is removed.
async function persistSetlistOrder(){
  try{
    const results = await Promise.all(currentSetlistSongs.map((s, i) =>
      fetch(`${SUPABASE_URL}/rest/v1/setlist_songs?id=eq.${s.id}`, {
        method:"PATCH", headers: HEADERS,
        body: JSON.stringify({position: i})
      })
    ));
    if(results.some(r => !r.ok)) throw new Error("Reorder failed");
  }catch(err){
    showToast("Couldn't save order: " + err.message);
    fetchSetlistSongs(currentSetlistId);
  }
}

async function removeSetlistSong(id){
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/setlist_songs?id=eq.${id}`, {method:"DELETE", headers: HEADERS});
    if(!res.ok) throw new Error("Remove failed");
    currentSetlistSongs = currentSetlistSongs.filter(s => s.id !== id);
    renderSetlistSongs();
  }catch(err){
    showToast("Error: " + err.message);
  }
}

document.getElementById("slAddSearch").oninput = (e) => {
  slAddSearchTerm = e.target.value.trim().toLowerCase();
  renderSlAddResults();
};

function renderSlAddResults(){
  const resultsEl = document.getElementById("slAddResults");
  if(!slAddSearchTerm){
    resultsEl.innerHTML = "";
    return;
  }
  const addedIds = new Set(currentSetlistSongs.map(s => s.song_id));
  const matches = songs.filter(s =>
    !addedIds.has(s.id) &&
    ((s.title||"").toLowerCase().includes(slAddSearchTerm) || (s.artist||"").toLowerCase().includes(slAddSearchTerm))
  ).slice(0, 25);

  if(matches.length === 0){
    resultsEl.innerHTML = `<div class="autocomplete-empty">No matching songs in your songbook</div>`;
    return;
  }
  resultsEl.innerHTML = matches.map(s => `
    <div class="autocomplete-item" data-id="${s.id}">
      <div class="ac-title">${escapeHtml(s.title)}</div>
      <div class="ac-artist">${escapeHtml(s.artist)}</div>
    </div>
  `).join("");
  resultsEl.querySelectorAll(".autocomplete-item").forEach(el=>{
    el.onclick = () => addSongToSetlist(el.dataset.id);
  });
}

async function addSongToSetlist(songId){
  if(!currentSetlistId) return;
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/setlist_songs`, {
      method:"POST", headers:{...HEADERS, "Prefer":"return=representation"},
      body: JSON.stringify({setlist_id: currentSetlistId, song_id: songId, position: currentSetlistSongs.length})
    });
    if(!res.ok) throw new Error("Add failed");
    const song = songs.find(s => s.id === songId);
    document.getElementById("slAddSearch").value = "";
    slAddSearchTerm = "";
    document.getElementById("slAddResults").innerHTML = "";
    await fetchSetlistSongs(currentSetlistId);
    showToast(`Added "${song ? song.title : "song"}"`);
  }catch(err){
    showToast("Error: " + err.message);
  }
}

const THEMES = [
  {id:"jukebox", name:"Neon Jukebox", tag:"Default", colors:["#e8b74e","#3ddad7","#1c1420","#f2e9dc"]},
  {id:"rust", name:"Rust & Rye", tag:"Warm/Americana", colors:["#c9722f","#7fa66b","#1a1512","#f0e6d6"]},
  {id:"cassette", name:"Cassette Blue", tag:"New wave", colors:["#ff5da2","#4fd3ff","#141a2e","#eef1fb"]},
  {id:"contrast", name:"High Contrast", tag:"Max legibility", colors:["#ffe600","#00e5ff","#000000","#ffffff"]}
];

function applyTheme(themeId){
  document.body.dataset.theme = themeId;
  try{ localStorage.setItem("songbook-theme", themeId); }catch(e){}
}

function loadTheme(){
  let saved = "jukebox";
  try{ saved = localStorage.getItem("songbook-theme") || "jukebox"; }catch(e){}
  applyTheme(saved);
}

function renderThemeGrid(){
  const grid = document.getElementById("themeGrid");
  const current = document.body.dataset.theme || "jukebox";
  grid.innerHTML = THEMES.map(t => `
    <button class="theme-option ${t.id===current?"active":""}" data-theme-id="${t.id}">
      <span class="theme-swatch">
        ${t.colors.map(c=>`<span style="background:${c}"></span>`).join("")}
      </span>
      <span>
        <span class="theme-name">${t.name}</span>
        <span class="theme-tag">${t.tag}</span>
      </span>
    </button>
  `).join("");
  grid.querySelectorAll(".theme-option").forEach(btn=>{
    btn.onclick = () => { applyTheme(btn.dataset.themeId); renderThemeGrid(); };
  });
}

const settingsSheet = document.getElementById("settingsSheet");
const settingsBackdrop = document.getElementById("settingsBackdrop");

// Widest span among current Solid-status songs that actually have a
// known low/high note. Songs marked Solid without range data don't move
// the numbers — they just don't count until a range is filled in.
function computeAutoRange(){
  let lowest = null, highest = null, count = 0;
  songs.forEach(s => {
    if(s.status !== "Solid") return;
    const lowS = noteToSemitone(s.low_note);
    const highS = noteToSemitone(s.high_note);
    if(lowS == null || highS == null) return;
    count++;
    if(lowest == null || lowS < lowest.semitone) lowest = {note: s.low_note, semitone: lowS};
    if(highest == null || highS > highest.semitone) highest = {note: s.high_note, semitone: highS};
  });
  if(!lowest || !highest) return null;

  return {
    comfortLow: lowest.note, comfortHigh: highest.note,
    count
  };
}

// Re-scores fit against the in-memory songs list without a network
// round-trip — used after the active range changes (mode switch, auto
// recompute, manual save) so the list re-colors immediately.
function recomputeFitScores(){
  songs = songs.map(s => ({...s, fit_score: fitScore(s.low_note, s.high_note)}));
  render();
}

async function patchProfile(updates){
  const { data: { session } } = await authClient.auth.getSession();
  if(!session) return false;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${session.user.id}`, {
    method: "PATCH",
    headers: {...HEADERS, "Prefer":"return=minimal"},
    body: JSON.stringify({...updates, updated_at: new Date().toISOString()})
  });
  return res.ok;
}

// Renders the toggle + fields for the given mode. Does NOT save anything
// by itself — callers (the toggle button handlers) decide when to persist.
function renderRangeModeUI(mode){
  document.getElementById("rangeModeAutoBtn").classList.toggle("active", mode === "auto");
  document.getElementById("rangeModeManualBtn").classList.toggle("active", mode === "manual");

  const lowEl = document.getElementById("rComfortLow");
  const highEl = document.getElementById("rComfortHigh");
  const summaryEl = document.getElementById("autoRangeSummary");
  const saveBtn = document.getElementById("saveRangeBtn");

  if(mode === "auto"){
    [lowEl, highEl].forEach(el => el.disabled = true);
    saveBtn.style.display = "none";
    summaryEl.style.display = "block";

    const auto = computeAutoRange();
    if(auto){
      lowEl.value = auto.comfortLow;
      highEl.value = auto.comfortHigh;
      summaryEl.textContent = `Based on ${auto.count} Solid song${auto.count===1?"":"s"} with a known range.`;
    }else{
      lowEl.value = ""; highEl.value = "";
      summaryEl.textContent = "Mark a few songs Solid with a known range to calculate this automatically, or switch to Manual.";
    }
  }else{
    [lowEl, highEl].forEach(el => el.disabled = false);
    saveBtn.style.display = "block";
    summaryEl.style.display = "none";
    lowEl.value = COMFORT_LOW || ""; highEl.value = COMFORT_HIGH || "";
  }
}

document.getElementById("settingsBtn").onclick = () => {
  renderThemeGrid();
  document.getElementById("missingResults").innerHTML = "";
  document.getElementById("inviteResult").style.display = "none";
  renderRangeModeUI(currentRangeMode);
  settingsBackdrop.classList.add("open");
  settingsSheet.classList.add("open");
};

document.getElementById("genInviteBtn").onclick = async () => {
  // Strip any query string (e.g. a stray ?u=... from an admin test-account
  // shortcut link) so a real invite always points at the plain app root,
  // never accidentally at someone else's per-person shortcut.
  const appUrl = window.location.origin + window.location.pathname;
  const inviteText = `Hey! I've been using Setlist Sherpa to manage my karaoke songbook — it tracks which songs I actually know, checks them against my real vocal range, and always has a good pick ready. Thought you might like it too.\n\n${appUrl}\n\nJust enter your email — it creates your own private songbook automatically, no password needed.`;

  const outputEl = document.getElementById("inviteOutput");
  const resultEl = document.getElementById("inviteResult");
  outputEl.value = inviteText;
  resultEl.style.display = "block";

  let copied = false;
  try{ await navigator.clipboard.writeText(inviteText); copied = true; }catch(e){ /* fall back to manual copy below */ }
  showToast(copied ? "Invite copied" : "Generated — tap Copy below");
};
document.getElementById("inviteCopyBtn").onclick = () => {
  const outputEl = document.getElementById("inviteOutput");
  outputEl.select();
  try{ document.execCommand("copy"); showToast("Copied"); }catch(e){ showToast("Select the text above and copy it manually"); }
};

function closeSettings(){
  settingsBackdrop.classList.remove("open");
  settingsSheet.classList.remove("open");
}
document.getElementById("btnSettingsClose").onclick = closeSettings;
settingsBackdrop.onclick = closeSettings;

// Admin sheet — only reachable at all if adminBtnWrap was revealed by
// loadProfileRange() (i.e. profiles.is_admin was true for this user), but
// the button click handler is still gated on `isAdmin` as a second check
// since it's cheap insurance against the wrapper ever being shown stale.
const adminBackdrop = document.getElementById("adminBackdrop");
const adminSheet = document.getElementById("adminSheet");
function closeAdmin(){
  adminBackdrop.classList.remove("open");
  adminSheet.classList.remove("open");
}
document.getElementById("adminBtn").onclick = () => {
  if(!isAdmin) return;
  document.getElementById("testEmailResult").style.display = "none";
  document.getElementById("testEmailName").value = "";
  adminBackdrop.classList.add("open");
  adminSheet.classList.add("open");
};
document.getElementById("btnAdminClose").onclick = closeAdmin;
adminBackdrop.onclick = closeAdmin;
enableSwipeToDismiss(adminSheet, closeAdmin);

// Help sheet — plain reference doc, always available, no admin gate.
const helpBackdrop = document.getElementById("helpBackdrop");
const helpSheet = document.getElementById("helpSheet");
function closeHelp(){
  helpBackdrop.classList.remove("open");
  helpSheet.classList.remove("open");
}
document.getElementById("helpBtn").onclick = () => {
  helpBackdrop.classList.add("open");
  helpSheet.classList.add("open");
};
document.getElementById("btnHelpClose").onclick = closeHelp;
helpBackdrop.onclick = closeHelp;
enableSwipeToDismiss(helpSheet, closeHelp);

// First-run quick-start tutorial — a short slide carousel shown once
// automatically after a brand new sign-in (see onSignedIn), and
// replayable anytime from the Help sheet. "Seen" state is a plain
// localStorage flag, same pattern as theme choice: purely a per-device
// UI nicety, no need to sync across devices or live in profiles.
const TUTORIAL_SEEN_KEY = "ss-tutorial-seen";
const TUTORIAL_SLIDES = [
  {
    emoji: "🎤",
    title: "Welcome to Setlist Sherpa",
    body: "Track your karaoke songbook, know what's actually in your vocal range, and always have a great pick ready. This takes about a minute."
  },
  {
    emoji: "📋",
    title: "Add songs, mark your status",
    body: "Add songs from the Songbook tab. Every song gets a status — Solid, Learning, Maybe, Suggested, or Retired. Solid is the one that matters most: it drives everything else."
  },
  {
    emoji: "📏",
    title: "Set your vocal range",
    body: "In Settings, choose Auto (calculated from your Solid songs) or Manual (type your own). Once it's set, every song shows whether it's in range — green means go, red means it's a stretch."
  },
  {
    emoji: "✨",
    title: "Sing Now — your next pick",
    body: "This is the home screen: a short list of Solid songs picked for you, favoring ones you haven't sung in a while. Tap \"Sing it\" to log a performance right from there."
  },
  {
    emoji: "🔎",
    title: "Discover more",
    body: "Recommendations (✨) suggests new songs from artists you're already solid on. Setlists (🎤) let you plan ahead for a specific gig. Both are up top, next to Settings."
  }
];
let tutorialStep = 0;
const tutorialBackdrop = document.getElementById("tutorialBackdrop");
const tutorialSheet = document.getElementById("tutorialSheet");

function renderTutorialSlide(){
  const slide = TUTORIAL_SLIDES[tutorialStep];
  document.getElementById("tutorialSlideBody").innerHTML = `
    <div class="tutorial-slide-emoji">${slide.emoji}</div>
    <h3>${slide.title}</h3>
    <p>${slide.body}</p>
  `;
  document.getElementById("tutorialDots").innerHTML = TUTORIAL_SLIDES
    .map((_, i) => `<div class="tutorial-dot${i === tutorialStep ? " active" : ""}"></div>`)
    .join("");
  const backBtn = document.getElementById("tutorialBackBtn");
  const nextBtn = document.getElementById("tutorialNextBtn");
  backBtn.style.visibility = tutorialStep === 0 ? "hidden" : "visible";
  nextBtn.textContent = tutorialStep === TUTORIAL_SLIDES.length - 1 ? "Let's go!" : "Next";
}

function openTutorial(){
  tutorialStep = 0;
  renderTutorialSlide();
  tutorialBackdrop.classList.add("open");
  tutorialSheet.classList.add("open");
}
function closeTutorial(){
  tutorialBackdrop.classList.remove("open");
  tutorialSheet.classList.remove("open");
  try{ localStorage.setItem(TUTORIAL_SEEN_KEY, "1"); }catch(e){}
}
document.getElementById("tutorialSkipBtn").onclick = closeTutorial;
document.getElementById("tutorialBackBtn").onclick = () => {
  if(tutorialStep === 0) return;
  tutorialStep--;
  renderTutorialSlide();
};
document.getElementById("tutorialNextBtn").onclick = () => {
  if(tutorialStep === TUTORIAL_SLIDES.length - 1){
    closeTutorial();
    return;
  }
  tutorialStep++;
  renderTutorialSlide();
};
document.getElementById("replayTutorialBtn").onclick = () => {
  closeHelp();
  openTutorial();
};

document.getElementById("genTestEmailBtn").onclick = async () => {
  if(!currentUserEmail || !currentUserEmail.includes("@")){
    showToast("No signed-in email found");
    return;
  }
  const nameEl = document.getElementById("testEmailName");
  // Slug the entered name down to something safe for an email local-part:
  // lowercase, alphanumeric only, spaces/punctuation collapsed to hyphens.
  const slug = nameEl.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if(!slug){
    showToast("Enter a name for the +tag first");
    nameEl.focus();
    return;
  }

  const [local, domain] = currentUserEmail.split("@");
  // Gmail (and most modern providers) ignore anything after a "+" in the
  // local part for delivery purposes but treat the full address as
  // distinct for account purposes — so mail keeps landing in the same
  // inbox while Supabase Auth sees a brand new user.
  const testEmail = `${local}+${slug}@${domain}`;

  const outputEl = document.getElementById("testEmailOutput");
  const resultEl = document.getElementById("testEmailResult");
  outputEl.value = testEmail;
  resultEl.style.display = "block";

  const btn = document.getElementById("genTestEmailBtn");
  btn.disabled = true;
  btn.textContent = "Sending…";

  // Fire the same sign-in call the real login form uses, so the magic
  // link / OTP code actually lands in the inbox for this test address.
  const { error } = await authClient.auth.signInWithOtp({
    email: testEmail,
    options: { emailRedirectTo: window.location.origin + window.location.pathname }
  });

  btn.disabled = false;
  btn.textContent = "Generate & send login email";

  if(error){
    showToast(`Send failed: ${error.message}`);
    return;
  }

  let copied = false;
  try{ await navigator.clipboard.writeText(testEmail); copied = true; }catch(e){ /* fall back to manual copy below */ }
  showToast(copied ? "Login email sent — address copied" : "Login email sent — tap Copy below");
};
document.getElementById("testEmailCopyBtn").onclick = () => {
  const outputEl = document.getElementById("testEmailOutput");
  outputEl.select();
  try{ document.execCommand("copy"); showToast("Copied"); }catch(e){ showToast("Select the text above and copy it manually"); }
};

document.getElementById("rangeModeAutoBtn").onclick = async () => {
  currentRangeMode = "auto";
  renderRangeModeUI("auto");
  const auto = computeAutoRange();
  const ok = await patchProfile({
    range_mode: "auto",
    ...(auto ? {
      comfort_low: auto.comfortLow, comfort_high: auto.comfortHigh
    } : {})
  });
  if(ok && auto){
    applyRange(auto.comfortLow, auto.comfortHigh);
    recomputeFitScores();
  }
  showToast(ok ? "Switched to auto range" : "Saved locally — couldn't reach the server");
};

document.getElementById("rangeModeManualBtn").onclick = async () => {
  currentRangeMode = "manual";

  // Restore the last manual range if we have one saved; otherwise leave
  // whatever's currently active (e.g. first time ever switching to manual).
  const patch = { range_mode: "manual" };
  if(manualComfortLow && manualComfortHigh){
    patch.comfort_low = manualComfortLow;
    patch.comfort_high = manualComfortHigh;
    // Apply immediately (before the network round-trip) so the Settings
    // fields and range bars reflect the restored range right away, not
    // whatever auto last computed.
    applyRange(patch.comfort_low, patch.comfort_high);
    recomputeFitScores();
  }
  renderRangeModeUI("manual");

  const ok = await patchProfile(patch);
  showToast(ok
    ? (patch.comfort_low ? "Restored your manual range" : "Switched to manual range")
    : "Saved locally — couldn't reach the server");
};

document.getElementById("saveRangeBtn").onclick = async () => {
  const newComfortLow = document.getElementById("rComfortLow").value.trim();
  const newComfortHigh = document.getElementById("rComfortHigh").value.trim();

  if(noteToSemitone(newComfortLow) == null || noteToSemitone(newComfortHigh) == null){
    showToast("Notes need to look like A2, C#4, etc.");
    return;
  }

  const ok = await patchProfile({
    comfort_low: newComfortLow,
    comfort_high: newComfortHigh,
    range_mode: "manual",
    manual_comfort_low: newComfortLow,
    manual_comfort_high: newComfortHigh
  });
  if(ok){
    manualComfortLow = newComfortLow; manualComfortHigh = newComfortHigh;
    applyRange(newComfortLow, newComfortHigh);
    recomputeFitScores();
    showToast("Range saved");
  }else{
    showToast("Couldn't save range — try again");
  }
};

document.getElementById("signOutBtn").onclick = async () => {
  if(!confirm("Sign out?")) return;
  await authClient.auth.signOut();
  window.location.reload();
};

document.getElementById("exportDataBtn").onclick = async () => {
  const btn = document.getElementById("exportDataBtn");
  const originalText = btn.textContent;
  btn.textContent = "Exporting…";
  btn.disabled = true;
  try{
    const [songsRes, perfRes, rangesRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/songs?select=*`, {headers: HEADERS}),
      fetch(`${SUPABASE_URL}/rest/v1/performances?select=*`, {headers: HEADERS}),
      fetch(`${SUPABASE_URL}/rest/v1/song_ranges?select=*`, {headers: HEADERS})
    ]);
    if(!songsRes.ok || !perfRes.ok || !rangesRes.ok) throw new Error("One or more tables failed to export");
    const [songsData, perfData, rangesData] = await Promise.all([songsRes.json(), perfRes.json(), rangesRes.json()]);

    const exportPayload = {
      exported_at: new Date().toISOString(),
      source: "kiplingm/setlist-sherpa",
      songs: songsData,
      performances: perfData,
      song_ranges: rangesData
    };
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `songbook-backup-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast(`Backup downloaded (${songsData.length} songs, ${perfData.length} performances)`);
  }catch(err){
    showToast("Export failed: " + err.message);
  }finally{
    btn.textContent = originalText;
    btn.disabled = false;
  }
};

document.getElementById("checkOutOfRangeBtn").onclick = () => {
  const btn = document.getElementById("checkOutOfRangeBtn");
  const resultsEl = document.getElementById("outOfRangeResults");

  const outOfRange = songs
    .map(s=>{
      const lowS = noteToSemitone(s.low_note), highS = noteToSemitone(s.high_note);
      return {...s, fit: fitLabel(lowS, highS), lowS, highS};
    })
    .filter(s => s.fit.cls === "fit-out")
    .sort((a,b) => (a.artist||"").localeCompare(b.artist||""));

  if(outOfRange.length === 0){
    resultsEl.innerHTML = `<div class="missing-none">✓ No songs are out of range</div>`;
    return;
  }

  resultsEl.innerHTML = `
    <div class="missing-summary">${outOfRange.length} song${outOfRange.length===1?"":"s"} out of range:</div>
    ${outOfRange.map(s => `
      <div class="missing-item" data-id="${s.id}">
        <div class="mi-title">${escapeHtml(s.title)}</div>
        <div class="mi-artist">${escapeHtml(s.artist)} · ${escapeHtml(s.low_note)}–${escapeHtml(s.high_note)}</div>
        <div class="rec-transpose">${escapeHtml(transpositionMessage(s.lowS, s.highS))}</div>
      </div>
    `).join("")}
    <div class="missing-hint">Tap a song to edit it, transpose your key notes, or change its status.</div>
  `;
  resultsEl.querySelectorAll(".missing-item").forEach(el => {
    el.onclick = () => {
      closeSettings();
      openEdit(el.dataset.id);
    };
  });
};

document.getElementById("checkMissingBtn").onclick = async () => {
  const btn = document.getElementById("checkMissingBtn");
  const resultsEl = document.getElementById("missingResults");
  btn.textContent = "Checking…";
  btn.disabled = true;

  try{
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/songs?select=id,title,artist&or=(low_note.is.null,high_note.is.null)&order=artist.asc`,
      {headers: HEADERS}
    );
    if(!res.ok) throw new Error("Lookup failed");
    const missing = await res.json();

    if(missing.length === 0){
      resultsEl.innerHTML = `<div class="missing-none">✓ Every song has range data</div>`;
    }else{
      resultsEl.innerHTML = `
        <div class="missing-summary">${missing.length} song${missing.length===1?"":"s"} missing range data:</div>
        ${missing.map(s => `
          <div class="missing-item" data-id="${s.id}">
            <div class="mi-title">${escapeHtml(s.title)}</div>
            <div class="mi-artist">${escapeHtml(s.artist)}</div>
          </div>
        `).join("")}
        <div class="missing-hint">Tap a song to edit it directly, or use the button below to hand this list to Claude in chat.</div>
        <button class="ask-claude-btn" id="askClaudeMissingBtn">Ask Claude to fill these in</button>
        <div id="askClaudeBox" style="display:none;"></div>
      `;
      resultsEl.querySelectorAll(".missing-item").forEach(el => {
        el.onclick = () => {
          closeSettings();
          openEdit(el.dataset.id);
        };
      });
      document.getElementById("askClaudeMissingBtn").onclick = () => {
        const prompt = buildRangePrompt(missing);
        askClaude(prompt, document.getElementById("askClaudeBox"));
      };
    }
  }catch(err){
    resultsEl.innerHTML = `<div class="missing-summary">Error checking: ${err.message}</div>`;
  }finally{
    btn.textContent = "Check for missing range data";
    btn.disabled = false;
  }
};

// --- Swipe-to-dismiss for sheets (drag from the handle zone at the top) ---
function enableSwipeToDismiss(sheetEl, closeFn){
  if(!sheetEl) return;
  const HANDLE_ZONE = 30; // px from the top of the sheet where a drag can start
  let startY = null, currentY = null, dragging = false;

  sheetEl.addEventListener("touchstart", (e) => {
    const rect = sheetEl.getBoundingClientRect();
    const touchY = e.touches[0].clientY;
    if(touchY - rect.top > HANDLE_ZONE) return; // only start a drag from the handle area
    startY = touchY;
    currentY = touchY;
    dragging = true;
    sheetEl.classList.add("dragging");
  }, {passive: true});

  sheetEl.addEventListener("touchmove", (e) => {
    if(!dragging) return;
    currentY = e.touches[0].clientY;
    const delta = Math.max(0, currentY - startY);
    sheetEl.style.transform = `translateY(${delta}px)`;
  }, {passive: true});

  const endDrag = () => {
    if(!dragging) return;
    dragging = false;
    sheetEl.classList.remove("dragging");
    const delta = currentY !== null ? Math.max(0, currentY - startY) : 0;
    sheetEl.style.transform = "";
    if(delta > 90) closeFn();
    startY = null; currentY = null;
  };
  sheetEl.addEventListener("touchend", endDrag);
  sheetEl.addEventListener("touchcancel", endDrag);
}

enableSwipeToDismiss(document.getElementById("sheet"), closeSheet);
enableSwipeToDismiss(document.getElementById("logSheet"), closeLog);
enableSwipeToDismiss(document.getElementById("recSheet"), closeRecommendations);
enableSwipeToDismiss(document.getElementById("settingsSheet"), closeSettings);

// --- Auth gate ---------------------------------------------------------
// Nothing below runs until a session exists. On first load we check for
// an existing session (e.g. from a previous visit); if there isn't one,
// the login sheet (baked into index.html as always-open) stays visible
// and blocks interaction with the rest of the app, which is still mid-
// skeleton-load underneath it. onAuthStateChange fires once the magic
// link redirect completes and Supabase picks up the session from the URL.

const authBackdrop = document.getElementById("authBackdrop");
const authSheet = document.getElementById("authSheet");
let signedIn = false;
let currentUserEmail = null;
let isAdmin = false;

async function onSignedIn(session){
  if(signedIn) return; // guard against double-init if the auth event fires twice
  signedIn = true;

  HEADERS.Authorization = "Bearer " + session.access_token;
  authBackdrop.classList.remove("open");
  authSheet.classList.remove("open");

  const emailEl = document.getElementById("accountEmail");
  if(emailEl) emailEl.textContent = session.user.email;
  currentUserEmail = session.user.email;

  await loadProfileRange(session.user.id);

  loadTheme();
  await fetchSongs();

  // Auto mode needs the songs list loaded first (computeAutoRange reads
  // from it), so this has to happen after fetchSongs() resolves, not
  // inside loadProfileRange() above.
  if(currentRangeMode === "auto"){
    const auto = computeAutoRange();
    if(auto){
      applyRange(auto.comfortLow, auto.comfortHigh);
      recomputeFitScores();
      patchProfile({
        comfort_low: auto.comfortLow, comfort_high: auto.comfortHigh
      });
    }
  }

  let tutorialSeen = false;
  try{ tutorialSeen = localStorage.getItem(TUTORIAL_SEEN_KEY) === "1"; }catch(e){}
  if(!tutorialSeen) openTutorial();
}

async function loadProfileRange(userId){
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=*`, {headers: HEADERS});
    if(!res.ok) throw new Error("Profile lookup failed");
    const rows = await res.json();
    let profile = rows[0];

    if(!profile){
      // First time this user has signed in anywhere — create a starting
      // profile row. Defaults to auto mode (based on Solid songs), same
      // default as the other karaoke-app project shares.
      const createRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
        method: "POST",
        headers: {...HEADERS, "Prefer":"return=representation"},
        body: JSON.stringify({ id: userId, range_mode: "auto" })
      });
      if(createRes.ok){
        const created = await createRes.json();
        profile = created[0];
      }
    }

    if(!profile) return;

    isAdmin = !!profile.is_admin;
    document.getElementById("adminBtnWrap").style.display = isAdmin ? "" : "none";

    currentRangeMode = profile.range_mode === "auto" ? "auto" : "manual";

    manualComfortLow = profile.manual_comfort_low || null;
    manualComfortHigh = profile.manual_comfort_high || null;

    if(profile.comfort_low && profile.comfort_high){
      applyRange(profile.comfort_low, profile.comfort_high);
    }
    // If comfort_low/high are still null (brand new profile, or auto mode
    // that hasn't computed anything yet), COMFORT_LOW/HIGH stay null and
    // the UI shows "not calculated yet" throughout — no fake default
    // range. Auto mode gets a real chance to compute one in onSignedIn()
    // once songs are loaded; manual mode just waits for the user to set
    // something in Settings.
  }catch(e){
    console.error("Failed to load profile range, using defaults", e);
  }
}

async function sendLoginEmail(email){
  const errEl = document.getElementById("authError");
  errEl.style.display = "none";

  const btn = document.getElementById("authSendBtn");
  btn.disabled = true;
  btn.textContent = "Sending…";

  const { error } = await authClient.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin + window.location.pathname }
  });

  btn.disabled = false;
  btn.textContent = "Continue";

  if(error){
    errEl.textContent = error.message;
    errEl.style.display = "block";
    return false;
  }

  // Remember the un-tagged root address so future "?u=name" shortcut links
  // know which inbox/domain to build test-account addresses against —
  // only the bare address counts, not a "+tag" one, so re-visiting a
  // shortcut doesn't overwrite the real root email.
  if(!email.includes("+")){
    try{ localStorage.setItem("ss_base_email", email); }catch(e){ /* ignore */ }
  }

  lastAuthEmail = email;
  document.getElementById("authFormView").style.display = "none";
  document.getElementById("authSentView").style.display = "block";
  document.getElementById("authCode").value = "";
  document.getElementById("authCodeError").style.display = "none";
  return true;
}

document.getElementById("authSendBtn").onclick = async () => {
  const email = document.getElementById("authEmail").value.trim();
  if(!email) return;
  await sendLoginEmail(email);
};

// Fallback for the case where tapping the emailed link doesn't land in the
// same browser/Home-Screen-icon instance that requested it (a known iOS
// quirk: taps always open regular Safari, not a specific standalone web
// app instance). Supabase's default OTP email includes a 6-digit code
// alongside the link — verifying it directly here sidesteps the redirect
// entirely and completes sign-in in whichever instance you're actually in.
document.getElementById("authVerifyCodeBtn").onclick = async () => {
  const code = document.getElementById("authCode").value.trim();
  const codeErrEl = document.getElementById("authCodeError");
  codeErrEl.style.display = "none";
  if(!code || !lastAuthEmail) return;

  const btn = document.getElementById("authVerifyCodeBtn");
  btn.disabled = true;
  btn.textContent = "Verifying…";

  const { error } = await authClient.auth.verifyOtp({
    email: lastAuthEmail,
    token: code,
    type: "email"
  });

  btn.disabled = false;
  btn.textContent = "Verify code";

  if(error){
    codeErrEl.textContent = error.message;
    codeErrEl.style.display = "block";
  }
  // On success, onAuthStateChange (registered below) picks up the new
  // session and calls onSignedIn() automatically — no extra handling needed.
};

document.getElementById("authUseDifferentBtn").onclick = () => {
  lastAuthEmail = null;
  document.getElementById("authFormView").style.display = "block";
  document.getElementById("authSentView").style.display = "none";
};

(async function initAuthGate(){
  // A "?new=1" link (e.g. https://.../?new=1) always lands on the sign-in
  // sheet, even on a device that's already signed in — useful for handing
  // someone else your URL to create their own account without it just
  // resuming your session. Strip the param right after so a page refresh
  // doesn't keep forcing a sign-out.
  const params = new URLSearchParams(window.location.search);

  authClient.auth.onAuthStateChange((_event, newSession) => {
    if(newSession && !signedIn){
      onSignedIn(newSession);
    }
  });

  if(params.get("new") === "1"){
    await authClient.auth.signOut();
    params.delete("new");
    const cleanUrl = window.location.pathname + (params.toString() ? "?" + params.toString() : "");
    window.history.replaceState({}, "", cleanUrl);
  }

  // A "?u=name" link is a per-person shortcut — e.g. a Home Screen icon
  // pointing at "?u=bob" always signs out of whatever's currently active
  // and auto-sends a login email to "you+bob@yourdomain", using the root
  // address remembered from the last time you signed in with your real
  // (un-tagged) email. Left in the URL (not stripped) so the same icon
  // works identically every time it's tapped.
  const uName = params.get("u");
  if(uName){
    await authClient.auth.signOut();
    let base = null;
    try{ base = localStorage.getItem("ss_base_email"); }catch(e){ /* ignore */ }
    authBackdrop.classList.add("open");
    authSheet.classList.add("open");
    if(base && base.includes("@")){
      const [local, domain] = base.split("@");
      const slug = uName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const targetEmail = slug ? `${local}+${slug}@${domain}` : base;
      document.getElementById("authEmail").value = targetEmail;
      await sendLoginEmail(targetEmail);
    }else{
      showToast("Sign in with your real email once, then shortcut links will work");
    }
    return;
  }

  const { data: { session } } = await authClient.auth.getSession();
  if(session){
    onSignedIn(session);
  }else{
    authBackdrop.classList.add("open");
    authSheet.classList.add("open");
  }
})();
