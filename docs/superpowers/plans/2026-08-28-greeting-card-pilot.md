# Greeting Card Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce and verify 50 original, text-correct, portrait greeting-card masters for the ten approved pilot themes without creating or publishing CMS content.

**Architecture:** The approved design spec is converted into a machine-readable manifest. ImageGen produces one text-free background per manifest item; a small Sharp-based tool crops it to 4:5 and overlays deterministic Russian typography. A validator checks count, dimensions, naming, text metadata and pairwise pHash distance, while final visual QA remains a human gate.

**Tech Stack:** Node.js 22 ESM, Sharp, `@otkritka/images` pHash utilities, Vitest, built-in ImageGen.

**Spec:** `docs/superpowers/specs/2026-08-28-greeting-card-pilot-design.md`

## Global Constraints

- Produce exactly 50 accepted finals: 10 themes × 5 cards.
- Final format is portrait 4:5, 1024 × 1280 px or larger; never upscale a source.
- Generate artwork without text; overlay the exact approved Russian headline and one short wish separately.
- No letters, numbers, logos, watermarks, signatures, brands, copyrighted characters or copied competitor compositions in generated backgrounds.
- New Year cards contain no year number.
- 23 February cards contain no weapons, state crests, active military insignia or agitational slogans.
- 9 May cards use respectful remembrance imagery with no political agitation, invented historical portraits or graphic violence.
- Filenames are unique descriptive transliterations, end in `.jpg`, and contain at most 68 characters.
- pHash distance below 14 is a manual-review signal, not an automatic rejection.
- Generated files never create CMS records, URLs, redirects, sitemap entries or `index,follow` state.
- Any later CMS import must create only `draft` + `noindex`; only a human `admin` may publish.

## File Structure

- Create `content/pilot-2026-08/manifest.json` — operational source of the 50 approved rows and their QA state.
- Create `content/pilot-2026-08/manifest.csv` — editor-facing export generated from the JSON manifest.
- Create `content/pilot-2026-08/backgrounds/` — text-free ImageGen PNG sources.
- Create `content/pilot-2026-08/final/` — accepted 1024 × 1280 JPEG masters with deterministic text.
- Create `content/pilot-2026-08/rejected/` — rejected generations retained for audit, never imported.
- Create `content/pilot-2026-08/contact-sheet.jpg` — 320 px thumbnails for final visual QA.
- Create `content/pilot-2026-08/qa-report.json` — machine checks and manual-review flags.
- Create `scripts/content-pilot/manifest.mjs` — manifest schema checks and CSV export.
- Create `scripts/content-pilot/compose.mjs` — 4:5 crop, SVG text overlay and JPEG master output.
- Create `scripts/content-pilot/validate.mjs` — dimensions, counts, source/final presence and pHash comparisons.
- Create `tests/unit/content-pilot.test.ts` — regression tests for the one-off production tools and manifest contract.
- Modify `package.json` — add narrow `content:pilot:*` commands; do not alter the production build.

---

### Task 1: Operational manifest and contract

**Files:**
- Create: `content/pilot-2026-08/manifest.json`
- Create: `scripts/content-pilot/manifest.mjs`
- Create: `tests/unit/content-pilot.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: the 50 rows and common prompt tail in `docs/superpowers/specs/2026-08-28-greeting-card-pilot-design.md`.
- Produces: `loadManifest(path): Promise<CardRecord[]>`, `validateManifest(records): string[]`, `writeManifestCsv(records, path): Promise<void>`.

- [ ] **Step 1: Write the manifest contract test**

```ts
import { describe, expect, it } from 'vitest';
import {
  loadManifest,
  validateManifest,
} from '../../scripts/content-pilot/manifest.mjs';

describe('content pilot manifest', () => {
  it('contains exactly 50 unique approved card definitions', async () => {
    const records = await loadManifest('content/pilot-2026-08/manifest.json');
    expect(records).toHaveLength(50);
    expect(new Set(records.map((item) => item.id)).size).toBe(50);
    expect(new Set(records.map((item) => item.fileName)).size).toBe(50);
    expect(validateManifest(records)).toEqual([]);
  });

  it('contains five records for each of ten themes', async () => {
    const records = await loadManifest('content/pilot-2026-08/manifest.json');
    const counts = records.reduce<Record<string, number>>((result, item) => {
      result[item.theme] = (result[item.theme] ?? 0) + 1;
      return result;
    }, {});
    expect(Object.keys(counts)).toHaveLength(10);
    expect(Object.values(counts)).toEqual(Array(10).fill(5));
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run tests/unit/content-pilot.test.ts`  
Expected: FAIL because `scripts/content-pilot/manifest.mjs` and the JSON manifest do not exist.

- [ ] **Step 3: Implement the manifest module**

Use this record shape exactly:

```js
// @typedef {{
//   id: string,
//   theme: string,
//   fileName: string,
//   headline: string,
//   wish: string,
//   alt: string,
//   scenePrompt: string,
//   commonPrompt: string,
//   textTone: 'dark' | 'light',
//   status: 'planned' | 'generated' | 'accepted' | 'rejected',
//   backgroundPath: string,
//   finalPath: string
// }} CardRecord
```

`validateManifest()` must report an error unless there are exactly 50 items, IDs
are `01` through `50`, each of ten themes has exactly five items, names are unique,
match `/^[a-z0-9-]+\.jpg$/`, are no longer than 68 characters, all copy fields are
non-empty, and every status is one of the four allowed values. `writeManifestCsv()`
must emit UTF-8 CSV with a header and RFC 4180 escaping (double internal quotes and
quote every cell).

- [ ] **Step 4: Create the 50 manifest records**

Transcribe every numbered row from spec section 4 without editorial changes.
Use `id` `01`…`50`, the subsection title as `theme`, the approved filename/text/alt/
scene prompt, the common prompt tail from spec section 3, status `planned`, paths
`content/pilot-2026-08/backgrounds/<id>.png` and
`content/pilot-2026-08/final/<approved filename>`. Set `textTone` to `dark` for
light backgrounds and `light` for dark/night backgrounds; these values may be
adjusted only during visual QA.

- [ ] **Step 5: Add narrow package commands**

```json
{
  "content:pilot:csv": "node scripts/content-pilot/manifest.mjs --write-csv",
  "content:pilot:compose": "node scripts/content-pilot/compose.mjs",
  "content:pilot:validate": "node scripts/content-pilot/validate.mjs"
}
```

- [ ] **Step 6: Run the focused test**

Run: `pnpm vitest run tests/unit/content-pilot.test.ts`  
Expected: PASS with 50 valid unique records.

- [ ] **Step 7: Generate the CSV and inspect its count**

Run: `pnpm run content:pilot:csv`  
Expected: `content/pilot-2026-08/manifest.csv` contains one header plus 50 rows.

- [ ] **Step 8: Commit the manifest contract**

```bash
git add package.json scripts/content-pilot/manifest.mjs tests/unit/content-pilot.test.ts content/pilot-2026-08/manifest.json content/pilot-2026-08/manifest.csv
git commit -m "feat(content): define 50-card pilot manifest"
```

### Task 2: Deterministic composition tool

**Files:**
- Create: `scripts/content-pilot/compose.mjs`
- Modify: `tests/unit/content-pilot.test.ts`

**Interfaces:**
- Consumes: `CardRecord`, a PNG at `backgroundPath`, and Sharp.
- Produces: `wrapWords(text, maxChars): string[]`, `createTextSvg(card, width, height): Buffer`, `composeCard(card): Promise<void>`, `createContactSheet(records, path): Promise<void>`.

- [ ] **Step 1: Add failing unit tests for wrapping and SVG safety**

```ts
import { createTextSvg, wrapWords } from '../../scripts/content-pilot/compose.mjs';

it('wraps the approved wish without losing words', () => {
  const text = 'Пусть каждый день дарит радость и вдохновение!';
  const lines = wrapWords(text, 28);
  expect(lines.join(' ')).toBe(text);
  expect(lines.every((line) => line.length <= 28)).toBe(true);
});

it('escapes copy before embedding it in SVG', () => {
  const svg = createTextSvg(
    { headline: 'Счастье & любовь', wish: '<добрый день>', textTone: 'dark' },
    1024,
    1280,
  ).toString('utf8');
  expect(svg).toContain('Счастье &amp; любовь');
  expect(svg).toContain('&lt;добрый день&gt;');
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run tests/unit/content-pilot.test.ts`  
Expected: FAIL because the composition exports do not exist.

- [ ] **Step 3: Implement safe wrapping and SVG generation**

Use a 1024 × 1280 SVG, centered headline at y=100 with 68 px Georgia/serif bold,
and wish lines starting at y=200 with 36 px Arial/sans-serif. Limit wishes to 28
characters per line, 48 px line spacing, and at most three lines. Use dark
`#352825` with a light shadow for `textTone: dark`, and white `#fffaf2` with a dark
shadow for `textTone: light`. Escape `&`, `<`, `>`, `"` and `'` before interpolation.

- [ ] **Step 4: Implement composition without upscaling**

`composeCard()` must read metadata, throw when source width is below 1024 or source
height is below 1280, resize with `{ width: 1024, height: 1280, fit: 'cover',
withoutEnlargement: true }`, composite the SVG, and write progressive JPEG at
quality 92 to `finalPath`. It must create the parent directory but never overwrite
an existing final unless the CLI is called with `--replace`.

- [ ] **Step 5: Add an integration test with a synthetic source**

```ts
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it('composes a 1024x1280 progressive JPEG without enlarging', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otkritka-pilot-'));
  temporaryPaths.push(directory);
  const backgroundPath = join(directory, 'source.png');
  const finalPath = join(directory, 'final.jpg');
  await sharp({
    create: { width: 1200, height: 1500, channels: 3, background: '#f6dfd2' },
  }).png().toFile(backgroundPath);

  await composeCard({
    id: '01',
    headline: 'С днём рождения!',
    wish: 'Пусть каждый день дарит радость!',
    textTone: 'dark',
    backgroundPath,
    finalPath,
  });

  const metadata = await sharp(finalPath).metadata();
  expect(metadata).toMatchObject({ width: 1024, height: 1280, format: 'jpeg' });
});
```

Use Vitest's temporary test directory and remove only the exact temporary files in
`afterEach`; do not touch `content/pilot-2026-08` from the test.

- [ ] **Step 6: Run the focused tests**

Run: `pnpm vitest run tests/unit/content-pilot.test.ts`  
Expected: PASS.

- [ ] **Step 7: Commit the composition tool**

```bash
git add scripts/content-pilot/compose.mjs tests/unit/content-pilot.test.ts
git commit -m "feat(content): add deterministic card typography"
```

### Task 3: Generate backgrounds 01–10

**Files:**
- Create: `content/pilot-2026-08/backgrounds/01.png` … `10.png`
- Modify: `content/pilot-2026-08/manifest.json`

**Interfaces:**
- Consumes: each row's `scenePrompt + commonPrompt` for IDs 01–10.
- Produces: ten text-free PNG backgrounds with status `generated`.

- [ ] **Step 1: Generate IDs 01–05 one by one**

Use the built-in ImageGen tool once per distinct asset. Pass the concatenated exact
prompts from the manifest. Save each returned image to its exact `backgroundPath`.

- [ ] **Step 2: Check IDs 01–05 immediately**

Open every image and reject any result with generated lettering, watermark, logo,
malformed flowers/objects, unsafe crop or missing negative space. Move rejected
bytes to `rejected/<id>-attempt-1.png` and regenerate that ID with a prompt naming
the observed defect.

- [ ] **Step 3: Generate IDs 06–10 one by one**

Use one ImageGen call per manifest record; preserve the approved subject and style.

- [ ] **Step 4: Check IDs 06–10 immediately**

Additionally reject recognizable car brands/emblems, deformed vehicle geometry,
watch logos, implausible sails and stereotyped masculine advertising copy.

- [ ] **Step 5: Update manifest statuses**

Set only visually accepted backgrounds 01–10 from `planned` to `generated`. Do not
set `accepted` until final text QA.

### Task 4: Generate backgrounds 11–20

**Files:**
- Create: `content/pilot-2026-08/backgrounds/11.png` … `20.png`
- Modify: `content/pilot-2026-08/manifest.json`

**Interfaces:**
- Consumes: manifest prompts for IDs 11–20.
- Produces: ten text-free daily-wish backgrounds with status `generated`.

- [ ] **Step 1: Generate and inspect IDs 11–15**

Use one ImageGen call per ID. Reject readable notebook text, café branding,
malformed cups/food, implausible cat anatomy, or a subject occupying the copy area.

- [ ] **Step 2: Generate and inspect IDs 16–20**

Use one ImageGen call per ID. Reject extra balloon lettering, branded signs,
malformed butterflies/animals, or layouts that are over 80% visually identical to
another daily-wish card.

- [ ] **Step 3: Update manifest statuses**

Set only valid IDs 11–20 to `generated`.

### Task 5: Generate backgrounds 21–30

**Files:**
- Create: `content/pilot-2026-08/backgrounds/21.png` … `30.png`
- Modify: `content/pilot-2026-08/manifest.json`

**Interfaces:**
- Consumes: manifest prompts for IDs 21–30.
- Produces: ten text-free night and New Year backgrounds with status `generated`.

- [ ] **Step 1: Generate and inspect IDs 21–25**

Use one ImageGen call per ID. Reject malformed moon shapes, excessive artificial
neon, animal anatomy defects, unintended text and insufficient upper negative space.

- [ ] **Step 2: Generate and inspect IDs 26–30**

Use one ImageGen call per ID. Reject any digits/year, letters on gifts/stockings,
known characters, logos, broken ornaments, or unsafe text area.

- [ ] **Step 3: Update manifest statuses**

Set only valid IDs 21–30 to `generated`.

### Task 6: Generate backgrounds 31–40

**Files:**
- Create: `content/pilot-2026-08/backgrounds/31.png` … `40.png`
- Modify: `content/pilot-2026-08/manifest.json`

**Interfaces:**
- Consumes: manifest prompts for IDs 31–40.
- Produces: ten text-free 8 March and 23 February backgrounds with status `generated`.

- [ ] **Step 1: Generate and inspect IDs 31–35**

Use one ImageGen call per ID. Reject artificial flower anatomy, gift branding,
generated numerals, unwanted lettering or overcrowded central copy space.

- [ ] **Step 2: Generate and inspect IDs 36–40**

Use one ImageGen call per ID. Reject flags, state crests, active military symbols,
weapons, aggressive propaganda, branded tools, labels on maps or notebooks.

- [ ] **Step 3: Update manifest statuses**

Set only valid IDs 31–40 to `generated`.

### Task 7: Generate backgrounds 41–50

**Files:**
- Create: `content/pilot-2026-08/backgrounds/41.png` … `50.png`
- Modify: `content/pilot-2026-08/manifest.json`

**Interfaces:**
- Consumes: manifest prompts for IDs 41–50.
- Produces: ten text-free remembrance and Valentine backgrounds with status `generated`.

- [ ] **Step 1: Generate and inspect IDs 41–45**

Use one ImageGen call per ID. Reject flags, slogans, readable documents, identifiable
monuments, invented portraits, graphic violence, medals and political agitation.

- [ ] **Step 2: Generate and inspect IDs 46–50**

Use one ImageGen call per ID. Reject brand-like chocolate packaging, extra fingers,
identifiable faces, known characters, lettering or anatomically implausible birds.

- [ ] **Step 3: Update manifest statuses**

Set only valid IDs 41–50 to `generated`.

### Task 8: Compose all finals and export editor manifest

**Files:**
- Create: `content/pilot-2026-08/final/*.jpg` (50 files)
- Modify: `content/pilot-2026-08/manifest.json`
- Modify: `content/pilot-2026-08/manifest.csv`

**Interfaces:**
- Consumes: 50 status-`generated` manifest rows and their PNG backgrounds.
- Produces: 50 finals and updated CSV; status remains `generated` until QA.

- [ ] **Step 1: Verify generation completeness**

Run: `pnpm run content:pilot:validate -- --stage backgrounds`  
Expected: 50 readable backgrounds, no missing IDs, all at least 1024 × 1280.

- [ ] **Step 2: Compose all final masters**

Run: `pnpm run content:pilot:compose`  
Expected: 50 new progressive JPEGs at exactly 1024 × 1280; no existing final is
overwritten.

- [ ] **Step 3: Inspect a 320 px contact sheet**

Run: `pnpm run content:pilot:compose -- --contact-sheet`  
Expected: `content/pilot-2026-08/contact-sheet.jpg` contains a 5 × 10 grid of
320 × 400 thumbnails in manifest order. Implement the sheet with Sharp by resizing
copies in memory, extending each to a 320 × 430 cell with a 30 px footer, writing
the two-digit ID in the footer via a small SVG, and compositing the 50 cells onto a
1600 × 4300 neutral canvas. Visually check every line of copy. For an unreadable
card, edit only that row's `textTone`, remove its exact final, and rerun composition
for that ID with `--ids <id>`.

- [ ] **Step 4: Regenerate CSV**

Run: `pnpm run content:pilot:csv`  
Expected: CSV contains the final paths and current statuses for all 50 rows.

### Task 9: Automated validation and QA report

**Files:**
- Create: `scripts/content-pilot/validate.mjs`
- Create: `content/pilot-2026-08/qa-report.json`
- Modify: `tests/unit/content-pilot.test.ts`
- Modify: `content/pilot-2026-08/manifest.json`
- Modify: `content/pilot-2026-08/manifest.csv`

**Interfaces:**
- Consumes: manifest, backgrounds, finals, `computePerceptualHash()` and `hammingDistance()` from `@otkritka/images`.
- Produces: `validatePilot(records, stage): Promise<QaReport>` and a report containing missing files, dimensions, format errors and pHash pairs below 14.

- [ ] **Step 1: Write failing validator tests**

```ts
it('flags dimensions and close perceptual hashes without auto-rejecting', async () => {
  const report = await validatePilot(fixtures, 'finals');
  expect(report.dimensionErrors).toContainEqual(expect.objectContaining({ id: '02' }));
  expect(report.similarPairs).toContainEqual(
    expect.objectContaining({ left: '03', right: '04', distance: expect.any(Number) }),
  );
  expect(report.autoRejectedIds).toEqual([]);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run tests/unit/content-pilot.test.ts`  
Expected: FAIL because `validatePilot` does not exist.

- [ ] **Step 3: Implement validator**

For background stage require PNG, minimum width 1024 and height 1280. For final
stage require JPEG and exactly 1024 × 1280. Compute hashes for finals, compare every
pair within the same theme, and include pairs with distance `< 14` in
`similarPairs`. Never populate `autoRejectedIds` based only on pHash. Write the
complete JSON report atomically via a sibling temporary file and rename.

- [ ] **Step 4: Run focused tests**

Run: `pnpm vitest run tests/unit/content-pilot.test.ts`  
Expected: PASS.

- [ ] **Step 5: Run final machine validation**

Run: `pnpm run content:pilot:validate -- --stage finals`  
Expected: 50 JPEGs, zero missing files, zero format/dimension errors; any
`similarPairs` are explicitly listed for manual inspection.

- [ ] **Step 6: Complete manual QA**

Open all 50 finals. Check exact Cyrillic copy against the spec, no generated text or
watermarks, intact anatomy/objects, negative-space balance, originality, alt
accuracy and the special 23 February/9 May restrictions. Regenerate or recompose
failures. Only after a card passes, change its status to `accepted`.

- [ ] **Step 7: Assert the accepted count and refresh artifacts**

Run: `pnpm run content:pilot:validate -- --stage accepted`  
Expected: exactly 50 `accepted` records and no blocking errors. Then run
`pnpm run content:pilot:csv` once more.

- [ ] **Step 8: Commit production tooling and metadata only**

```bash
git add scripts/content-pilot/validate.mjs tests/unit/content-pilot.test.ts content/pilot-2026-08/manifest.json content/pilot-2026-08/manifest.csv content/pilot-2026-08/qa-report.json
git commit -m "feat(content): validate greeting-card pilot"
```

Do not add binary `backgrounds`, `final` or `rejected` folders to Git unless the
human explicitly requests repository storage for the image bytes.

### Task 10: Project verification and handoff

**Files:**
- Verify: all files above
- Verify: `docs/superpowers/specs/2026-08-28-greeting-card-pilot-design.md`
- Verify: `docs/superpowers/plans/2026-08-28-greeting-card-pilot.md`

**Interfaces:**
- Consumes: 50 accepted finals, QA report and the repository verification commands.
- Produces: a human-readable handoff with paths and explicit non-publication status.

- [ ] **Step 1: Run pilot tests**

Run: `pnpm vitest run tests/unit/content-pilot.test.ts`  
Expected: PASS.

- [ ] **Step 2: Run full project verification**

Run: `pnpm verify`  
Expected: check, unit tests and SEO gate all PASS under the project's documented
acceptance rules.

- [ ] **Step 3: Run required reviewers**

Invoke the project `reviewer` for every diff. Because image artifacts and content
metadata are in scope, also invoke `seo-auditor`; resolve every veto before handoff.
No `url-guard` is required because no slug, route, canonical, redirect or sitemap is
changed.

- [ ] **Step 4: Report the deliverables**

Report absolute clickable paths to `final/`, `manifest.csv`, `qa-report.json`, the
spec and this plan. State exactly: 50 finals accepted; CMS/URL/sitemap unchanged;
publication and indexation were not performed.
