# Site Content Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the 50 accepted pilot greeting cards to the working Payload/Astro site as audited `draft/noindex` content, promote only complete records to `review`, and never publish or index them.

**Architecture:** Work from current `main`, where stages 1–5 are already integrated. First migrate collections into the shared `/otkrytki` namespace with a cross-collection final-path guard, then port only the pilot manifest/tooling, define a reviewed content matrix, and run an idempotent two-phase Payload import (`dry-run` then `apply`) against the local database. Astro resolves cards and nested collections under one route tree; drafts and review records remain non-public and absent from sitemap.

**Tech Stack:** TypeScript 5.9, Node.js 22 ESM, Payload CMS 3.88 Local API, PostgreSQL, Astro 7, Sharp, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-30-site-content-fill-design.md`

## Global Constraints

- Create 10 leaf topic collections backed by 13 total collection nodes: 2 grouping nodes, the intermediate `den-rozhdeniya` occasion, and 10 leaf topics.
- Import exactly 50 accepted JPEG masters, five per leaf topic.
- New content starts only as `draft` with `noindex,follow`; only records that pass every review gate may move to `review`.
- The task must finish with `published = 0`, `index,follow = 0`, and zero new sitemap URLs.
- No automatic or agent-triggered publication is permitted.
- Cards and collections share `/otkrytki`; `/podborki` must disappear from product code and acceptance fixtures.
- Card canonical paths are `/otkrytki/<slug>`; collection paths are nested below `/otkrytki`.
- A final path must be unique across both `cards` and `collections`, not merely within one table.
- Page routes have no trailing slash; segment `page` is forbidden at every content-path position.
- Generated masters stay untracked. The importer reads them from an explicit asset directory and sends them through the Payload image pipeline.
- Image derivatives use 320/640/960/1280/1920 without upscaling and AVIF/WebP/JPEG formats.
- `SITE_URL` remains the only source for absolute URLs; no host fallback may be added.
- Dry-run is non-mutating. Apply is explicit, resumable, does not delete records, and refuses to overwrite conflicting or manually changed content.
- Every code task follows red-green-refactor and ends with focused tests and a small commit.

---

### Task 1: Port the accepted pilot manifest without merging its obsolete branch base

**Files:**
- Create from `codex/greeting-card-pilot`: `content/pilot-2026-08/manifest.json`
- Create from `codex/greeting-card-pilot`: `content/pilot-2026-08/manifest.csv`
- Create from `codex/greeting-card-pilot`: `content/pilot-2026-08/qa-report.json`
- Create from `codex/greeting-card-pilot`: `scripts/content-pilot/manifest.mjs`
- Create from `codex/greeting-card-pilot`: `scripts/content-pilot/validate.mjs`
- Create from `codex/greeting-card-pilot`: `scripts/content-pilot/manifest.d.mts`
- Create from `codex/greeting-card-pilot`: `scripts/content-pilot/validate.d.mts`
- Create from `codex/greeting-card-pilot`: `tests/unit/content-pilot.test.ts`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: committed branch `codex/greeting-card-pilot` and untracked masters in `.worktrees/greeting-card-pilot/content/pilot-2026-08/final/`.
- Produces: `loadManifest(path): Promise<CardRecord[]>`, `validateManifest(records): string[]`, and a repository-visible accepted manifest with 50 records.

- [ ] **Step 1: Create the execution worktree**

Use `superpowers:using-git-worktrees` from current `main`. Create branch
`codex/site-content-fill` in `.worktrees/site-content-fill`. Confirm that the new
worktree starts at the commit containing this plan and has a clean status.

- [ ] **Step 2: Add the pilot integrity test first**

Port `tests/unit/content-pilot.test.ts` from the pilot branch and retain these
blocking assertions:

```ts
const records = await loadManifest('content/pilot-2026-08/manifest.json');
expect(records).toHaveLength(50);
expect(new Set(records.map((item) => item.id)).size).toBe(50);
expect(new Set(records.map((item) => item.fileName)).size).toBe(50);
expect(records.every((item) => item.status === 'accepted')).toBe(true);
expect(validateManifest(records)).toEqual([]);
```

- [ ] **Step 3: Run the focused test and observe the missing-module failure**

Run: `pnpm vitest run tests/unit/content-pilot.test.ts`  
Expected: FAIL because the pilot scripts and manifest are not yet present.

- [ ] **Step 4: Port only the listed committed files**

Use `git restore --source=codex/greeting-card-pilot -- <listed paths>` for the
listed manifest, QA, script, declaration, and test files. Do not merge or
cherry-pick the pilot branch: it predates the integrated Astro/Payload tree and
would delete current product files.

Do not restore `compose.mjs`, generated backgrounds, rejected attempts, final
JPEGs, or the contact sheet into Git. Add explicit ignore rules:

```gitignore
content/pilot-2026-08/backgrounds/
content/pilot-2026-08/final/
content/pilot-2026-08/rejected/
content/pilot-2026-08/contact-sheet.jpg
content/pilot-2026-08/import-report.json
```

- [ ] **Step 5: Add narrow verification commands**

Add to the root scripts without replacing existing application commands:

```json
"content:pilot:validate": "node scripts/content-pilot/validate.mjs",
"content:import:dry-run": "pnpm --filter @otkritka/cms exec payload run ./scripts/import-pilot-content.ts -- --dry-run",
"content:import:apply": "pnpm --filter @otkritka/cms exec payload run ./scripts/import-pilot-content.ts -- --apply"
```

The import commands become runnable after Tasks 6–7 create the script.

- [ ] **Step 6: Run the focused test**

Run: `pnpm vitest run tests/unit/content-pilot.test.ts`  
Expected: PASS with 50 accepted, unique records and 10 themes of five.

- [ ] **Step 7: Commit the pilot contract**

```bash
git add .gitignore package.json content/pilot-2026-08/manifest.json content/pilot-2026-08/manifest.csv content/pilot-2026-08/qa-report.json scripts/content-pilot tests/unit/content-pilot.test.ts
git commit -m "feat(content): import accepted pilot manifest"
```

---

### Task 2: Make `/otkrytki` the only content container and guard cross-collection collisions

**Files:**
- Modify: `packages/shared/src/reserved-routes.ts`
- Modify: `tests/unit/reserved-routes.test.ts`
- Modify: `apps/cms/src/seo/paths.ts`
- Modify: `apps/cms/src/seo/paths.test.ts`
- Modify: `apps/cms/src/collections/collection-path.ts`
- Modify: `apps/cms/src/collections/collection-path.test.ts`
- Create: `apps/cms/src/collections/content-path-claims.ts`
- Create: `apps/cms/src/collections/content-path-claims.test.ts`
- Modify: `apps/cms/src/collections/cards.ts`
- Modify: `apps/cms/src/collections/collections.ts`
- Modify: `apps/cms/src/collections/status-model.ts`
- Modify: `apps/cms/src/collections/status-model.test.ts`
- Modify: `apps/cms/src/payload.config.ts`
- Create: `apps/cms/scripts/migrate-content-namespace.ts`

**Interfaces:**
- Consumes: `contentDocumentPath(collection, doc): string | null` and the current Payload transaction.
- Produces: `COLLECTION_PATH_PREFIX === '/otkrytki'`, a system-only `content-path-claims` collection with a unique `path`, and `reserveContentPath(args): Promise<void>` used by both content collections.

- [ ] **Step 1: Rewrite the route-contract tests first**

Change the assertions so the only content container is `/otkrytki`:

```ts
expect(CARD_PATH_PREFIX).toBe('/otkrytki');
expect(COLLECTION_PATH_PREFIX).toBe('/otkrytki');
expect(buildCardPath('piony')).toBe('/otkrytki/piony');
expect(planCollectionNode({
  candidate: { slug: 'prazdniki', nodeKind: 'group', parent: null },
  env: TEST_ENV,
}).path).toBe('/otkrytki/prazdniki');
expect(reservedRoutes(TEST_ENV).filter((route) => route.kind === 'container').map((route) => route.path))
  .toEqual(['/', '/otkrytki']);
```

Add negative cross-collection tests with a mocked Payload request. The first
owner reserves the path; a different owner receives the unique-path refusal:

```ts
await reserveContentPath({
  collection: 'collections',
  ownerKey: 'collection:prazdniki',
  path: '/otkrytki/prazdniki',
  req,
});

await expect(reserveContentPath({
  collection: 'cards',
  ownerKey: 'card:prazdniki',
  path: '/otkrytki/prazdniki',
  req,
})).rejects.toThrow(/путь.*занят.*подборк/i);
```

Also assert that a retry by `ownerKey: 'collection:prazdniki'` succeeds without
creating a second claim.

- [ ] **Step 2: Run the focused tests and observe the old-prefix failures**

Run:

```bash
pnpm vitest run tests/unit/reserved-routes.test.ts apps/cms/src/seo/paths.test.ts apps/cms/src/collections/collection-path.test.ts apps/cms/src/collections/content-path-claims.test.ts
```

Expected: FAIL because `/podborki` is still registered and the path-claim module
does not exist.

- [ ] **Step 3: Remove `/podborki` from the registry and unify CMS prefixes**

Delete the `/podborki` registry entry. Set:

```ts
export const CARD_PATH_PREFIX = '/otkrytki';
export const COLLECTION_PATH_PREFIX = CARD_PATH_PREFIX;
```

Update the collection-path comments, examples, depth calculation, parent
containment diagnostics, slug descriptions, and admin descriptions to use
`/otkrytki`. Keep `group`, `occasion`, and `recipient` parent rules unchanged.

- [ ] **Step 4: Implement atomic cross-collection path claims**

Create a system-only Payload collection whose `path` field is `unique: true` and
whose records contain `ownerCollection: 'cards' | 'collections'`, `ownerKey`, and
`claimedAt`. Register it in `payload.config.ts`; all CRUD access returns false.
The helper uses the same `req` so the claim participates in the content write's
database transaction.

Use this public contract:

```ts
export interface ReserveContentPathArgs {
  readonly collection: 'cards' | 'collections';
  readonly ownerKey: string;
  readonly path: string;
  readonly req: PayloadRequest;
}

export async function reserveContentPath(
  args: ReserveContentPathArgs,
): Promise<void>;
```

Give both cards and collections a hidden, system-written `pathClaimKey` text
field. A `beforeValidate` hook preserves the stored key or assigns
`crypto.randomUUID()` on create. A `beforeChange` hook runs after collection
path assembly, resolves the final path through `contentDocumentPath`, and calls
`reserveContentPath`.

The reservation algorithm first attempts to create the claim. On the unique
path error, read the existing claim: the same `ownerKey` is an idempotent retry;
a different key is a blocking collision whose message names the owning content
kind. Claims are not automatically deleted or reassigned. This conservative
rule prevents reuse of a URL that may already have been exposed and closes the
race that a query-before-insert check would leave between the two tables.

Keep the existing unique constraints on `cards.slug` and `collections.path`;
they provide the clearer same-table diagnostic, while the claim table provides
the atomic cross-table guarantee.

Add the visible `description` textarea to `Collections` next to `intro` and
`metaDescription`, because the approved content contract requires both a short
visible description and a separate introductory rich-text block. Add
`description` to `COLLECTION_REVIEW_REQUIREMENTS`, so a collection cannot enter
review with that field empty.

- [ ] **Step 5: Add a guarded namespace migration for existing records**

Create a Payload-run script with `--dry-run` as its default and `--apply` as the
only mutating mode. It reads all cards and collections before writing. If any
published collection still has a `/podborki` path, stop and list it: a published
URL needs a human-selected one-hop 301 and cannot be silently rewritten.

In apply mode, resave only draft/review top-level collection nodes so the normal
descendant hooks rebuild their paths below `/otkrytki`; then touch cards and
collections to allocate missing path claims. Finish by asserting that no content
record has a `/podborki` path and that claims exist for every final path. The
script never changes `status`, `robots`, or redirect data.

- [ ] **Step 6: Run the focused tests**

Run the command from Step 2.  
Expected: PASS, including both collision directions and a non-conflicting nested
collection `/otkrytki/prazdniki/8-marta`.

- [ ] **Step 7: Run the layer test suite and commit**

Run: `pnpm vitest run apps/cms/src/collections tests/unit/reserved-routes.test.ts tests/unit/routes.test.ts`  
Expected: PASS.

```bash
git add packages/shared/src/reserved-routes.ts tests/unit/reserved-routes.test.ts apps/cms/src/seo apps/cms/src/collections/collection-path.ts apps/cms/src/collections/collection-path.test.ts apps/cms/src/collections/content-path-claims.ts apps/cms/src/collections/content-path-claims.test.ts apps/cms/src/collections/cards.ts apps/cms/src/collections/collections.ts apps/cms/src/collections/status-model.ts apps/cms/src/collections/status-model.test.ts apps/cms/src/payload.config.ts apps/cms/scripts/migrate-content-namespace.ts
git commit -m "fix(url): share otkrytki namespace across content"
```

---

### Task 3: Resolve cards and collections through one Astro route tree

**Files:**
- Delete: `apps/web/src/pages/podborki/index.astro`
- Delete: `apps/web/src/pages/podborki/[...path].astro`
- Delete: `apps/web/src/pages/otkrytki/[slug].astro`
- Create: `apps/web/src/pages/otkrytki/[...path].astro`
- Modify: `apps/web/src/data/queries.ts`
- Modify: `apps/web/src/data/page-data.ts`
- Modify: `apps/web/src/data/catalog.ts`
- Modify: `apps/web/src/data/breadcrumbs.ts`
- Modify: `apps/web/src/seo/catalog-pages.ts`
- Modify: `apps/web/src/seo/breadcrumbs.ts`
- Modify: `apps/web/src/components/SiteNav.astro`
- Modify: `apps/web/src/pages/otkrytki/index.astro`
- Modify: `apps/web/src/pages/404.astro`
- Modify tests beside the changed modules and `tests/unit/web-*.test.ts`

**Interfaces:**
- Consumes: `CARD_PATH_PREFIX`, `COLLECTION_PATH_PREFIX`, `cardBySlugQuery`, and `collectionByPathQuery`.
- Produces: `loadOtkrytkiPathPage(input): Promise<CardPageData | CollectionPageData | null>` and one catch-all Astro route under `/otkrytki`.

- [ ] **Step 1: Add route-dispatch tests**

Cover all namespace cases:

```ts
expect(await loadOtkrytkiPathPage({ path: '/otkrytki/piony', read: cardOnlyRead }))
  .toMatchObject({ kind: 'card' });
expect(await loadOtkrytkiPathPage({ path: '/otkrytki/prazdniki', read: collectionOnlyRead }))
  .toMatchObject({ kind: 'collection' });
expect(await loadOtkrytkiPathPage({ path: '/otkrytki/prazdniki/8-marta', read }))
  .toMatchObject({ kind: 'collection' });
expect(await loadOtkrytkiPathPage({ path: '/otkrytki/net-takoy-stranitsy', read: emptyRead }))
  .toBeNull();
```

Also assert that a one-segment path never renders both kinds: if test data
returns a card and a collection for the same final path, throw a diagnostic
error because the CMS guard has been bypassed.

- [ ] **Step 2: Run focused web tests and observe the missing dispatcher**

Run:

```bash
pnpm vitest run apps/web/src/data/page-data.test.ts apps/web/src/data/data-access.test.ts tests/unit/web-catalog-pages.test.ts tests/unit/web-breadcrumbs.test.ts tests/unit/web-collection-page.test.ts
```

Expected: FAIL on the old `/podborki` expectations and missing
`loadOtkrytkiPathPage`.

- [ ] **Step 3: Implement the unified data dispatcher**

Implement this order:

1. Canonicalize and reject paths outside `/otkrytki`.
2. For one path segment, query both card slug and exact collection path.
3. Throw if both exist; return the card if only the card exists; return the
   collection if only the collection exists.
4. For two or more segments, query only `collections.path`.
5. Return `null` for unpublished or absent records through the existing public
   read scope.

Carry the new collection `description` through page-data and render it as a
server-side paragraph before the rich-text `intro`; both remain absent for
non-public records because the same public read scope supplies the page.

Change `collectionByPathQuery` to accept paths below `/otkrytki`. Preserve the
rule that `page/N` is routing, not content: the catch-all must delegate valid
pagination to the existing collection-page loader and reject `/page/1`.

- [ ] **Step 4: Replace the Astro routes**

Use a single `apps/web/src/pages/otkrytki/[...path].astro`. It renders the
existing card or collection page component based on the dispatcher result and
sets a real 404 when it returns `null`. Keep the static routes
`/otkrytki/index.astro` and `/otkrytki/page/[page].astro`; Astro gives them
precedence over the catch-all.

Delete both `/podborki` pages and the old one-segment card page to prevent
duplicate matchers.

- [ ] **Step 5: Merge the two catalog entry points**

`/otkrytki` remains the only catalog. Its server-rendered content includes:

- the existing paginated card grid;
- direct `<a href>` links to root collection groups returned by
  `rootCollectionsQuery()`;
- one H1 and self-canonical `/otkrytki`;
- no separate catalog link or breadcrumb node for collections.

Remove `CATALOGS.collections`; keep a single catalog descriptor and update site
navigation, 404 navigation, breadcrumbs, and JSON-LD consumers accordingly.

- [ ] **Step 6: Run focused and full web unit tests**

Run the command from Step 2, then:  
Run: `pnpm vitest run apps/web/src tests/unit/web-*.test.ts`  
Expected: PASS with only `/otkrytki` catalog expectations.

- [ ] **Step 7: Commit the web migration**

```bash
git add apps/web/src tests/unit/web-*.test.ts
git commit -m "fix(web): serve collections below otkrytki"
```

---

### Task 4: Update SEO acceptance to the approved namespace

**Files:**
- Modify: `tests/seo/*.spec.ts`
- Modify: `tests/seo/support/pages.ts`
- Modify: `tests/seo/README.md`
- Modify: product comments/examples still containing `/podborki` under `apps/` or `packages/`

**Interfaces:**
- Consumes: the unified Astro route tree from Task 3.
- Produces: acceptance fixtures that request only canonical `/otkrytki` paths.

- [ ] **Step 1: Change acceptance fixtures before implementation cleanup**

Replace examples by meaning, not blind text substitution:

```text
/podborki/prazdniki/8-marta            -> /otkrytki/prazdniki/8-marta
/podborki/prazdniki/8-marta/mame       -> /otkrytki/prazdniki/8-marta/mame
/podborki/adresaty/mame/page/2          -> /otkrytki/adresaty/mame/page/2
required catalogs ['/', '/otkrytki', '/podborki'] -> ['/', '/otkrytki']
```

Delete assertions that `/podborki` is a live catalog. Add an explicit status
case that `/podborki` is 404, not 301: no published URL has existed in this
repository, so inventing a redirect would create a second address without a
real migration target.

- [ ] **Step 2: Run static/unit acceptance helpers**

Run:

```bash
pnpm vitest run tests/seo/html-parser-contract.spec.ts tests/unit/web-path-policy.test.ts tests/unit/web-front-door.test.ts
```

Expected: PASS with `/otkrytki` fixtures.

- [ ] **Step 3: Remove stale product references**

Run: `rg -n "/podborki" apps packages tests`  
Expected before cleanup: matches in comments, descriptions, and tests. Update
each to the approved form or delete the obsolete two-catalog explanation.  
Expected after cleanup: no matches.

- [ ] **Step 4: Run SEO before/after baseline and commit**

Run: `pnpm test:seo` and record the exact status. If `BASE_URL` is absent, the
current gate must report `SEO_ACCEPTANCE: FAILED`, not a pass. Run the focused
unit suite again.

```bash
git add apps packages tests/seo tests/unit
git commit -m "test(seo): accept unified otkrytki routes"
```

Request `url-guard` and `seo-auditor` verdicts here. A FAIL blocks Task 5.

---

### Task 5: Define the 13-node taxonomy and 50-card content matrix

**Files:**
- Create: `content/pilot-2026-08/site-content.json`
- Create: `scripts/content-import/schema.ts`
- Create: `tests/unit/content-import-schema.test.ts`

**Interfaces:**
- Consumes: `content/pilot-2026-08/manifest.json`.
- Produces: `loadSiteContent(path): Promise<SiteContentMatrix>` and `validateSiteContent(matrix, manifest): string[]`.

- [ ] **Step 1: Write the matrix contract test**

Use these exact invariants:

```ts
const manifest = await loadManifest('content/pilot-2026-08/manifest.json');
const matrix = await loadSiteContent('content/pilot-2026-08/site-content.json');
expect(matrix.collections).toHaveLength(13);
expect(matrix.cards).toHaveLength(50);
expect(matrix.collections.filter((item) => item.leafTopic)).toHaveLength(10);
expect(new Set(matrix.cards.map((item) => item.slug)).size).toBe(50);
expect(new Set(matrix.cards.map((item) => item.title.trim().toLocaleLowerCase('ru-RU'))).size).toBe(50);
expect(new Set(matrix.cards.map((item) => item.metaDescription.trim().toLocaleLowerCase('ru-RU'))).size).toBe(50);
expect(matrix.cards.every((item) => item.status === 'draft' && item.robots === 'noindex,follow')).toBe(true);
expect(validateSiteContent(matrix, manifest)).toEqual([]);
```

- [ ] **Step 2: Run the test and observe missing matrix/module failures**

Run: `pnpm vitest run tests/unit/content-import-schema.test.ts`  
Expected: FAIL because the matrix and loader do not exist.

- [ ] **Step 3: Implement the closed matrix schema**

Define:

```ts
export interface CollectionSeed {
  key: string;
  slug: string;
  nodeKind: 'group' | 'occasion' | 'recipient';
  parentKey: string | null;
  path: string;
  title: string;
  h1: string;
  metaDescription: string;
  intro: string;
  description: string;
  leafTopic: boolean;
  status: 'draft';
  robots: 'noindex,follow';
}

export interface CardSeed {
  pilotId: string;
  collectionKey: string;
  sourceFile: string;
  slug: string;
  title: string;
  h1: string;
  metaDescription: string;
  alt: string;
  caption: string;
  description: string;
  usageTerms: null;
  status: 'draft';
  robots: 'noindex,follow';
}
```

Validation rejects missing manifest ids, extra cards, path mismatches, duplicate
normalized title/H1/meta description, card slug not equal to the master filename
without `.jpg`, text shorter than 40 characters for card descriptions, intro
shorter than 120 characters for leaf collections, and any non-draft/indexable
state.

- [ ] **Step 4: Write the exact taxonomy rows**

The parent graph is fixed:

```text
prazdniki (group, /otkrytki/prazdniki)
  den-rozhdeniya (occasion)
    den-rozhdeniya-zhenshchine (recipient, leaf)
    den-rozhdeniya-muzhchine (recipient, leaf)
  novyy-god (occasion, leaf)
  8-marta (occasion, leaf)
  23-fevralya (occasion, leaf)
  9-maya (occasion, leaf)
  14-fevralya (occasion, leaf)
pozhelaniya (group, /otkrytki/pozhelaniya)
  dobroe-utro (occasion, leaf)
  horoshego-dnya (occasion, leaf)
  spokoynoy-nochi (occasion, leaf)
```

For each leaf, write a separate title, H1, meta description, intro, and visible
description about that specific intent. Do not derive them by replacing one
theme word in a shared sentence.

- [ ] **Step 5: Write all 50 card rows from the accepted manifest**

Map ids 01–50 to the ten leaf keys in blocks of five. Preserve `alt` exactly.
Set `caption` to the exact manifest headline plus wish. Use the approved JPEG
filename without extension as the card slug. Write a distinct title, H1, meta
description, and two-sentence visible description for the depicted scene; each
must name concrete visual details from its manifest `alt` or `scenePrompt`.

Keep `usageTerms: null`: legal text is not approved and must not be invented.
This does not enable publication and is listed in the final human-decision
report.

- [ ] **Step 6: Run the contract test and inspect copy uniqueness**

Run: `pnpm vitest run tests/unit/content-import-schema.test.ts`  
Expected: PASS.  
Run: `pnpm exec eslint scripts/content-import/schema.ts tests/unit/content-import-schema.test.ts`  
Expected: PASS.

- [ ] **Step 7: Commit the content matrix**

```bash
git add content/pilot-2026-08/site-content.json scripts/content-import tests/unit/content-import-schema.test.ts
git commit -m "feat(content): define pilot site copy and taxonomy"
```

---

### Task 6: Build a non-mutating import preflight

**Files:**
- Create: `apps/cms/src/import/pilot-types.ts`
- Create: `apps/cms/src/import/pilot-preflight.ts`
- Create: `apps/cms/src/import/pilot-preflight.test.ts`
- Create: `apps/cms/scripts/import-pilot-content.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `SiteContentMatrix`, an explicit asset root, and a Payload Local API adapter.
- Produces: `runPilotPreflight(input): Promise<PilotPreflightReport>` and CLI mode `--dry-run`.

- [ ] **Step 1: Write failing preflight tests**

Test that dry-run reports exactly 50 valid files and performs zero mutations:

```ts
const report = await runPilotPreflight({
  matrix,
  assetRoot,
  store: fakeStore({ cards: [], collections: [] }),
});
expect(report).toMatchObject({ blockingErrors: [], cards: 50, leafTopics: 10 });
expect(store.mutations).toEqual([]);
```

Add rejection cases for a missing JPEG, dimensions below 1024×1280, a final-path
collision, an existing record whose managed fields differ, and an absent
`ai-editor` actor.

- [ ] **Step 2: Run the focused test and observe missing-module failure**

Run: `pnpm vitest run apps/cms/src/import/pilot-preflight.test.ts`  
Expected: FAIL because the preflight module does not exist.

- [ ] **Step 3: Implement the preflight adapter boundary**

Define a small interface instead of coupling validation to Payload calls:

```ts
export interface PilotImportStore {
  findActor(email: string): Promise<{ id: number | string; role: string } | null>;
  findCardBySlug(slug: string): Promise<ExistingCard | null>;
  findCollectionByPath(path: string): Promise<ExistingCollection | null>;
}
```

`runPilotPreflight` reads each file with Sharp metadata, requires JPEG,
`width >= 1024`, `height >= 1280`, and exact 4:5 ratio, validates the matrix,
checks all final paths against both content collections, and compares managed
fields on existing records. Any mismatch is blocking. Existing exact matches
are marked `resume`, not mutation candidates.

- [ ] **Step 4: Add the explicit actor and asset parameters**

Add to `.env.example`:

```dotenv
# One-off pilot import. Must identify an existing ai-editor so seo-history records the actor.
CONTENT_IMPORT_AI_EDITOR_EMAIL=
# Absolute path or workspace-relative directory containing the 50 accepted JPEG masters.
CONTENT_IMPORT_ASSET_ROOT=
```

No email or asset-path fallback is allowed. The CLI exits before database writes
when either is empty.

- [ ] **Step 5: Implement `--dry-run` as the default mode**

The CLI accepts exactly one mode. With no mode, use dry-run. Reject simultaneous
`--dry-run` and `--apply`. Build the Payload store through `getPayload({ config })`,
print a compact report, write no files, and set exit code 1 when
`blockingErrors.length > 0`.

- [ ] **Step 6: Run focused tests and commit**

Run: `pnpm vitest run apps/cms/src/import/pilot-preflight.test.ts tests/unit/content-import-schema.test.ts`  
Expected: PASS.

```bash
git add .env.example apps/cms/src/import apps/cms/scripts/import-pilot-content.ts
git commit -m "feat(content): add non-mutating pilot preflight"
```

---

### Task 7: Implement resumable Payload apply and review promotion

**Files:**
- Create: `apps/cms/src/import/pilot-apply.ts`
- Create: `apps/cms/src/import/pilot-apply.test.ts`
- Modify: `apps/cms/scripts/import-pilot-content.ts`
- Modify: `apps/cms/package.json`
- Modify: `apps/cms/src/payload-types.ts` only through `pnpm generate:types` if schema changes from Task 2 require it

**Interfaces:**
- Consumes: successful `PilotPreflightReport`, `PilotImportStore`, and existing `ai-editor` actor.
- Produces: `applyPilotContent(input): Promise<PilotImportReport>` and `content/pilot-2026-08/import-report.json`.

- [ ] **Step 1: Write apply tests against a stateful fake store**

Cover these outcomes:

```ts
const first = await applyPilotContent(input);
expect(first.counts).toMatchObject({ cardsCreated: 50, collectionsCreated: 13, published: 0, indexed: 0 });

const second = await applyPilotContent(input);
expect(second.counts).toMatchObject({ cardsCreated: 0, collectionsCreated: 0, resumed: 63 });
expect(store.deleted).toEqual([]);
```

Add cases where one upload fails, one existing card has manually changed copy,
and one card receives a pHash signal. The failure must stay `draft`, appear in
the report, and not roll back or delete other correct drafts.

- [ ] **Step 2: Run the focused test and observe missing apply module**

Run: `pnpm vitest run apps/cms/src/import/pilot-apply.test.ts`  
Expected: FAIL because `pilot-apply.ts` does not exist.

- [ ] **Step 3: Implement ordered collection creation**

Extend the read-only preflight boundary with mutation methods used only by
apply:

```ts
export interface PilotApplyStore extends PilotImportStore {
  createCollection(seed: CollectionSeed, parentId: number | string | null): Promise<ExistingCollection>;
  createImage(seed: CardSeed, bytes: Buffer): Promise<{ id: number | string }>;
  createCard(seed: CardSeed, imageId: number | string, collectionId: number | string): Promise<ExistingCard>;
  moveCollectionToReview(id: number | string): Promise<ExistingCollection>;
  moveCardToReview(id: number | string): Promise<ExistingCard>;
  verifyImported(ids: readonly (number | string)[]): Promise<{ published: number; indexed: number }>;
}
```

Topologically sort by `parentKey`; refuse cycles and missing parents even though
the matrix validator also checks them. For each node:

- find by exact `path`;
- create with `status: 'draft'` and `robots: 'noindex,follow'` when absent;
- reuse only when all managed fields match;
- otherwise record a blocking conflict and do not update it.

Convert `intro` plain text into the same minimal Lexical paragraph/root shape
accepted by `public-rich-text` hooks. Pass the real `ai-editor` document as
`user`, `overrideAccess: false`, and let Payload hooks assign path,
responsibleEditor, audit history, and default status protections.

- [ ] **Step 4: Implement image and card creation**

For each card in pilot-id order:

1. Read the JPEG bytes from `CONTENT_IMPORT_ASSET_ROOT`.
2. Reuse a matching existing card only when all managed fields and its linked
   image metadata match.
3. Otherwise create `card-images` with
   `file: { data, mimetype: 'image/jpeg', name: sourceFile, size }`.
4. Create the card in `draft/noindex,follow`, link the leaf collection as the
   first collection, and preserve all matrix copy.
5. On a per-card exception, record it and continue; never delete already created
   records or image files.

Do not use `overrideAccess: true`. The actor must be the selected `ai-editor`, so
`seo-history` records the service account and server protections remain active.

- [ ] **Step 5: Promote only complete records to review**

After all draft creation, update each clean card and collection separately with
`{ status: 'review' }`. Let existing review-completeness, meta-duplicate, and
pHash hooks decide. Catch refusals and leave those records in `draft` with the
exact server message in the report. Never set `published`, `index,follow`,
`canonical`, redirects, or sitemap fields.

- [ ] **Step 6: Write and validate the import report**

The report contains:

```ts
export interface PilotImportReport {
  mode: 'apply';
  startedAt: string;
  finishedAt: string;
  counts: {
    collectionNodes: number;
    leafTopics: number;
    cards: number;
    collectionsCreated: number;
    cardsCreated: number;
    resumed: number;
    draft: number;
    review: number;
    published: 0;
    indexed: 0;
    sitemapUrlsAdded: 0;
  };
  records: Array<{ key: string; kind: 'card' | 'collection'; state: 'draft' | 'review' | 'conflict' | 'error'; detail: string }>;
}
```

Before writing, query the imported ids and assert `published === 0` and no
indexable robots value. Write atomically through a temporary sibling file then
rename to `content/pilot-2026-08/import-report.json`.

- [ ] **Step 7: Add CMS commands, run tests, and commit**

Add:

```json
"content:import:dry-run": "payload run ./scripts/import-pilot-content.ts -- --dry-run",
"content:import:apply": "payload run ./scripts/import-pilot-content.ts -- --apply"
```

Run: `pnpm vitest run apps/cms/src/import`  
Expected: PASS.

```bash
git add apps/cms/src/import apps/cms/scripts/import-pilot-content.ts apps/cms/package.json apps/cms/src/payload-types.ts
git commit -m "feat(content): import pilot drafts through Payload"
```

---

### Task 8: Run the real dry-run and local import

**Files:**
- Runtime only: local PostgreSQL database and configured image storage
- Generated, ignored: `content/pilot-2026-08/import-report.json`
- Generated, ignored: local originals and derivatives roots

**Interfaces:**
- Consumes: existing local `.env`, existing `ai-editor`, and `.worktrees/greeting-card-pilot/content/pilot-2026-08/final/`.
- Produces: 13 collection records and 50 card records in `draft` or `review`, plus an audit report.

- [ ] **Step 1: Confirm environment without printing secrets**

Check only presence/non-emptiness of `DATABASE_URL`, `PAYLOAD_SECRET`,
`PAYLOAD_ADMIN_PATH`, `CONTENT_IMPORT_AI_EDITOR_EMAIL`,
`IMAGE_STORAGE_DERIVATIVES_ROOT`, and `IMAGE_STORAGE_ORIGINALS_ROOT`. Confirm the
asset root resolves to the pilot `final` directory and contains exactly 50 JPEGs.

- [ ] **Step 2: Establish the SEO baseline**

Run: `pnpm test:seo`  
Record the exact `PASSED`, `FAILED`, or `SKIPPED` line and reason. Do not describe
`SKIPPED` as passing.

- [ ] **Step 3: Ensure the local database exists**

Run: `pnpm --filter @otkritka/cms run ensure-db`  
Expected: the configured database exists or is created without altering another
database.

- [ ] **Step 4: Migrate and claim any existing non-public content paths**

Run `migrate-content-namespace.ts --dry-run`. If it lists a published
`/podborki` record, stop for a human redirect decision. Otherwise run it with
`--apply`, then dry-run again; the second report must show zero old paths and
complete claims for existing records.

- [ ] **Step 5: Run the real dry-run**

Set `CONTENT_IMPORT_ASSET_ROOT` to the absolute pilot final directory and run:

```bash
pnpm run content:import:dry-run
```

Expected: 50 files, 13 nodes, 10 leaf topics, zero blocking errors, and zero
database mutations. If the configured `ai-editor` does not exist, stop before
apply and report that exact blocker; do not synthesize a service account or use
admin attribution.

- [ ] **Step 6: Run apply once and resume once**

Run: `pnpm run content:import:apply`  
Expected: 13 collection nodes and 50 cards created or exactly resumed, no
publication/indexing.  
Run the same command a second time.  
Expected: zero duplicates and only `resumed` outcomes.

- [ ] **Step 7: Query final invariants directly**

Use a Payload-run verification script or Local API read to assert:

```text
pilot collection nodes = 13
pilot leaf topics = 10
pilot cards = 50
published = 0
index,follow = 0
new sitemap-eligible records = 0
```

Compare every card slug, title, alt, image relation, and primary collection with
the matrix. Compare all image variants with the pipeline contract.

---

### Task 9: Full verification, controller vetoes, and handoff

**Files:**
- Create: `docs/content-pilot-2026-08-import-report.md`
- Modify only if a controller finds a defect: files owned by the responsible layer

**Interfaces:**
- Consumes: completed code, local import report, and test output.
- Produces: project-protocol report and a clean, reviewable branch.

- [ ] **Step 1: Regenerate Payload types and run the full gate**

Run:

```bash
pnpm generate:types
pnpm verify
```

Expected: all checks and unit tests pass. Record the exact SEO acceptance status
separately even when the shell command exits zero.

- [ ] **Step 2: Run SEO after the change**

Run: `pnpm test:seo`  
Compare with Task 8 Step 2 and record the delta. If the result is `SKIPPED` or
`FAILED`, do not claim SEO passed.

- [ ] **Step 3: Request mandatory controller verdicts**

Run `reviewer`, `seo-auditor`, and `url-guard` against the actual branch diff and
runtime report. Any FAIL returns to the owning implementation task, followed by
another `pnpm verify`, SEO run, and controller round.

- [ ] **Step 4: Write the fixed-format handoff report**

`docs/content-pilot-2026-08-import-report.md` must contain:

```markdown
## Что сделано
## Файлы
## Проверка
## Статусы контента
## Требует решения человека
## Не сделано
```

State the exact counts in `draft` and `review`; state `published: 0`. Under
human decisions list visual moderation, legal usage wording, proof of search
demand, and eventual publication/indexing. Include the real SEO status and all
three controller verdicts.

- [ ] **Step 5: Commit the final report**

```bash
git add docs/content-pilot-2026-08-import-report.md
git commit -m "docs(content): report pilot site import"
```

- [ ] **Step 6: Use the project finish protocol**

Invoke `finish-task` and `superpowers:verification-before-completion`. Do not
merge, publish, enable indexing, or change sitemap entries. Offer the completed
branch to the human for visual moderation and integration.
