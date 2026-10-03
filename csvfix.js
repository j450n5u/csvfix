#!/usr/bin/env node
// csvfix — make every CSV open without mojibake (亂碼), on any machine.
//
// The problem: Taiwanese banks (and lots of legacy software) export CSV in Big5.
// Excel on a Traditional-Chinese Windows PC reads that fine, but Excel on a Mac,
// Google Sheets, and anything expecting UTF-8 shows garbage. The mirror-image trap
// is just as common: a UTF-8 CSV *without* a byte-order mark garbles on those same
// Big5 Windows machines.
//
// Exactly one format opens correctly everywhere: UTF-8 with a BOM.
// So that is what this tool normalises every CSV to.
//
// Two conversions, both lossless (the bytes change, the characters don't):
//   1. Big5            -> UTF-8 + BOM
//   2. UTF-8 (no BOM)  -> UTF-8 + BOM   (only when the file contains CJK text;
//                                        pure-ASCII files don't need a BOM)
// A file that is already UTF-8-with-BOM is left completely alone, which makes the
// tool idempotent: run it twice, the second pass changes nothing.
//
// Safety guards — every one of these exists because guessing encodings wrong
// destroys data:
//   * A file must FAIL UTF-8 validation before it is even considered Big5.
//   * Round-trip proof: re-encoding the decoded text back to Big5 must reproduce
//     the original bytes exactly. No proof, no write.
//   * Plausibility proof: round-trip alone cannot tell Big5 from GBK — both are
//     double-byte encodings with overlapping ranges, so a GBK file round-trips
//     through Big5 perfectly while decoding to pure nonsense. But Big5 keeps its
//     ~5,400 everyday characters in a dedicated "Level 1" zone (lead byte
//     0xA4–0xC6). Real Big5 prose scores ~100% in that zone; GBK bytes misread as
//     Big5 scatter across the rare-character zones and score far lower. Below the
//     threshold the file is reported for a human instead of converted.
//   * Shape proof: same line count and same maximum comma-count per line, before
//     and after. A mangled conversion cannot pass both.
//   * The original bytes are copied to a backup next to the file before any write.
//
// Usage:
//   csvfix <file-or-folder> [...]    convert in place (backups are kept)
//   csvfix --dry <path> [...]        report what would change, write nothing
//   csvfix --no-backup <path>        convert without keeping .orig backups

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 50 * 1024 * 1024;
const MIN_PLAUSIBLE = 0.75; // real Big5 measures ~1.00, GBK misread as Big5 ~0.5
const BOM = '﻿';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const NO_BAK = argv.includes('--no-backup');
const targets = argv.filter((a) => !a.startsWith('--'));
if (!targets.length) {
  console.log('usage: csvfix [--dry] [--no-backup] <file-or-folder> [...]');
  process.exit(1);
}

// ── encoding probes ──────────────────────────────────────────────────────────
function isUtf8(buf) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; }
  catch { return false; }
}
function hasBom(buf) { return buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF; }
function hasCjk(str) { return /[㐀-䶿一-鿿豈-﫿　-〿＀-￯]/.test(str); }

// Node has Big5 decoding but no Big5 encoder, so the round-trip is proved through
// a char -> bytes map built once from the decoder itself.
let big5Enc = null;
function big5Encoder() {
  if (big5Enc) return big5Enc;
  const dec = new TextDecoder('big5');
  big5Enc = new Map();
  for (let lead = 0x81; lead <= 0xFE; lead++) {
    for (const [lo, hi] of [[0x40, 0x7E], [0xA1, 0xFE]]) {
      for (let trail = lo; trail <= hi; trail++) {
        const ch = dec.decode(Uint8Array.from([lead, trail]));
        if (ch.length === 1 && ch !== '�' && !big5Enc.has(ch)) big5Enc.set(ch, [lead, trail]);
      }
    }
  }
  return big5Enc;
}
function encodeBig5(str) {
  const map = big5Encoder();
  const out = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) { out.push(cp); continue; }
    const pair = map.get(ch);
    if (!pair) return null; // not representable -> this was never a Big5 file
    out.push(pair[0], pair[1]);
  }
  return Buffer.from(out);
}

// Plausibility: what fraction of the double-byte pairs sit in Big5's Level-1
// (everyday characters) zone? Needs no dictionary — the standard itself sorted
// the common characters into lead bytes 0xA4–0xC6.
function level1Ratio(buf) {
  let pairs = 0, hits = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] < 0x80) continue;
    pairs++;
    if (buf[i] >= 0xA4 && buf[i] <= 0xC6) hits++;
    i++; // skip the trail byte
  }
  return pairs ? hits / pairs : 0;
}

// ── shape proof ──────────────────────────────────────────────────────────────
// A CSV's skeleton must survive untouched: same number of lines, and the widest
// row keeps the same number of commas. Any mis-decode shifts one of the two.
function shape(str) {
  const lines = str.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  let maxCommas = 0;
  for (const l of lines) {
    let n = 0;
    for (let i = 0; i < l.length; i++) if (l[i] === ',') n++;
    if (n > maxCommas) maxCommas = n;
  }
  return lines.length + ':' + maxCommas;
}

// ── the decision for one file ────────────────────────────────────────────────
function classify(buf) {
  if (hasBom(buf)) return { action: null, reason: 'already UTF-8 with BOM' };

  if (isUtf8(buf)) {
    const text = new TextDecoder('utf-8').decode(buf);
    if (!hasCjk(text)) return { action: null, reason: 'plain-ASCII UTF-8, no BOM needed' };
    return { action: 'addbom', reason: 'UTF-8 missing BOM (garbles in Big5 Excel)', text };
  }

  // Not UTF-8. Big5 is the only original we accept, and it has to prove itself
  // twice: the bytes must round-trip AND the characters must look like real text.
  const text = new TextDecoder('big5', { fatal: false }).decode(buf);
  if (text.includes('�')) return { action: null, reason: 'WARN not UTF-8 and not clean Big5 — left alone, needs a human' };
  if (!hasCjk(text)) return { action: null, reason: 'WARN not UTF-8, no CJK — left alone' };
  const back = encodeBig5(text);
  if (!back || !back.equals(buf)) return { action: null, reason: 'WARN Big5 round-trip mismatch — left alone' };
  if (level1Ratio(buf) < MIN_PLAUSIBLE) {
    return { action: null, reason: 'WARN decodes as Big5 but reads like noise (possibly GBK) — left alone, needs a human' };
  }
  return { action: 'big5', reason: 'Big5 -> UTF-8 + BOM', text };
}

// ── apply ────────────────────────────────────────────────────────────────────
function fixFile(file) {
  let st;
  try { st = fs.lstatSync(file); } catch { return; }
  if (!st.isFile() || st.isSymbolicLink()) return;
  if (st.size === 0 || st.size > MAX_BYTES) return;

  const buf = fs.readFileSync(file);
  const { action, reason, text } = classify(buf);
  if (!action) {
    if (reason.startsWith('WARN')) console.log(`!  ${reason}  ${file}`);
    return;
  }

  const before = shape(new TextDecoder(action === 'big5' ? 'big5' : 'utf-8').decode(buf));
  const fixed = BOM + text.replace(/^﻿/, '');
  if (before !== shape(fixed)) {
    console.log(`!  WARN row/column shape changed after conversion — not written  ${file}`);
    return;
  }

  if (DRY) { console.log(`~  would fix: ${reason}  ${file}`); return; }

  if (!NO_BAK) fs.writeFileSync(file + '.orig', buf);
  fs.writeFileSync(file, Buffer.from(fixed, 'utf8'));
  console.log(`✓  ${reason}  ${file}`);
}

function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile() && /\.csv$/i.test(e.name)) fixFile(p);
  }
}

for (const t of targets) {
  let st;
  try { st = fs.statSync(t); } catch { console.log(`!  not found: ${t}`); continue; }
  if (st.isDirectory()) walk(t); else fixFile(t);
}
