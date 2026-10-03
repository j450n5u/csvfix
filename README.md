# csvfix

Fixes the mojibake (亂碼) problem that every office in Taiwan knows: the bank
exports a CSV, it opens fine on one computer, and it's unreadable garbage on the
next one.

## The problem

Taiwanese banks and a lot of legacy software still export CSV in **Big5**.
Excel on a Traditional-Chinese Windows PC opens that fine — but Excel on a Mac,
Google Sheets, and basically everything modern expects UTF-8 and shows garbage.

The trap works in both directions: a **UTF-8 file without a BOM** (what Google
Sheets exports) garbles on those same Big5 Windows machines.

There is exactly one CSV format that opens correctly *everywhere*:
**UTF-8 with a byte-order mark.** This tool converts every CSV to that, safely.

## Usage

```
node csvfix.js <file-or-folder> [...]     # convert in place, keeps .orig backups
node csvfix.js --dry <path>               # report only, write nothing
node csvfix.js --no-backup <path>         # convert without backups
```

## Why it's safe

Guessing encodings wrong destroys data, so nothing is written unless the file
proves itself four times:

1. **UTF-8 check first** — a file must *fail* strict UTF-8 validation before it
   is even considered Big5.
2. **Round-trip proof** — the decoded text, re-encoded back to Big5, must
   reproduce the original bytes exactly.
3. **Plausibility proof** — a GBK (Simplified Chinese) file round-trips through
   Big5 perfectly while decoding to pure nonsense, so round-trip alone isn't
   enough. But Big5 keeps its ~5,400 everyday characters in a dedicated zone
   (lead byte `0xA4–0xC6`). Real Big5 text scores ~100% in that zone; GBK
   misread as Big5 scores ~50%. No dictionary needed — the encoding standard
   itself is the dictionary.
4. **Shape proof** — same line count and the same maximum comma-count per row,
   before and after.

Any file that fails a proof is reported and left untouched. Already-correct
files are skipped, so the tool is idempotent.

## The story

Built after one too many "the file you sent me is unreadable" mornings at a
manufacturing group in Taiwan. It has been quietly normalising our shared
folders on a cron job ever since, and nobody has complained about 亂碼 since.

No dependencies. Node 18+.

## License

MIT
