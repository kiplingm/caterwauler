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
  extractLineContaining('let STRETCH_LOW'),            // also declares STRETCH_HIGH
  "var songs = [];",
  extractLineContaining('const NOTE_VALUES'),
  extractFunction("noteToSemitone"),
  extractLineContaining('let comfortLowS'),
  extractLineContaining('let comfortHighS'),
  extractLineContaining('let stretchLowS'),
  extractLineContaining('let stretchHighS'),
  extractFunction("fitLabel"),
  extractFunction("fitScore"),
  extractLineContaining('const NOTE_NAMES'),
  extractFunction("semitoneToNoteName"),
  extractFunction("suggestTransposition"),
  extractFunction("transpositionMessage"),
  extractFunction("normalizeForMatch"),
  extractFunction("computeAutoRange"),
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

// --- fitLabel (against Kipling's actual comfort A2-B4 / stretch G2-D5) ---
eq(sandbox.fitLabel(null, null).cls, "fit-unknown", "no range data = unknown");
eq(sandbox.fitLabel(sandbox.noteToSemitone("A2"), sandbox.noteToSemitone("B4")).cls, "fit-easy", "exact comfort bounds = easy fit");
eq(sandbox.fitLabel(sandbox.noteToSemitone("G2"), sandbox.noteToSemitone("D5")).cls, "fit-stretch", "exact stretch bounds = stretch");
eq(sandbox.fitLabel(sandbox.noteToSemitone("F2"), sandbox.noteToSemitone("D5")).cls, "fit-out", "below stretch floor = out of range");
eq(sandbox.fitLabel(sandbox.noteToSemitone("G2"), sandbox.noteToSemitone("Eb5")).cls, "fit-out", "above stretch ceiling = out of range");

// --- fitScore ---
eq(sandbox.fitScore(null, null), Infinity, "unknown range scores worst (Infinity)");
eq(sandbox.fitScore("A2", "B4"), 0, "dead-center comfort fit scores 0");
eq(sandbox.fitScore("F2", "B4") > 0, true, "song extending below comfort floor scores above 0");

// --- semitoneToNoteName round-trips noteToSemitone ---
["A2","C3","F#4","Bb2","D5"].forEach(note=>{
  const s = sandbox.noteToSemitone(note);
  const name = sandbox.semitoneToNoteName(s);
  eq(sandbox.noteToSemitone(name), s, `round-trip semitone<->name for ${note}`);
});

// --- suggestTransposition ---
// comfortSpan (B4-A2) = 26 semitones, stretchSpan (D5-G2) = 31 semitones.
eq(sandbox.suggestTransposition(null, null), null, "no data = no suggestion");
{
  // Span of 10 semitones (well under comfortSpan 26) fits the comfort zone.
  const s = sandbox.suggestTransposition(sandbox.noteToSemitone("C3"), sandbox.noteToSemitone("A3"));
  eq(s.zone, "comfort", "narrow song suggests comfort zone");
}
{
  // Span of 27 semitones (over comfortSpan 26, under stretchSpan 31) only fits stretch.
  const s = sandbox.suggestTransposition(sandbox.noteToSemitone("C2"), sandbox.noteToSemitone("Eb4"));
  eq(s.zone, "stretch", "wide-but-stretch-sized song suggests stretch zone");
}
{
  // Span of 48 semitones (wider than even stretchSpan 31) has no single-key fix.
  const s = sandbox.suggestTransposition(sandbox.noteToSemitone("C1"), sandbox.noteToSemitone("C5"));
  eq(s.zone, "none", "song spanning more than full stretch range has no single-key fix");
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
  // No Learning/Maybe evidence at all: falls back to the 3-semitone pad heuristic.
  sandbox.songs = [
    {status:"Solid", low_note:"G2", high_note:"D4"},
    {status:"Solid", low_note:"A2", high_note:"D5"},
  ];
  const r = sandbox.computeAutoRange();
  eq(r.comfortLow, "G2", "comfort low = min across Solid songs");
  eq(r.comfortHigh, "D5", "comfort high = max across Solid songs");
  eq(r.stretchLow, "E2", "no Learning/Maybe evidence below comfort -> falls back to 3-semitone pad");
  eq(r.stretchHigh, "F5", "no Learning/Maybe evidence above comfort -> falls back to 3-semitone pad");
}
{
  // A Learning song that reaches higher than any Solid song should pull
  // the stretch ceiling up to match real evidence, not the flat pad.
  sandbox.songs = [
    {status:"Solid", low_note:"G2", high_note:"D4"},
    {status:"Solid", low_note:"A2", high_note:"D5"},
    {status:"Learning", low_note:"B3", high_note:"F5"},
  ];
  const r = sandbox.computeAutoRange();
  eq(r.stretchHigh, "F5", "Learning song's high note becomes the evidence-based stretch ceiling");
  eq(r.stretchLow, "E2", "low side still falls back to pad since no Learning/Maybe evidence there");
}
{
  // A Maybe song reaching lower than comfort should set the stretch floor,
  // and only that side — the high side still falls back to the pad.
  sandbox.songs = [
    {status:"Solid", low_note:"G2", high_note:"D4"},
    {status:"Maybe", low_note:"D2", high_note:"C4"},
  ];
  const r = sandbox.computeAutoRange();
  eq(r.stretchLow, "D2", "Maybe song's low note becomes the evidence-based stretch floor");
  eq(r.stretchHigh, "F4", "high side still falls back to 3-semitone pad past comfort");
}
{
  // Learning/Maybe notes that fall *inside* comfort shouldn't narrow
  // stretch below the fallback pad.
  sandbox.songs = [
    {status:"Solid", low_note:"G2", high_note:"D4"},
    {status:"Learning", low_note:"A2", high_note:"C4"}, // entirely inside comfort
  ];
  const r = sandbox.computeAutoRange();
  eq(r.stretchLow, "E2", "in-bounds Learning song doesn't override the fallback pad");
  eq(r.stretchHigh, "F4", "in-bounds Learning song doesn't override the fallback pad");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
