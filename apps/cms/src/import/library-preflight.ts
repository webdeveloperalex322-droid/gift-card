import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { computeImageRevision } from '@otkritka/images';
import sharp from 'sharp';

import { buildCardPath } from '../seo/paths';
import type { GeneratedLibraryPlan } from './library-manifest';
import type { GeneratedCardSeed, GeneratedCollectionSeed, GeneratedLibrarySeeds } from './library-seeds';
import { normalizePilotRichText } from './pilot-preflight';
import { pilotCardImportKey, pilotImageImportKey } from './pilot-import-identity';
import { pilotIntroDocument } from './pilot-types';
import { sourceCardImportKey, sourceCollectionImportKey, sourceImageImportKey } from './source-import-identity';

export interface GeneratedLibraryActor { readonly id: number | string; readonly email: string; readonly role: string }
export interface GeneratedLibraryExistingCard {
  readonly id: number | string; readonly sourceImportKey: string | null; readonly pathClaimKey?: string | null;
  readonly updatedAt?: string | null; readonly slug: string; readonly status: string; readonly robots: string;
  readonly imageId?: number | string | null; readonly collectionPath?: string | null; readonly title?: string | null;
  readonly h1?: string | null; readonly metaDescription?: string | null; readonly alt?: string | null;
  readonly caption?: string | null; readonly description?: string | null; readonly usageTerms?: string | null;
}
export interface GeneratedLibraryImageVariant { readonly key: string }
export interface GeneratedLibraryExistingImage {
  readonly id: number | string; readonly sourceImportKey: string | null; readonly revision?: string | null;
  readonly keyBase?: string | null; readonly originalKey?: string | null;
  readonly variants?: readonly GeneratedLibraryImageVariant[] | null;
}
export interface GeneratedLibraryExistingCollection {
  readonly id: number | string; readonly sourceImportKey?: string | null; readonly path: string;
  readonly pathClaimKey?: string | null; readonly updatedAt?: string | null; readonly slug?: string | null;
  readonly nodeKind?: string | null; readonly parentPath?: string | null; readonly relatedPaths?: readonly string[];
  readonly title?: string | null; readonly h1?: string | null; readonly metaDescription?: string | null;
  readonly intro?: unknown; readonly description?: string | null; readonly status: string; readonly robots: string;
}
export interface GeneratedLibraryPathClaim {
  readonly path: string; readonly ownerCollection: 'cards' | 'collections'; readonly ownerKey: string;
}
export interface GeneratedLibraryReadStore {
  isSchemaReady(): Promise<boolean>;
  findActor(email: string): Promise<GeneratedLibraryActor | null>;
  findPilotCardByKey(key: string): Promise<{ readonly id: number | string; readonly imageId: number | string | null } | null>;
  findPilotImageByKey(key: string): Promise<GeneratedLibraryExistingImage | null>;
  findCollectionByPath(path: string): Promise<GeneratedLibraryExistingCollection | null>;
  findCollectionBySourceKey(key: string): Promise<GeneratedLibraryExistingCollection | null>;
  findCardBySourceKey(key: string): Promise<GeneratedLibraryExistingCard | null>;
  findImageBySourceKey(key: string): Promise<GeneratedLibraryExistingImage | null>;
  findCardBySlug(slug: string): Promise<GeneratedLibraryExistingCard | null>;
  findContentPathClaimByPath(path: string): Promise<GeneratedLibraryPathClaim | null>;
  hasOriginal(key: string): Promise<boolean>;
  hasDerivative(key: string): Promise<boolean>;
}
export interface GeneratedLibraryPreflightInput {
  readonly actorEmail: string; readonly plan: GeneratedLibraryPlan; readonly seeds: GeneratedLibrarySeeds;
  readonly store: GeneratedLibraryReadStore; readonly readBytes: (path: string) => Promise<Buffer>;
}
export interface GeneratedLibraryPreparedCard {
  readonly seed: GeneratedCardSeed; readonly portraitPath: string; readonly portraitSha256: string; readonly portraitRevision: string;
}
export interface GeneratedLibraryPreflightReport {
  readonly mode: 'dry-run'; readonly mutationCount: 0; readonly sourceRows: number; readonly uniqueSources: number;
  readonly existingPilotCards: number; readonly cardsToCreate: number; readonly cardsToResume: number;
  readonly collectionsToCreate: number; readonly blockingErrors: readonly string[]; readonly fingerprint: string | null;
  readonly preparedCards: readonly GeneratedLibraryPreparedCard[];
}

export const GENERATED_LIBRARY_SCHEMA_ERROR =
  'Generated library schema is not ready. Start the updated CMS once with PAYLOAD_DB_PUSH=true, stop it, then rerun --dry-run; the importer never mutates schema.';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stable(child)]));
}
function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }

async function validateImage(bytes: Buffer, path: string, shape: 'portrait' | 'square' | 'source'): Promise<string[]> {
  try {
    const metadata = await sharp(bytes).metadata();
    const errors: string[] = [];
    const expectedFormat = shape === 'source' ? 'png' : 'jpeg';
    if (metadata.format !== expectedFormat) errors.push(`${path} must be ${expectedFormat.toUpperCase()}.`);
    const { width, height } = metadata;
    if (width === undefined || height === undefined || width < 640 || height < 640) errors.push(`${path} must have readable dimensions of at least 640px.`);
    else if (shape === 'portrait' && width * 5 !== height * 4) errors.push(`${path} must have exact 4:5 portrait ratio.`);
    else if (shape === 'square' && width !== height) errors.push(`${path} must be square.`);
    return errors;
  } catch (error) { return [`${path} cannot be decoded: ${error instanceof Error ? error.message : String(error)}.`]; }
}
function activeManagedStatus(label: string, value: { status: string; robots: string }): string[] {
  const errors: string[] = [];
  if (value.status !== 'draft' && value.status !== 'review') errors.push(`${label} must remain draft or review; received ${value.status}.`);
  if (value.robots !== 'noindex,follow') errors.push(`${label} must remain noindex,follow; received ${value.robots}.`);
  return errors;
}
function managedCollection(seed: GeneratedCollectionSeed): Readonly<Record<string, unknown>> {
  return { slug: seed.slug, path: seed.path, nodeKind: seed.nodeKind, parentPath: seed.parentPath, title: seed.title,
    h1: seed.h1, metaDescription: seed.metaDescription, intro: normalizePilotRichText(pilotIntroDocument(seed.intro)),
    description: seed.description, robots: seed.robots };
}
function actualCollection(value: GeneratedLibraryExistingCollection): Readonly<Record<string, unknown>> {
  return { slug: value.slug ?? null, path: value.path, nodeKind: value.nodeKind ?? null, parentPath: value.parentPath ?? null,
    title: value.title ?? null, h1: value.h1 ?? null, metaDescription: value.metaDescription ?? null,
    intro: normalizePilotRichText(value.intro), description: value.description ?? null, robots: value.robots };
}
function claimError(label: string, path: string, kind: 'cards' | 'collections', existing: { pathClaimKey?: string | null } | null, claim: GeneratedLibraryPathClaim | null): string | null {
  if (claim === null) return existing === null ? null : `${label} final path ${path} has no permanent content-path claim.`;
  const claimKey = existing?.pathClaimKey;
  if (typeof claimKey !== 'string' || claimKey.trim() === '') return `${label} final path ${path} is permanently claimed by ${claim.ownerKey}.`;
  return claim.ownerCollection === kind && claim.ownerKey === `${kind}:${claimKey}` ? null : `${label} final path ${path} is permanently claimed by ${claim.ownerKey}.`;
}

export async function storedImageErrors(label: string, image: GeneratedLibraryExistingImage, expectedRevision: string,
  store: Pick<GeneratedLibraryReadStore, 'hasDerivative' | 'hasOriginal'>): Promise<string[]> {
  const errors: string[] = [];
  if (image.revision !== expectedRevision) errors.push(`${label} differs in managed field revision.`);
  if (typeof image.keyBase !== 'string' || image.keyBase.trim() === '') errors.push(`${label} has no keyBase.`);
  if (typeof image.originalKey !== 'string' || image.originalKey.trim() === '') errors.push(`${label} has no originalKey.`);
  else if (!await store.hasOriginal(image.originalKey)) errors.push(`${label} original ${image.originalKey} is missing from storage.`);
  const variants = image.variants ?? [];
  if (variants.length === 0) errors.push(`${label} has no derivatives.`);
  else for (const variant of variants) {
    if (variant.key.trim() === '') errors.push(`${label} has an empty derivative key.`);
    else if (!await store.hasDerivative(variant.key)) errors.push(`${label} derivative ${variant.key} is missing from storage.`);
  }
  return errors;
}

export async function runGeneratedLibraryPreflight(input: GeneratedLibraryPreflightInput): Promise<GeneratedLibraryPreflightReport> {
  const empty = (blockingErrors: readonly string[]): GeneratedLibraryPreflightReport => ({ mode: 'dry-run', mutationCount: 0,
    sourceRows: input.plan.sourceRowCount, uniqueSources: input.plan.uniqueSourceCount, existingPilotCards: 0,
    cardsToCreate: 0, cardsToResume: 0, collectionsToCreate: 0, blockingErrors, fingerprint: null, preparedCards: [] });
  if (!await input.store.isSchemaReady()) return empty([GENERATED_LIBRARY_SCHEMA_ERROR]);
  const errors: string[] = [];
  const actor = await input.store.findActor(input.actorEmail.trim());
  if (actor === null) errors.push(`Import actor ${input.actorEmail} does not exist.`);
  else if (actor.role !== 'ai-editor') errors.push(`Import actor ${input.actorEmail} must have role ai-editor; received ${actor.role}.`);

  const assetFacts: Array<{ path: string; sha256: string }> = [];
  const portraitFacts = new Map<string, { sha256: string; revision: string }>();
  for (const row of input.plan.rows) {
    try {
      const source = await input.readBytes(row.backgroundPath);
      const sourceHash = createHash('sha256').update(source).digest('hex');
      assetFacts.push({ path: row.backgroundPath, sha256: sourceHash });
      errors.push(...await validateImage(source, row.backgroundPath, 'source'));
      if (sourceHash !== row.sourceSha256) errors.push(`Source bytes changed for ${row.backgroundPath}.`);
      const portrait = await input.readBytes(row.finalPath);
      const portraitSha256 = createHash('sha256').update(portrait).digest('hex');
      const portraitRevision = await computeImageRevision(portrait);
      assetFacts.push({ path: row.finalPath, sha256: portraitSha256 });
      portraitFacts.set(row.finalPath, { sha256: portraitSha256, revision: portraitRevision });
      errors.push(...await validateImage(portrait, row.finalPath, 'portrait'));
      if (typeof row.squarePath === 'string') {
        const square = await input.readBytes(row.squarePath);
        assetFacts.push({ path: row.squarePath, sha256: createHash('sha256').update(square).digest('hex') });
        errors.push(...await validateImage(square, row.squarePath, 'square'));
      }
    } catch (error) { errors.push(`Asset read failed for row ${row.package}:${row.id}: ${error instanceof Error ? error.message : String(error)}.`); }
  }

  const pilotRows = input.plan.rows.filter((row) => row.package === 'pilot-2026-08');
  const pilotIds = new Set<string>();
  let existingPilotCards = 0;
  const pilotState: unknown[] = [];
  for (const row of pilotRows) {
    if (pilotIds.has(row.id)) errors.push(`Pilot id ${row.id} occurs more than once.`);
    pilotIds.add(row.id);
    const cardKey = pilotCardImportKey(row.id);
    const imageKey = pilotImageImportKey(row.id);
    const card = await input.store.findPilotCardByKey(cardKey);
    const image = await input.store.findPilotImageByKey(imageKey);
    if (card !== null) existingPilotCards += 1;
    if (card === null || image === null) errors.push(`Pilot ${row.id} must have an existing card and image.`);
    else {
      if (card.imageId === null || String(card.imageId) !== String(image.id)) errors.push(`Pilot ${row.id} card/image relation does not match.`);
      const revision = portraitFacts.get(row.finalPath)?.revision;
      if (revision === undefined || image.revision !== revision) errors.push(`Pilot ${row.id} image revision does not match final JPEG.`);
    }
    pilotState.push({ cardKey, imageKey, card, image });
  }
  if (existingPilotCards !== pilotRows.length) errors.push(`Expected ${String(pilotRows.length)} existing pilot cards; found ${String(existingPilotCards)}.`);

  let collectionsToCreate = 0;
  const collectionState: unknown[] = [];
  const plannedPaths = new Set(input.seeds.collections.map(({ path }) => path));
  for (const seed of input.seeds.collections) {
    const key = sourceCollectionImportKey(seed.key);
    const byKey = await input.store.findCollectionBySourceKey(key);
    const byPath = await input.store.findCollectionByPath(seed.path);
    const claim = await input.store.findContentPathClaimByPath(seed.path);
    const parent = await input.store.findCollectionByPath(seed.parentPath);
    const related: Array<GeneratedLibraryExistingCollection | null> = [];
    for (const path of seed.relatedPaths) related.push(await input.store.findCollectionByPath(path));
    if (parent === null && !plannedPaths.has(seed.parentPath)) errors.push(`Collection ${key} references missing parent ${seed.parentPath}.`);
    seed.relatedPaths.forEach((path, index) => { if (related[index] === null && !plannedPaths.has(path)) errors.push(`Collection ${key} references missing related path ${path}.`); });
    if (byKey !== null && byKey.path !== seed.path) errors.push(`Collection ${key} changed path from ${byKey.path} to ${seed.path}.`);
    if (byKey !== null && byPath !== null && String(byKey.id) !== String(byPath.id)) errors.push(`Collection path ${seed.path} is occupied by another record.`);
    if (byKey === null && byPath !== null) errors.push(`Collection path ${seed.path} is occupied by a record without matching sourceImportKey ${key}.`);
    const claimProblem = claimError(`Collection ${key}`, seed.path, 'collections', byKey, claim);
    if (claimProblem !== null) errors.push(claimProblem);
    if (byKey === null && byPath === null) collectionsToCreate += 1;
    else if (byKey !== null) {
      errors.push(...activeManagedStatus(`Collection ${key}`, byKey));
      const expected = managedCollection(seed); const actual = actualCollection(byKey);
      for (const field of Object.keys(expected)) if (!isDeepStrictEqual(expected[field], actual[field])) errors.push(`Collection ${key} differs in managed field ${field}.`);
      const actualRelated = [...(byKey.relatedPaths ?? [])].sort(); const expectedRelated = [...seed.relatedPaths].sort();
      if (actualRelated.length > 0 && !isDeepStrictEqual(actualRelated, expectedRelated)) errors.push(`Collection ${key} differs in managed field related paths.`);
    }
    collectionState.push({ key, byKey, byPath, claim, parent, related });
  }

  let cardsToCreate = 0; let cardsToResume = 0;
  const cardState: unknown[] = [];
  for (const seed of input.seeds.cards) {
    const cardKey = sourceCardImportKey(seed.sourceSha256); const imageKey = sourceImageImportKey(seed.sourceSha256);
    const path = buildCardPath(seed.slug);
    const [card, image, slugMatch, collection, claim] = await Promise.all([input.store.findCardBySourceKey(cardKey),
      input.store.findImageBySourceKey(imageKey), input.store.findCardBySlug(seed.slug),
      input.store.findCollectionByPath(seed.collectionPath), input.store.findContentPathClaimByPath(path)]);
    if (collection === null && !plannedPaths.has(seed.collectionPath)) errors.push(`Card ${cardKey} references missing collection path ${seed.collectionPath}.`);
    if (slugMatch !== null && (card === null || String(slugMatch.id) !== String(card.id))) errors.push(`Card slug ${seed.slug} is occupied by record ${String(slugMatch.id)}.`);
    const claimProblem = claimError(`Card ${cardKey}`, path, 'cards', card, claim);
    if (claimProblem !== null) errors.push(claimProblem);
    if (card === null) cardsToCreate += 1;
    else {
      cardsToResume += 1;
      const expectedManaged: Readonly<Record<string, unknown>> = { slug: seed.slug, title: seed.title, h1: seed.h1,
        metaDescription: seed.metaDescription, alt: seed.alt, caption: seed.caption, description: seed.description,
        usageTerms: seed.usageTerms, collectionPath: seed.collectionPath, status: seed.status, robots: seed.robots };
      const actualManaged = card as unknown as Readonly<Record<string, unknown>>;
      for (const [field, expected] of Object.entries(expectedManaged)) if (!isDeepStrictEqual(actualManaged[field], expected) && !(field === 'status' && actualManaged[field] === 'review')) errors.push(`Card ${cardKey} differs in managed field ${field}.`);
      errors.push(...activeManagedStatus(`Card ${cardKey}`, card));
      if (image === null) errors.push(`Card ${cardKey} exists without managed image ${imageKey}.`);
      else if (card.imageId === null || card.imageId === undefined || String(card.imageId) !== String(image.id)) errors.push(`Card ${cardKey} differs in managed field image relation.`);
    }
    if (image !== null) {
      if (image.sourceImportKey !== imageKey) errors.push(`Image identity mismatch for ${imageKey}.`);
      const revision = portraitFacts.get(seed.sourceFile)?.revision;
      if (revision === undefined) errors.push(`Image ${imageKey} has no prepared revision.`);
      else errors.push(...await storedImageErrors(`Image ${imageKey}`, image, revision, input.store));
    }
    cardState.push({ cardKey, imageKey, card, image, slugMatch, collection, claim });
  }

  const preparedCards: GeneratedLibraryPreparedCard[] = [];
  for (const seed of input.seeds.cards) {
    const fact = portraitFacts.get(seed.sourceFile);
    if (fact !== undefined) preparedCards.push({ seed, portraitPath: seed.sourceFile, portraitSha256: fact.sha256, portraitRevision: fact.revision });
  }
  const blockingErrors = [...new Set(errors)];
  const state = { actor, assets: assetFacts.sort((left, right) => left.path.localeCompare(right.path)), cards: cardState,
    collections: collectionState, pilots: pilotState, plan: { aliases: input.plan.aliases, sourceRows: input.plan.sourceRowCount,
      uniqueSources: input.plan.uniqueSourceCount }, seeds: input.seeds };
  const reportFingerprint = blockingErrors.length === 0 && actor !== null && preparedCards.length === input.seeds.cards.length ? fingerprint(state) : null;
  return { mode: 'dry-run', mutationCount: 0, sourceRows: input.plan.sourceRowCount, uniqueSources: input.plan.uniqueSourceCount,
    existingPilotCards, cardsToCreate, cardsToResume, collectionsToCreate, blockingErrors, fingerprint: reportFingerprint,
    preparedCards: reportFingerprint === null ? [] : preparedCards };
}
