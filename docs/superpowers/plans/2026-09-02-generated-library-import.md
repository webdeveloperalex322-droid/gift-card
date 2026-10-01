# Generated Library Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import the four local generation packages as 1,021 canonical Payload cards, reusing 50 existing pilot cards and creating at most 971 new cards up to `review`.

**Architecture:** A pure planner loads normalized manifest rows, hashes source PNGs, collapses rows by source identity, chooses a deterministic representative, and builds validated collection/card seeds. A Payload Local API adapter applies that closed plan with protected import identities, resumable image/card creation, normal status hooks, and a final invariant audit.

**Tech Stack:** TypeScript, Payload CMS Local API, PostgreSQL, Sharp, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-02-generated-library-import-design.md`

## Global Constraints

- Exactly 1,150 source rows and 1,021 source PNG SHA-256 identities are required.
- Existing 50 pilot cards are read and reused, never edited by this importer.
- At most 971 cards and 971 image records are created.
- New records are created only as `draft` with `noindex,follow`.
- The importer may attempt `draft` to `review`; it must never write `published` or `index,follow`.
- PNG sources and square JPEG renditions stay in ignored `.local` storage.
- Card URLs remain `/otkrytki/<slug>` without a trailing slash.
- Slugs contain no year or numeric-only value and are at most 80 characters; filenames are at most 68 characters.
- Styles and moods create no URLs.

---

### Task 1: Pure manifest planner and deduplication

**Files:**
- Create: `apps/cms/src/import/library-manifest.ts`
- Test: `apps/cms/src/import/library-manifest.test.ts`

**Interfaces:**
- Consumes: four parsed manifest arrays plus a callback that returns file bytes.
- Produces: `planGeneratedLibrary(input): Promise<GeneratedLibraryPlan>` with normalized rows, SHA-256 groups, representatives, discarded aliases, and exact invariant counters.

- [ ] **Step 1: Write failing tests for source-hash identity and priority**

```ts
it('collapses repeated sources and keeps pilot then popular package priority', async () => {
  const plan = await planGeneratedLibrary(fixtureInput);
  expect(plan.uniqueSourceCount).toBe(3);
  expect(plan.creationCandidates).toHaveLength(2);
  expect(plan.aliases).toEqual([
    expect.objectContaining({ package: 'popular-top10-2026-08', representativePackage: 'pilot-2026-08' }),
  ]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run apps/cms/src/import/library-manifest.test.ts`

Expected: FAIL because `library-manifest.ts` does not exist.

- [ ] **Step 3: Implement normalized row loading, path resolution, hashing, grouping, and invariant validation**

```ts
export async function planGeneratedLibrary(
  input: GeneratedLibraryInput,
): Promise<GeneratedLibraryPlan> {
  const rows = normalizePackages(input.packages);
  const hashed = await hashSources(rows, input.readBytes);
  return validateAndGroup(hashed, input.expected);
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm exec vitest run apps/cms/src/import/library-manifest.test.ts`

Expected: PASS with representative selection independent of input ordering.

### Task 2: Taxonomy and unique card content seeds

**Files:**
- Create: `apps/cms/src/import/library-seeds.ts`
- Test: `apps/cms/src/import/library-seeds.test.ts`

**Interfaces:**
- Consumes: `GeneratedLibraryPlan` from Task 1.
- Produces: `buildGeneratedLibrarySeeds(plan): GeneratedLibrarySeeds` with 11 new collection seeds, mappings for all 21 themes, and one card seed per creation candidate.

- [ ] **Step 1: Write failing table-driven tests for all approved theme paths**

```ts
it.each([
  ['День рождения маме', '/otkrytki/prazdniki/den-rozhdeniya/mame'],
  ['1 Мая', '/otkrytki/prazdniki/1-maya'],
  ['Пасха', '/otkrytki/prazdniki/paskha'],
  ['Спасибо', '/otkrytki/pozhelaniya/spasibo'],
])('maps %s to %s', (theme, path) => {
  expect(collectionPathForTheme(theme)).toBe(path);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run apps/cms/src/import/library-seeds.test.ts`

Expected: FAIL because the seed builder does not exist.

- [ ] **Step 3: Implement closed taxonomy tables and deterministic card copy**

```ts
export interface GeneratedCardSeed {
  readonly sourceSha256: string;
  readonly sourceFile: string;
  readonly slug: string;
  readonly title: string;
  readonly h1: string;
  readonly metaDescription: string;
  readonly alt: string;
  readonly caption: string;
  readonly description: string;
  readonly collectionPath: string;
  readonly status: 'draft';
  readonly robots: 'noindex,follow';
}
```

For the Soviet legacy rows, reject the numeric `finalPath` stem and build
`otkrytka-<theme-slug>-sovetskaya-<ordinal>` instead. This exception is closed
to package `soviet-holidays-2026-08`; numeric-only slugs remain invalid
everywhere else.

- [ ] **Step 4: Add failure tests for duplicate SEO fields, slug collisions, invalid lengths, unknown themes, and forbidden status values**

Run: `pnpm exec vitest run apps/cms/src/import/library-seeds.test.ts`

Expected: PASS after each failure branch is implemented.

### Task 3: Protected general import identity

**Files:**
- Create: `apps/cms/src/import/source-import-identity.ts`
- Create: `apps/cms/src/import/source-import-identity.test.ts`
- Modify: `apps/cms/src/collections/cards.ts`
- Modify: `apps/cms/src/collections/card-images.ts`
- Modify: `apps/cms/src/collections/collections.ts`
- Test: `apps/cms/src/collections/cards.test.ts`
- Test: `apps/cms/src/collections/card-images.test.ts`
- Test: `apps/cms/src/collections/collections.test.ts`

**Interfaces:**
- Consumes: actor id and `generated-library-2026-08:{kind}:{identity}` key.
- Produces: `trustedSourceImportContext(key, actorId)` and `assignTrustedSourceImportKey()`; hidden unique `sourceImportKey` fields on all three collections.

- [ ] **Step 1: Write failing security tests**

```ts
it('strips an import key supplied without trusted local context', async () => {
  const result = await runHook({ data: { sourceImportKey: VALID_KEY }, req: aiEditorRequest() });
  expect(result).not.toHaveProperty('sourceImportKey');
});

it('accepts a valid key only when context is bound to the same ai-editor', async () => {
  const result = await runHook({
    data: {},
    req: aiEditorRequest(trustedSourceImportContext(VALID_KEY, 17)),
  });
  expect(result).toMatchObject({ sourceImportKey: VALID_KEY });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm exec vitest run apps/cms/src/import/source-import-identity.test.ts`

Expected: FAIL because the trusted identity hook does not exist.

- [ ] **Step 3: Implement the hook and hidden fields, preserving `pilotImportKey` unchanged**

```ts
export function sourceCardImportKey(sha256: string): string {
  return `generated-library-2026-08:card:${assertSha256(sha256)}`;
}
```

- [ ] **Step 4: Generate Payload types and run collection tests**

Run: `pnpm generate:types`

Run: `pnpm exec vitest run apps/cms/src/import/source-import-identity.test.ts apps/cms/src/collections/cards.test.ts apps/cms/src/collections/card-images.test.ts apps/cms/src/collections/collections.test.ts`

Expected: PASS; ordinary API writes cannot spoof or replace either import identity.

### Task 4: Preflight and resumable Payload apply

**Files:**
- Create: `apps/cms/src/import/library-preflight.ts`
- Create: `apps/cms/src/import/library-preflight.test.ts`
- Create: `apps/cms/src/import/library-apply.ts`
- Create: `apps/cms/src/import/library-apply.test.ts`

**Interfaces:**
- Consumes: `GeneratedLibrarySeeds`, existing pilot/import identities, existing slugs and collection paths, validated JPEG buffers, and an `ai-editor` actor. The existing collection hook, not the importer, resolves the default human `admin` responsible editor under decision Ch-16.
- Produces: `runGeneratedLibraryPreflight()` with a stable fingerprint and zero mutations; `applyGeneratedLibrary()` with resumable creation and final invariant verification.

- [ ] **Step 1: Write failing preflight tests for zero writes and collision detection**

```ts
expect(await runGeneratedLibraryPreflight(input)).toMatchObject({
  mutationCount: 0,
  sourceRows: 1150,
  uniqueSources: 1021,
  existingPilotCards: 50,
  cardsToCreate: 971,
  blockingErrors: [],
});
expect(store.mutationCount).toBe(0);
```

- [ ] **Step 2: Run the preflight tests and verify RED**

Run: `pnpm exec vitest run apps/cms/src/import/library-preflight.test.ts`

Expected: FAIL because preflight is missing.

- [ ] **Step 3: Implement exact asset, actor, state, slug, path, and fingerprint checks**

Preflight reads every required byte once, validates JPEG dimensions through Sharp, verifies the 50 pilot identities, and returns prepared buffers tied to the fingerprint.

- [ ] **Step 4: Write failing apply tests for draft-first creation, resume, review refusal, and forbidden publication**

```ts
expect(store.createdCards.every((card) => card.initialStatus === 'draft')).toBe(true);
expect(report.published).toBe(0);
expect(report.indexed).toBe(0);
expect(report.sitemapUrlsAdded).toBe(0);
```

- [ ] **Step 5: Implement parent-first collection creation, image/card resume, review promotion, and final verification**

Every Local API mutation uses `overrideAccess: false`, the resolved `ai-editor`, and the trusted source-import context only for initial key assignment.

- [ ] **Step 6: Run apply and preflight tests and verify GREEN**

Run: `pnpm exec vitest run apps/cms/src/import/library-preflight.test.ts apps/cms/src/import/library-apply.test.ts`

Expected: PASS, including interrupted-run recovery with no duplicate images or URLs.

### Task 5: Operational CLI and scripts

**Files:**
- Create: `apps/cms/scripts/import-generated-library.ts`
- Modify: `apps/cms/package.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: `GENERATED_LIBRARY_ROOT`, `AI_EDITOR_EMAIL`, Payload configuration, and `--dry-run` or `--apply`.
- Produces: `content:library:dry-run`, `content:library:apply`, and ignored `generated-library-import-report.json`.

- [ ] **Step 1: Write a failing CLI argument test**

The parser must reject missing mode, both modes together, absent asset root, and an actor who is not `ai-editor`.

- [ ] **Step 2: Implement CLI assembly without duplicating business rules**

```json
{
  "content:library:dry-run": "pnpm --filter @otkritka/cms exec payload run ./scripts/import-generated-library.ts -- --dry-run",
  "content:library:apply": "pnpm --filter @otkritka/cms exec payload run ./scripts/import-generated-library.ts -- --apply"
}
```

- [ ] **Step 3: Run focused tests and type checks**

Run: `pnpm exec vitest run apps/cms/src/import/library-*.test.ts apps/cms/src/import/source-import-identity.test.ts`

Run: `pnpm check`

Expected: all pass.

### Task 6: Local dry-run, apply, and evidence report

**Files:**
- Create: `docs/generated-library-2026-08-import-report.md`
- Generated and ignored: `.local/generated-library-import-report.json`

**Interfaces:**
- Consumes: the four real `.local` packages and local PostgreSQL CMS.
- Produces: verified CMS records and human-readable evidence.

- [ ] **Step 1: Copy only the local `.env` into the ignored worktree environment and set the explicit source root**

`GENERATED_LIBRARY_ROOT` points to `D:/_WORK_/laragon_2025/www/otkritka/.local`; no asset is copied into Git.

- [ ] **Step 2: Run the real dry-run**

Run: `pnpm run content:library:dry-run`

Expected: 1,150 rows, 1,021 source identities, 50 existing pilot cards, 971 creation candidates, zero mutations, zero blocking errors.

- [ ] **Step 3: Run apply once and wait for completion**

Run: `pnpm run content:library:apply`

Expected: no created record is published or indexable; failures to reach review are listed rather than bypassed.

- [ ] **Step 4: Re-run dry-run and verify idempotency**

Run: `pnpm run content:library:dry-run`

Expected: zero new creation candidates and no managed-field drift for the 971 library identities.

- [ ] **Step 5: Query Payload and verify images are attached**

Verify every imported card has one image relation, derivative variants, a working authenticated admin thumbnail, at least one collection, and `status` in `draft|review` with `robots=noindex,follow`.

- [ ] **Step 6: Write the evidence report**

Record exact created/resumed/review/draft counts, duplicate groups, thumbnail checks, errors, and the administrator-only publication handoff.

### Task 7: Project gates and commit

**Files:**
- Modify only files already listed when addressing a failed gate.

**Interfaces:**
- Consumes: the fixed implementation commit candidate.
- Produces: green verification evidence and controller verdicts.

- [ ] **Step 1: Run SEO acceptance after the change**

Run: `pnpm test:seo`

Record the exact `PASSED`, `FAILED`, or `SKIPPED` status and compare it with the baseline.

- [ ] **Step 2: Run the full project gate**

Run: `pnpm verify`

Expected: exit code 0.

- [ ] **Step 3: Obtain mandatory controller verdicts on a fixed commit**

Request `url-guard`, `seo-auditor`, and `reviewer`. A FAIL blocks completion and is returned to the owning implementation task.

- [ ] **Step 4: Commit the implementation and evidence**

```bash
git add apps/cms package.json docs/superpowers docs/generated-library-2026-08-import-report.md
git commit -m "Импортировать библиотеку сгенерированных открыток"
```

- [ ] **Step 5: Re-run the required checks on the fixed commit**

Run: `pnpm verify`

Expected: exit code 0 with unchanged controller-relevant diff.
