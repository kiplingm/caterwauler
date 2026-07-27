// Bumped manually with each deploy — there's no build pipeline here, just
// static files served by GitHub Pages, so this is a simple manual marker
// to confirm which version is actually live (useful given Pages/browser
// caching can lag behind a push by a minute or two).
const BUILD_VERSION = "2";
const BUILD_DATE = "2026-07-27";

const buildInfoEl = document.getElementById("buildInfo");
if(buildInfoEl){
  const formattedDate = new Date(BUILD_DATE + "T00:00:00").toLocaleDateString(undefined, {
    year: "numeric", month: "long", day: "numeric"
  });
  buildInfoEl.textContent = `Build ${BUILD_VERSION} — ${formattedDate}`;
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

// Vocal range — now loaded per-user from the `profiles` table after
// sign-in (see loadProfileRange()) instead of hardcoded. These start as
// reasonable fallback defaults and get reassigned via applyRange() once
// the profile loads or the user saves a new range in Settings.
let COMFORT_LOW = "A2", COMFORT_HIGH = "B4";
let STRETCH_LOW = "G2", STRETCH_HIGH = "D5";

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
let stretchLowS = noteToSemitone(STRETCH_LOW);
let stretchHighS = noteToSemitone(STRETCH_HIGH);

function updateRangeLineDisplay(){
  const el = document.getElementById("rangeLine");
  if(el){
    el.textContent =
      `YOUR RANGE — COMFORT ${COMFORT_LOW}–${COMFORT_HIGH} · STRETCH ${STRETCH_LOW}–${STRETCH_HIGH}`;
  }
}
updateRangeLineDisplay();

// Called after the profile loads post-sign-in, and after saving a new
// range in Settings. Recomputes the derived semitone values and refreshes
// both the header display and (via fetchSongs, called by the caller) fit
// scoring across the songbook.
function applyRange(comfortLow, comfortHigh, stretchLow, stretchHigh){
  COMFORT_LOW = comfortLow; COMFORT_HIGH = comfortHigh;
  STRETCH_LOW = stretchLow; STRETCH_HIGH = stretchHigh;
  comfortLowS = noteToSemitone(COMFORT_LOW);
  comfortHighS = noteToSemitone(COMFORT_HIGH);
  stretchLowS = noteToSemitone(STRETCH_LOW);
  stretchHighS = noteToSemitone(STRETCH_HIGH);
  updateRangeLineDisplay();
}


let songs = [];
let activeFilter = "All";
let searchTerm = "";
let sortMode = "fit";
let editingStatusId = null;
const STATUS_OPTIONS = ["Solid","Learning","Maybe","Suggested","Retired"];
const STATUS_ICONS = {Solid:"✓", Learning:"◐", Maybe:"?", Suggested:"★", Retired:"✕"};

document.getElementById("sortSelect").addEventListener("change", e=>{
  sortMode = e.target.value;
  render();
});

const listEl = document.getElementById("list");
const countRow = document.getElementById("countRow");
const chipsEl = document.getElementById("chips");
const FILTERS = ["All","Solid","Learning","Maybe","Suggested","Retired"];

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
  return `Please research the vocal range (low and high note, e.g. "A2") for these songs from my karaoke tracker, then update them in my Supabase project (karaoke-prod, ref luykkuptcizkdigwness), table "songs", columns low_note/high_note, matched by each song's row id (not by title/artist alone — the table has other users' songs in it too):\n\n${list}\n\nFor context: my comfort range is ${COMFORT_LOW}–${COMFORT_HIGH} and my full stretch range is ${STRETCH_LOW}–${STRETCH_HIGH}.`;
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
  if(lowS===null || highS===null) return {cls:"fit-unknown", text:"○ RANGE NOT SET"};
  if(lowS >= comfortLowS && highS <= comfortHighS) return {cls:"fit-easy", text:"✓ EASY FIT"};
  if(lowS >= stretchLowS && highS <= stretchHighS) return {cls:"fit-stretch", text:"△ STRETCH"};
  return {cls:"fit-out", text:"✕ OUT OF RANGE"};
}

// Lower score = better fit against comfort zone. Unknown ranges sort last.
function fitScore(low, high){
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
// the comfort zone (or failing that, the stretch zone).
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
  const stretchSpan = stretchHighS - stretchLowS;
  if(songSpan <= stretchSpan){
    const minShift = stretchLowS - lowS;
    const maxShift = stretchHighS - highS;
    const shift = Math.round((minShift + maxShift) / 2);
    return {shift, zone: "stretch"};
  }
  return {shift: 0, zone: "none"};
}

function transpositionMessage(lowS, highS){
  const suggestion = suggestTransposition(lowS, highS);
  if(!suggestion) return "";
  const {shift, zone} = suggestion;
  if(zone === "none"){
    return "Spans more than your full range — no single key change fixes this one.";
  }
  const dir = shift > 0 ? "up" : shift < 0 ? "down" : null;
  const zoneLabel = zone === "comfort" ? "an easy fit" : "your stretch range";
  if(!dir){
    return `Already centered — this is as good as it gets in ${zoneLabel}.`;
  }
  const newLow = semitoneToNoteName(lowS + shift);
  const newHigh = semitoneToNoteName(highS + shift);
  return `Try shifting ${dir} ${Math.abs(shift)} semitone${Math.abs(shift)===1?"":"s"} (${newLow}–${newHigh}) for ${zoneLabel}.`;
}

function renderRangeStrip(low, high, rangeSource){
  const lowS = noteToSemitone(low), highS = noteToSemitone(high);
  const spanLow = stretchLowS - 2, spanHigh = stretchHighS + 2;
  const span = spanHigh - spanLow;
  const pct = v => Math.max(0, Math.min(100, ((v - spanLow)/span)*100));

  const comfortLeft = pct(comfortLowS), comfortRight = pct(comfortHighS);
  let songBar = "";
  if(lowS!==null && highS!==null){
    const l = pct(lowS), r = pct(highS);
    const width = Math.max(r-l, 2.5);
    songBar = `<div class="range-song" style="left:${l}%; width:${width}%;"></div>`;
  }
  const fit = fitLabel(lowS, highS);
  const suggestionHtml = fit.cls === "fit-out"
    ? `<span class="transpose-suggestion">${transpositionMessage(lowS, highS)}</span>`
    : "";
  const sourceTag = (lowS!==null && highS!==null && rangeSource === "estimated")
    ? `<span class="range-source-tag" title="Filled in as a best-guess estimate, not individually verified">est.</span>`
    : (lowS!==null && highS!==null && rangeSource === "verified")
    ? `<span class="range-source-tag range-source-verified" title="Checked against a specific vocal reference">✓ verified</span>`
    : "";
  return `
    <div class="range-strip">
      <div class="range-track">
        <div class="range-comfort" style="left:${comfortLeft}%; width:${comfortRight-comfortLeft}%;"></div>
        ${songBar}
      </div>
      <div class="range-labels"><span>${STRETCH_LOW}</span><span>${STRETCH_HIGH}</span></div>
      <div class="range-fit ${fit.cls}">${fit.text}${lowS!==null&&highS!==null ? ` · ${low}–${high}` : ""}${sourceTag}${suggestionHtml}</div>
    </div>`;
}

function render(){
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
    // fit: best range match first, tie-broken by title
    if(a.fit_score !== b.fit_score) return a.fit_score - b.fit_score;
    return (a.title||"").localeCompare(b.title||"");
  });

  countRow.textContent = `${filtered.length} of ${songs.length} songs`;

  if(filtered.length===0){
    listEl.innerHTML = `<div class="empty">No songs match. Try a different search or filter — or add one with the + button.</div>`;
    return;
  }

  listEl.innerHTML = filtered.map(s => `
    <div class="card" data-id="${s.id}">
      <div class="card-top">
        <div>
          <div class="title">${escapeHtml(s.title)}</div>
          <div class="artist">${escapeHtml(s.artist)}</div>
        </div>
        ${editingStatusId === s.id ? `
          <select class="status-edit-select" data-id="${s.id}">
            ${STATUS_OPTIONS.map(opt => `<option value="${opt}" ${opt===s.status?"selected":""}>${opt}</option>`).join("")}
          </select>
        ` : `
          <div class="status-pill status-${s.status}" data-id="${s.id}"><span class="status-icon">${STATUS_ICONS[s.status]||""}</span> ${s.status}</div>
        `}
      </div>
      ${renderRangeStrip(s.low_note, s.high_note, s.range_source)}
      <div class="card-meta">
        ${s.genre ? `<span>${escapeHtml(s.genre)}</span>` : ""}
        ${s.last_played ? `<span>Last played ${formatDate(s.last_played)}</span>` : ""}
        ${s.key_notes ? `<span>${escapeHtml(s.key_notes)}</span>` : ""}
      </div>
      <a class="spotify-link" href="https://open.spotify.com/search/${encodeURIComponent(s.title + ' ' + s.artist)}" target="_blank" rel="noopener">
        ♪ Find on Spotify
      </a>
      <div class="card-actions">
        <button class="logBtn primary" data-id="${s.id}">Performances</button>
        <button class="editBtn" data-id="${s.id}">Edit</button>
        <button class="delBtn danger" data-id="${s.id}">Delete</button>
      </div>
    </div>
  `).join("");

  document.querySelectorAll(".status-pill").forEach(el=>{
    el.onclick = () => { editingStatusId = el.dataset.id; render(); };
  });
  document.querySelectorAll(".status-edit-select").forEach(sel=>{
    sel.onchange = () => updateStatus(sel.dataset.id, sel.value);
    sel.onblur = () => { editingStatusId = null; render(); };
    setTimeout(()=>sel.focus(), 0);
  });
  document.querySelectorAll(".logBtn").forEach(b=>b.onclick = ()=>openLog(b.dataset.id));
  document.querySelectorAll(".editBtn").forEach(b=>b.onclick = ()=>openEdit(b.dataset.id));
  document.querySelectorAll(".delBtn").forEach(b=>b.onclick = ()=>deleteSong(b.dataset.id));
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

function mapsDirectionsUrl(venue){
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(venue)}`;
}

// --- Sheet (add/edit) ---
const sheet = document.getElementById("sheet");
const backdrop = document.getElementById("backdrop");

function openSheet(){ backdrop.classList.add("open"); sheet.classList.add("open"); }
function closeSheet(){ backdrop.classList.remove("open"); sheet.classList.remove("open"); }

document.getElementById("fabAdd").onclick = ()=>{
  document.getElementById("sheetTitle").textContent = "Add song";
  document.getElementById("editId").value = "";
  ["fTitle","fArtist","fLow","fHigh","fGenre","fKeyNotes"].forEach(id=>document.getElementById(id).value="");
  document.getElementById("fStatus").value = "Maybe";
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
  if(!confirm("Delete this song?")) return;
  closeSheet();
  await deleteSong(id, {skipConfirm:true});
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
    range_source: "manual",
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
    if(!confirm(warning)) return;
  }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/songs?id=eq.${id}`, {method:"DELETE", headers: HEADERS});
    if(!res.ok) throw new Error("Delete failed");
    showToast("Song removed");
    const cardEl = document.querySelector(`.card[data-id="${id}"]`);
    if(cardEl) await animateRemove(cardEl);
    fetchSongs();
  }catch(err){
    showToast("Error: " + err.message);
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

async function queryPhoton(q, useBias){
  const bias = useBias ? `&lat=47.2529&lon=-122.4443` : "";
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

async function queryNominatim(q){
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&limit=6&viewbox=-122.62,47.34,-122.34,47.14&bounded=0`;
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
  let results = [];
  try{ results = await queryPhoton(q, true); }catch(e){}
  if(results.length === 0){
    try{ results = await queryPhoton(q, false); }catch(e){}
  }
  // If a multi-word query with a leading word (e.g. an informal nickname like "Jim's")
  // comes up empty, retry against just the trailing words.
  const words = q.split(/\s+/);
  if(results.length === 0 && words.length > 1){
    try{ results = await queryPhoton(words.slice(1).join(" "), false); }catch(e){}
  }
  if(results.length === 0){
    try{ results = await queryNominatim(q); }catch(e){}
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
  if(list.innerHTML.trim()) list.classList.add("open");
});

// --- Catalog autocomplete (searches your 84k-song karafun_catalog table) ---
let acDebounce = null;

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
      });
    }, 250);
  });

  input.addEventListener("blur", () => {
    // Delay so a click on a suggestion registers before the list closes
    setTimeout(() => list.classList.remove("open"), 150);
  });
  input.addEventListener("focus", () => {
    if(list.innerHTML.trim()) list.classList.add("open");
  });
}

wireAutocomplete("fTitle", "titleSuggestions");
wireAutocomplete("fArtist", "artistSuggestions");
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

async function openRecommendations(){
  recBackdrop.classList.add("open");
  recSheet.classList.add("open");
  const listEl = document.getElementById("recList");
  listEl.innerHTML = `<div class="rec-loading">Finding matches and checking vocal range…</div>`;

  const solidSongs = songs.filter(s => s.status === "Solid");
  if(solidSongs.length === 0){
    listEl.innerHTML = `<div class="rec-empty">Mark a few songs "Solid" first — recommendations are built from what's already working for you.</div>`;
    return;
  }

  // Weight artists by how many Solid songs you have from them; check the heaviest hitters first.
  const artistCounts = {};
  solidSongs.forEach(s=>{
    const a = (s.artist || "").trim();
    if(a) artistCounts[a] = (artistCounts[a] || 0) + 1;
  });
  const artists = Object.keys(artistCounts).sort((a, b) => artistCounts[b] - artistCounts[a]);
  const known = new Set(songs.map(s => `${(s.title||"").toLowerCase()}|${(s.artist||"").toLowerCase()}`));

  try{
    const candidates = [];
    const seenKeys = new Set();
    const perArtistCount = {};
    const CHUNK_SIZE = 8; // keeps the OR-query URL reasonably short

    for(let i = 0; i < artists.length && candidates.length < 60; i += CHUNK_SIZE){
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
            const matchedArtist = batchable.find(a => (r.artist||"").toLowerCase().includes(a.toLowerCase()));
            if(!matchedArtist) return;
            const key = `${(r.title||"").toLowerCase()}|${(r.artist||"").toLowerCase()}`;
            if(known.has(key) || seenKeys.has(key)) return;
            if((perArtistCount[matchedArtist]||0) >= 10) return; // cap per artist, same as before
            perArtistCount[matchedArtist] = (perArtistCount[matchedArtist]||0) + 1;
            seenKeys.add(key);
            candidates.push({...r, sourceArtist: matchedArtist});
          });
        }
      }

      for(const artist of skipped){
        if(candidates.length >= 60) break;
        const term = `*${artist}*`;
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/karafun_catalog?select=title,artist&artist=ilike.${encodeURIComponent(term)}&limit=10&order=title.asc`,
          {headers: HEADERS}
        );
        if(!res.ok) continue;
        const rows = await res.json();
        rows.forEach(r=>{
          const key = `${(r.title||"").toLowerCase()}|${(r.artist||"").toLowerCase()}`;
          if(known.has(key) || seenKeys.has(key)) return;
          seenKeys.add(key);
          candidates.push({...r, sourceArtist: artist});
        });
      }
    }

    // Gate every candidate on vocal range before it's shown for consideration.
    const rangeMap = await fetchSongRanges();
    const fitResults = [];
    const stretchResults = [];
    let unconfirmedCount = 0;
    candidates.forEach(c=>{
      const rangeRow = rangeMap.get(`${normalizeForMatch(c.title)}|${normalizeForMatch(c.artist)}`);
      if(!rangeRow){ unconfirmedCount++; return; }
      const lowS = noteToSemitone(rangeRow.low_note), highS = noteToSemitone(rangeRow.high_note);
      const fit = fitLabel(lowS, highS);
      const enriched = {...c, low_note: rangeRow.low_note, high_note: rangeRow.high_note, fit};
      if(fit.cls === "fit-easy" || fit.cls === "fit-stretch"){
        fitResults.push(enriched);
      }else if(fit.cls === "fit-out"){
        enriched.transposeMsg = transpositionMessage(lowS, highS);
        stretchResults.push(enriched);
      }
      // fit-unknown (no range data) is the only case excluded from consideration.
    });
    fitResults.sort((a,b)=> (a.fit.cls === b.fit.cls) ? 0 : (a.fit.cls === "fit-easy" ? -1 : 1));

    renderRecommendations(fitResults, stretchResults, unconfirmedCount);
  }catch(err){
    listEl.innerHTML = `<div class="rec-empty">Couldn't load recommendations: ${err.message}</div>`;
  }
}

function renderRecommendations(results, outOfRangeResults, unconfirmedCount){
  const listEl = document.getElementById("recList");
  const unconfirmedNote = unconfirmedCount > 0
    ? `<div class="rec-unconfirmed-note">${unconfirmedCount} more song${unconfirmedCount===1?"":"s"} matched by artist but ${unconfirmedCount===1?"hasn't":"haven't"} had its vocal range checked yet, so ${unconfirmedCount===1?"it's":"they're"} left out of consideration. Ask Claude in chat to research ranges for your Solid artists to expand this list.</div>`
    : "";

  if(results.length === 0 && outOfRangeResults.length === 0){
    listEl.innerHTML = `<div class="rec-empty">No range-confirmed matches right now.</div>${unconfirmedNote}`;
    return;
  }

  const renderItem = (r, i, group) => `
    <div class="rec-item">
      <div class="rec-item-info">
        <div class="rec-item-title">${escapeHtml(r.title)}</div>
        <div class="rec-item-artist">${escapeHtml(r.artist)}</div>
        <div class="rec-item-source">
          Because you're solid on ${escapeHtml(r.sourceArtist)} ·
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
    b.onclick = () => animateRemove(b.closest(".rec-item"));
  });
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

document.getElementById("settingsBtn").onclick = () => {
  renderThemeGrid();
  document.getElementById("missingResults").innerHTML = "";
  document.getElementById("rComfortLow").value = COMFORT_LOW;
  document.getElementById("rComfortHigh").value = COMFORT_HIGH;
  document.getElementById("rStretchLow").value = STRETCH_LOW;
  document.getElementById("rStretchHigh").value = STRETCH_HIGH;
  settingsBackdrop.classList.add("open");
  settingsSheet.classList.add("open");
};
function closeSettings(){
  settingsBackdrop.classList.remove("open");
  settingsSheet.classList.remove("open");
}
document.getElementById("btnSettingsClose").onclick = closeSettings;
settingsBackdrop.onclick = closeSettings;

document.getElementById("saveRangeBtn").onclick = async () => {
  const newComfortLow = document.getElementById("rComfortLow").value.trim();
  const newComfortHigh = document.getElementById("rComfortHigh").value.trim();
  const newStretchLow = document.getElementById("rStretchLow").value.trim();
  const newStretchHigh = document.getElementById("rStretchHigh").value.trim();

  if(noteToSemitone(newComfortLow) == null || noteToSemitone(newComfortHigh) == null){
    showToast("Comfort notes need to look like A2, C#4, etc.");
    return;
  }
  const useStretchLow = noteToSemitone(newStretchLow) != null ? newStretchLow : newComfortLow;
  const useStretchHigh = noteToSemitone(newStretchHigh) != null ? newStretchHigh : newComfortHigh;

  try{
    const { data: { session } } = await authClient.auth.getSession();
    if(!session) return;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${session.user.id}`, {
      method: "PATCH",
      headers: {...HEADERS, "Prefer":"return=minimal"},
      body: JSON.stringify({
        comfort_low: newComfortLow,
        comfort_high: newComfortHigh,
        stretch_low: useStretchLow,
        stretch_high: useStretchHigh,
        range_mode: "manual",
        updated_at: new Date().toISOString()
      })
    });
    if(!res.ok) throw new Error("Save failed");
    applyRange(newComfortLow, newComfortHigh, useStretchLow, useStretchHigh);
    fetchSongs(); // re-render fit scoring against the new range
    showToast("Range saved");
  }catch(e){
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
      source: "kiplingm/karaoke-tracker",
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

async function onSignedIn(session){
  if(signedIn) return; // guard against double-init if the auth event fires twice
  signedIn = true;

  HEADERS.Authorization = "Bearer " + session.access_token;
  authBackdrop.classList.remove("open");
  authSheet.classList.remove("open");

  const emailEl = document.getElementById("accountEmail");
  if(emailEl) emailEl.textContent = session.user.email;

  await loadProfileRange(session.user.id);

  loadTheme();
  fetchSongs();
}

async function loadProfileRange(userId){
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=*`, {headers: HEADERS});
    if(!res.ok) throw new Error("Profile lookup failed");
    const rows = await res.json();
    let profile = rows[0];

    if(!profile){
      // First time this user has signed in — create a starting profile
      // row using the current fallback defaults (A2–B4 / G2–D5). They can
      // change it immediately in Settings.
      const createRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
        method: "POST",
        headers: {...HEADERS, "Prefer":"return=representation"},
        body: JSON.stringify({
          id: userId,
          comfort_low: COMFORT_LOW, comfort_high: COMFORT_HIGH,
          stretch_low: STRETCH_LOW, stretch_high: STRETCH_HIGH,
          range_mode: "manual"
        })
      });
      if(createRes.ok){
        const created = await createRes.json();
        profile = created[0];
      }
    }

    if(profile && profile.comfort_low && profile.comfort_high){
      applyRange(
        profile.comfort_low,
        profile.comfort_high,
        profile.stretch_low || profile.comfort_low,
        profile.stretch_high || profile.comfort_high
      );
    }
    // If comfort_low/high are still null (e.g. a profile created by the
    // other karaoke-app in "auto" mode, before ever setting values here),
    // we just keep the A2–B4/G2–D5 fallback until they save one in
    // Settings — applyRange() is safe to skip in that case.
  }catch(e){
    console.error("Failed to load profile range, using defaults", e);
  }
}

document.getElementById("authSendBtn").onclick = async () => {
  const email = document.getElementById("authEmail").value.trim();
  const errEl = document.getElementById("authError");
  errEl.style.display = "none";
  if(!email) return;

  const btn = document.getElementById("authSendBtn");
  btn.disabled = true;
  btn.textContent = "Sending…";

  const { error } = await authClient.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin + window.location.pathname }
  });

  btn.disabled = false;
  btn.textContent = "Send sign-in link";

  if(error){
    errEl.textContent = error.message;
    errEl.style.display = "block";
  }else{
    document.getElementById("authFormView").style.display = "none";
    document.getElementById("authSentView").style.display = "block";
  }
};

document.getElementById("authUseDifferentBtn").onclick = () => {
  document.getElementById("authFormView").style.display = "block";
  document.getElementById("authSentView").style.display = "none";
};

(async function initAuthGate(){
  const { data: { session } } = await authClient.auth.getSession();
  if(session){
    onSignedIn(session);
  }else{
    authBackdrop.classList.add("open");
    authSheet.classList.add("open");
  }

  authClient.auth.onAuthStateChange((_event, newSession) => {
    if(newSession && !signedIn){
      onSignedIn(newSession);
    }
  });
})();
