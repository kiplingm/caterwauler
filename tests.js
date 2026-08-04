#!/usr/bin/env node
/**
 * Lightweight unit tests for the pure logic in app.js (vocal-range math,
 * fit scoring, transpose suggestions, string normalization).
 *
 * These functions are extracted directly from app.js's source text at
 * test-run time (not duplicated by hand), so the tests always exercise
 * whatever is actually shipped, not a copy that can drift out of sync.
 *
 * This does NOT test DOM/UI behavior, Supabase calls, or rendering —
 * just the math and string logic that's easy to get subtly wrong and
 * easy to verify in isolation. Run with: node tests.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");

// Grab a whole source line by a distinctive substring it contains.
// Used for const declarations, including ones that declare two names
// on one line (e.g. `const COMFORT_LOW = "A2", COMFORT_HIGH = "B4";`).
function extractLineContaining(substr){
  const line = src.split("\n").find(l => l.includes(substr));
  if(!line) throw new Error(`Could not find a line containing "${substr}" in app.js`);
  return line;
}

// Grab a full function definition by name, matching braces to find the end.
function extractFunction(name){
  const startRe = new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{`);
  const startMatch = startRe.exec(src);
  if(!startMatch) throw new Error(`Could not find function ${name} in app.js`);
  let i = startMatch.index + startMatch[0].length;
  let depth = 1;
  while(depth > 0 && i < src.length){
    if(src[i] === "{") depth++;
    else if(src[i] === "}") depth--;
    i++;
  }
  return src.slice(startMatch.index, i);
}

// Build a small sandbox containing just what these functions need.
const sandbox = {};
vm.createContext(sandbox);

const setup = [
  extractLineContaining('let COMFORT_LOW'),           // also declares COMFORT_HIGH
  "var songs = [];",
  extractLineContaining('const NOTE_VALUES'),
  extractFunction("noteToSemitone"),
  "var comfortLowS = null;",
  "var comfortHighS = null;",
  extractFunction("fitLabel"),
  extractFunction("fitScore"),
  extractLineContaining('const NOTE_NAMES'),
  extractFunction("semitoneToNoteName"),
  extractFunction("suggestTransposition"),
  extractFunction("transpositionMessage"),
  extractFunction("normalizeForMatch"),
  extractFunction("computeAutoRange"),
  extractLineContaining('const SING_NOW_STALENESS_CAP_DAYS'),
  extractLineContaining('const SING_NOW_FIT_TIEBREAK_WEIGHT'),
  extractFunction("pickSingNowSongs"),
].join("\n\n");

vm.runInContext(setup, sandbox);

// --- Tiny assertion helpers ---
let pass = 0, fail = 0;
function eq(actual, expected, label){
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if(ok){ pass++; }
  else{ fail++; console.error(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
}

// --- noteToSemitone ---
eq(sandbox.noteToSemitone("A2"), sandbox.noteToSemitone("A2"), "noteToSemitone is deterministic");
eq(sandbox.noteToSemitone("C4") - sandbox.noteToSemitone("C3"), 12, "one octave = 12 semitones");
eq(sandbox.noteToSemitone("C#4"), sandbox.noteToSemitone("Db4"), "sharp/flat enharmonic equivalence");
eq(sandbox.noteToSemitone(""), null, "empty string is invalid");
eq(sandbox.noteToSemitone("H4"), null, "invalid note letter returns null");
eq(sandbox.noteToSemitone(null), null, "null input returns null");

// --- fitLabel: no comfort range set at all (the new-user default) ---
eq(sandbox.fitLabel(sandbox.noteToSemitone("A2"), sandbox.noteToSemitone("B4")).cls, "fit-unknown", "no comfort range set yet = unknown, even with known song notes");
eq(sandbox.fitLabel(sandbox.noteToSemitone("A2"), sandbox.noteToSemitone("B4")).text, "○ YOUR RANGE NOT SET", "distinguishes 'your range not set' from 'song range not set'");

// --- fitLabel / fitScore against a set test comfort range (A2-B4) ---
sandbox.comfortLowS = sandbox.noteToSemitone("A2");
sandbox.comfortHighS = sandbox.noteToSemitone("B4");
eq(sandbox.fitLabel(null, null).cls, "fit-unknown", "no song range data = unknown");
eq(sandbox.fitLabel(null, null).text, "○ RANGE NOT SET", "song-specific unknown uses the other message");
eq(sandbox.fitLabel(sandbox.noteToSemitone("A2"), sandbox.noteToSemitone("B4")).cls, "fit-easy", "exact comfort bounds = in range");
eq(sandbox.fitLabel(sandbox.noteToSemitone("C3"), sandbox.noteToSemitone("A4")).cls, "fit-easy", "comfortably inside bounds = in range");
eq(sandbox.fitLabel(sandbox.noteToSemitone("G2"), sandbox.noteToSemitone("D5")).cls, "fit-out", "outside comfort bounds = out of range (no more stretch tier)");
eq(sandbox.fitLabel(sandbox.noteToSemitone("F2"), sandbox.noteToSemitone("D5")).cls, "fit-out", "below comfort floor = out of range");
eq(sandbox.fitLabel(sandbox.noteToSemitone("G2"), sandbox.noteToSemitone("Eb5")).cls, "fit-out", "above comfort ceiling = out of range");

// --- fitScore ---
eq(sandbox.fitScore(null, null), Infinity, "unknown song range scores worst (Infinity)");
eq(sandbox.fitScore("A2", "B4"), 0, "dead-center comfort fit scores 0");
eq(sandbox.fitScore("F2", "B4") > 0, true, "song extending below comfort floor scores above 0");
{
  sandbox.comfortLowS = null; sandbox.comfortHighS = null;
  eq(sandbox.fitScore("A2", "B4"), Infinity, "no comfort range set yet scores worst too, regardless of song data");
  sandbox.comfortLowS = sandbox.noteToSemitone("A2");
  sandbox.comfortHighS = sandbox.noteToSemitone("B4");
}

// --- semitoneToNoteName round-trips noteToSemitone ---
["A2","C3","F#4","Bb2","D5"].forEach(note=>{
  const s = sandbox.noteToSemitone(note);
  const name = sandbox.semitoneToNoteName(s);
  eq(sandbox.noteToSemitone(name), s, `round-trip semitone<->name for ${note}`);
});

// --- suggestTransposition (comfortSpan for A2-B4 = 26 semitones) ---
eq(sandbox.suggestTransposition(null, null), null, "no data = no suggestion");
{
  // Span of 10 semitones (well under comfortSpan 26) fits the comfort zone.
  const s = sandbox.suggestTransposition(sandbox.noteToSemitone("C3"), sandbox.noteToSemitone("A3"));
  eq(s.zone, "comfort", "narrow song suggests comfort zone");
}
{
  // Span of 48 semitones (wider than comfortSpan 26) has no single-key fix now that there's no stretch fallback tier.
  const s = sandbox.suggestTransposition(sandbox.noteToSemitone("C1"), sandbox.noteToSemitone("C5"));
  eq(s.zone, "none", "song spanning more than comfort range has no single-key fix");
}
{
  // Span of 27 semitones (just over comfortSpan 26) — previously fit a stretch tier, now has no fix either.
  const s = sandbox.suggestTransposition(sandbox.noteToSemitone("C2"), sandbox.noteToSemitone("Eb4"));
  eq(s.zone, "none", "song wider than comfort range has no single-key fix, even if it would've fit the old stretch tier");
}

// --- transpositionMessage ---
eq(sandbox.transpositionMessage(null, null), "", "no data = empty message");
{
  const msg = sandbox.transpositionMessage(sandbox.noteToSemitone("C1"), sandbox.noteToSemitone("C5"));
  eq(msg.includes("no single key change"), true, "unfixable span says so in plain language");
}
{
  const msg = sandbox.transpositionMessage(sandbox.noteToSemitone("F2"), sandbox.noteToSemitone("D4"));
  eq(msg.startsWith("Try shifting"), true, "fixable out-of-range song gets a concrete shift suggestion");
}

// --- normalizeForMatch ---
eq(sandbox.normalizeForMatch("Jim's Home-Plate Tavern!"), "jimshomeplatetavern", "strips punctuation and lowercases");
eq(sandbox.normalizeForMatch("The Killers"), sandbox.normalizeForMatch("the killers"), "case-insensitive");
eq(sandbox.normalizeForMatch(""), "", "empty string stays empty");
eq(sandbox.normalizeForMatch(null), "", "null is handled without throwing");

// --- computeAutoRange ---
sandbox.songs = [];
eq(sandbox.computeAutoRange(), null, "no songs at all = no auto range");
{
  sandbox.songs = [
    {status:"Solid", low_note:"G2", high_note:"D4"},
    {status:"Solid", low_note:"A2", high_note:"D5"},
  ];
  const r = sandbox.computeAutoRange();
  eq(r.comfortLow, "G2", "comfort low = min across Solid songs");
  eq(r.comfortHigh, "D5", "comfort high = max across Solid songs");
  eq(r.count, 2, "count reflects Solid songs with known range");
}
{
  // Solid songs missing range data don't count and don't move the numbers.
  sandbox.songs = [
    {status:"Solid", low_note:"G2", high_note:"D4"},
    {status:"Solid", low_note:null, high_note:null},
  ];
  const r = sandbox.computeAutoRange();
  eq(r.count, 1, "Solid song without range data doesn't count");
}
{
  // Non-Solid statuses never factor into the auto range at all now that
  // there's no stretch zone for them to inform.
  sandbox.songs = [
    {status:"Solid", low_note:"G2", high_note:"D4"},
    {status:"Learning", low_note:"B1", high_note:"G5"},
    {status:"Maybe", low_note:"C1", high_note:"C6"},
  ];
  const r = sandbox.computeAutoRange();
  eq(r.comfortLow, "G2", "Learning/Maybe songs don't widen the range");
  eq(r.comfortHigh, "D4", "Learning/Maybe songs don't widen the range");
}

// --- pickSingNowSongs ---
{
  const now = new Date("2026-08-01T12:00:00Z");
  const songs = [
    {id:"a", status:"Solid", last_played:"2026-07-30", fit_score:0}, // sung 2 days ago
    {id:"b", status:"Solid", last_played:"2026-01-01", fit_score:0}, // sung ~7mo ago, capped
    {id:"c", status:"Solid", last_played:null, fit_score:0},          // never sung
    {id:"d", status:"Learning", last_played:null, fit_score:0},       // wrong status, excluded
    {id:"e", status:"Retired", last_played:null, fit_score:0},        // wrong status, excluded
  ];
  const picks = sandbox.pickSingNowSongs(songs, {now});
  eq(picks.length, 3, "only Solid songs are eligible");
  eq(picks.map(p=>p.id), ["c","b","a"], "never-played and long-stale songs rank ahead of recently-sung ones");
}
{
  // Staleness is capped, so two songs both well past the cap tie on
  // recency and fall back to fit_score as the tiebreaker.
  const now = new Date("2026-08-01T12:00:00Z");
  const songs = [
    {id:"good-fit", status:"Solid", last_played:"2024-01-01", fit_score:0},
    {id:"bad-fit", status:"Solid", last_played:"2023-01-01", fit_score:5},
  ];
  const picks = sandbox.pickSingNowSongs(songs, {now});
  eq(picks.map(p=>p.id), ["good-fit","bad-fit"], "past the staleness cap, better range fit breaks the tie");
}
{
  // excludeIds supports the "give me different picks" reshuffle.
  const now = new Date("2026-08-01T12:00:00Z");
  const songs = [
    {id:"a", status:"Solid", last_played:null, fit_score:0},
    {id:"b", status:"Solid", last_played:null, fit_score:0},
  ];
  const picks = sandbox.pickSingNowSongs(songs, {now, excludeIds: new Set(["a"])});
  eq(picks.map(p=>p.id), ["b"], "excludeIds removes songs from consideration");
}
{
  // count limits the stack size (default is 5, used by the app; here we
  // check an explicit smaller count is honored).
  const now = new Date("2026-08-01T12:00:00Z");
  const songs = [
    {id:"a", status:"Solid", last_played:null, fit_score:0},
    {id:"b", status:"Solid", last_played:null, fit_score:0},
    {id:"c", status:"Solid", last_played:null, fit_score:0},
  ];
  const picks = sandbox.pickSingNowSongs(songs, {now, count: 2});
  eq(picks.length, 2, "count caps the number of picks returned");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
