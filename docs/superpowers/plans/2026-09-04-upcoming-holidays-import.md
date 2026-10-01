# Upcoming Holidays 2026-09 Import Plan

**Goal:** Add an isolated import campaign for `.local/upcoming-holidays-2026-09` and import its 212 unique cards into local Payload as `draft`/`review`, never `published` or indexable.

**Source:** The human approved the seven new collection paths on 2026-09-04 by replying “делай”. The existing August four-package campaign must remain backward compatible.

## Global constraints

- Campaign input is exactly one package: `upcoming-holidays-2026-09`.
- Exact invariants: 212 rows, 212 source SHA-256 identities, 212 non-pilot creation candidates; no exact source overlap with the August packages.
- Add separate commands `content:upcoming:dry-run` and `content:upcoming:apply`, a separate approval file, and a separate import report.
- Reuse existing `/otkrytki/prazdniki/den-uchitelya`, `/otkrytki/prazdniki/den-materi`, and `/otkrytki/prazdniki/novyy-god` collections by their actual configured paths; do not change their status or managed fields.
- Create only these seven collection paths when missing:
  - `/otkrytki/prazdniki/27-sentyabrya`
  - `/otkrytki/prazdniki/1-oktyabrya`
  - `/otkrytki/prazdniki/den-ottsa`
  - `/otkrytki/prazdniki/28-oktyabrya`
  - `/otkrytki/prazdniki/4-noyabrya`
  - `/otkrytki/prazdniki/10-noyabrya`
  - `/otkrytki/prazdniki/21-noyabrya`
- New collection and card records start in `draft` with `noindex,follow`. Normal hooks may promote them to `review`; no code may write `published` or `index,follow`.
- Upload only the portrait JPEG through the existing image hook; validate square JPEG but keep it in `.local`.
- Preserve current global source-import identity semantics and idempotent resume behavior.
- Do not mutate the database until a clean dry-run is approved and a backup exists.

### Task 1: Implement the separate upcoming-holidays import campaign using TDD

**Owned files:**

- `apps/cms/src/import/library-manifest.ts`
- `apps/cms/src/import/library-manifest.test.ts`
- `apps/cms/src/import/library-seeds.ts`
- `apps/cms/src/import/library-seeds.test.ts`
- `apps/cms/src/import/library-approval.ts`
- `apps/cms/src/import/library-approval.test.ts`
- `apps/cms/scripts/import-generated-library.ts`
- `apps/cms/src/import/library-cli.test.ts`
- `apps/cms/package.json`
- `package.json`

**Required behavior:**

1. RED first: add focused tests proving a single-package upcoming campaign can be planned without weakening the default four-package requirement; exact counters are checked; the seven approved theme paths map correctly; only the seven missing collection seeds are emitted for this campaign; CLI selects distinct package/count/approval/report configuration; old CLI and campaign stay unchanged.
2. Run focused tests and record the expected failures caused by missing behavior.
3. GREEN: implement the smallest campaign abstraction needed by those tests. Keep the old August constants and commands backward compatible.
4. The upcoming campaign must use its own approval file and report so an August approval cannot authorize it.
5. Run focused import tests and `pnpm check`; self-review the diff. Do not run a real apply and do not edit `.env`.
6. Commit only the owned files plus this plan using the message `Добавить импорт предстоящих праздников`.

**Report:** write `.superpowers/sdd/2026-09-04-upcoming-holidays-import/task-1-report.md` with RED evidence, GREEN commands/results, changed files, commit, and concerns. Do not spawn subagents.

### Task 2: Operational dry-run, backup, apply and evidence

Performed by the coordinator after Task 1 passes review:

1. Record baseline `pnpm test:seo`.
2. Validate the 212-image package.
3. Create verified PostgreSQL and local image-storage backups under ignored `.local/backups/`.
4. Run `content:upcoming:dry-run`; require zero mutations/blocking errors and 212 cards to create.
5. Run `content:upcoming:apply`.
6. Re-run dry-run to prove idempotency and query Payload for 212 images/cards, relationships, derivatives, `draft|review`, `noindex,follow`, published=0, indexed=0.
7. Run `pnpm verify`, then url-guard, seo-auditor and reviewer.
