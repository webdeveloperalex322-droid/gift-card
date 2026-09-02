import { createHash } from 'node:crypto';

import sharp from 'sharp';
import { computeImageRevision } from '@otkritka/images';

import type { GeneratedLibraryPlan } from './library-manifest';
import type { GeneratedCardSeed, GeneratedLibrarySeeds } from './library-seeds';
import { pilotCardImportKey } from './pilot-import-identity';
import { sourceCardImportKey, sourceCollectionImportKey, sourceImageImportKey } from './source-import-identity';

export interface GeneratedLibraryActor {
  readonly id: number | string;
  readonly email: string;
  readonly role: string;
}

export interface GeneratedLibraryExistingCard {
  readonly id: number | string;
  readonly sourceImportKey: string | null;
  readonly slug: string;
  readonly status: string;
  readonly robots: string;
  readonly imageId?: number | string | null;
  readonly collectionPath?: string | null;
  readonly title?: string | null;
  readonly h1?: string | null;
  readonly metaDescription?: string | null;
  readonly alt?: string | null;
  readonly caption?: string | null;
  readonly description?: string | null;
  readonly usageTerms?: string | null;
}

export interface GeneratedLibraryExistingImage {
  readonly id: number | string;
  readonly sourceImportKey: string | null;
  readonly revision?: string | null;
}

export interface GeneratedLibraryExistingCollection {
  readonly id: number | string;
  readonly sourceImportKey?: string | null;
  readonly path: string;
  readonly status: string;
  readonly robots: string;
}

export interface GeneratedLibraryReadStore {
  findActor(email: string): Promise<GeneratedLibraryActor | null>;
  findPilotCardByKey(key: string): Promise<{ readonly id: number | string } | null>;
  findCollectionByPath(path: string): Promise<GeneratedLibraryExistingCollection | null>;
  findCollectionBySourceKey(key: string): Promise<GeneratedLibraryExistingCollection | null>;
  findCardBySourceKey(key: string): Promise<GeneratedLibraryExistingCard | null>;
  findImageBySourceKey(key: string): Promise<GeneratedLibraryExistingImage | null>;
  findCardBySlug(slug: string): Promise<GeneratedLibraryExistingCard | null>;
}

export interface GeneratedLibraryPreflightInput {
  readonly actorEmail: string;
  readonly plan: GeneratedLibraryPlan;
  readonly seeds: GeneratedLibrarySeeds;
  readonly store: GeneratedLibraryReadStore;
  readonly readBytes: (path: string) => Promise<Buffer>;
}

export interface GeneratedLibraryPreparedCard {
  readonly seed: GeneratedCardSeed;
  readonly portraitPath: string;
  readonly portraitSha256: string;
  readonly portraitRevision: string;
}

export interface GeneratedLibraryPreflightReport {
  readonly mode: 'dry-run';
  readonly mutationCount: 0;
  readonly sourceRows: number;
  readonly uniqueSources: number;
  readonly existingPilotCards: number;
  readonly cardsToCreate: number;
  readonly cardsToResume: number;
  readonly collectionsToCreate: number;
  readonly blockingErrors: readonly string[];
  readonly fingerprint: string | null;
  readonly preparedCards: readonly GeneratedLibraryPreparedCard[];
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stable(child)]));
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

async function validateImage(bytes: Buffer, path: string, shape: 'portrait' | 'square' | 'source'): Promise<string[]> {
  try {
    const metadata = await sharp(bytes).metadata();
    const errors: string[] = [];
    const expectedFormat = shape === 'source' ? 'png' : 'jpeg';
    if (metadata.format !== expectedFormat) errors.push(`${path} must be ${expectedFormat.toUpperCase()}.`);
    const { width, height } = metadata;
    if (width === undefined || height === undefined || width < 640 || height < 640) {
      errors.push(`${path} must have readable dimensions of at least 640px.`);
    } else if (shape === 'portrait' && width * 5 !== height * 4) {
      errors.push(`${path} must have exact 4:5 portrait ratio.`);
    } else if (shape === 'square' && width !== height) {
      errors.push(`${path} must be square.`);
    }
    return errors;
  } catch (error) {
    return [`${path} cannot be decoded: ${error instanceof Error ? error.message : String(error)}.`];
  }
}

function activeManagedStatus(label: string, value: { status: string; robots: string }): string[] {
  const errors: string[] = [];
  if (value.status !== 'draft' && value.status !== 'review') errors.push(`${label} must remain draft or review; received ${value.status}.`);
  if (value.robots !== 'noindex,follow') errors.push(`${label} must remain noindex,follow; received ${value.robots}.`);
  return errors;
}

export async function runGeneratedLibraryPreflight(input: GeneratedLibraryPreflightInput): Promise<GeneratedLibraryPreflightReport> {
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
    } catch (error) {
      errors.push(`Asset read failed for row ${row.package}:${row.id}: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  const pilotRows = input.plan.rows.filter((row) => row.package === 'pilot-2026-08');
  const pilotMatches = await Promise.all(pilotRows.map((row) => input.store.findPilotCardByKey(pilotCardImportKey(row.id))));
  const existingPilotCards = pilotMatches.filter((value) => value !== null).length;
  if (existingPilotCards !== pilotRows.length) errors.push(`Expected ${String(pilotRows.length)} existing pilot cards; found ${String(existingPilotCards)}.`);

  let collectionsToCreate = 0;
  const collectionState: unknown[] = [];
  for (const seed of input.seeds.collections) {
    const key = sourceCollectionImportKey(seed.key);
    const [byKey, byPath] = await Promise.all([
      input.store.findCollectionBySourceKey(key),
      input.store.findCollectionByPath(seed.path),
    ]);
    if (byKey !== null && byKey.path !== seed.path) errors.push(`Collection ${key} changed path from ${byKey.path} to ${seed.path}.`);
    if (byKey !== null && byPath !== null && String(byKey.id) !== String(byPath.id)) errors.push(`Collection path ${seed.path} is occupied by another record.`);
    if (byKey === null && byPath !== null) {
      errors.push(`Collection path ${seed.path} is occupied by a record without matching sourceImportKey ${key}.`);
    }
    if (byKey === null && byPath === null) collectionsToCreate += 1;
    else if (byKey !== null) errors.push(...activeManagedStatus(`Collection ${key}`, byKey));
    collectionState.push({ key, byKey, byPath });
  }

  let cardsToCreate = 0;
  let cardsToResume = 0;
  const cardState: unknown[] = [];
  for (const seed of input.seeds.cards) {
    const cardKey = sourceCardImportKey(seed.sourceSha256);
    const imageKey = sourceImageImportKey(seed.sourceSha256);
    const [card, image, slugMatch, collection] = await Promise.all([
      input.store.findCardBySourceKey(cardKey),
      input.store.findImageBySourceKey(imageKey),
      input.store.findCardBySlug(seed.slug),
      input.store.findCollectionByPath(seed.collectionPath),
    ]);
    if (collection === null && !input.seeds.collections.some(({ path }) => path === seed.collectionPath)) {
      errors.push(`Card ${cardKey} references missing collection path ${seed.collectionPath}.`);
    }
    if (slugMatch !== null && (card === null || String(slugMatch.id) !== String(card.id))) {
      errors.push(`Card slug ${seed.slug} is occupied by record ${String(slugMatch.id)}.`);
    }
    if (card === null) cardsToCreate += 1;
    else {
      cardsToResume += 1;
      const expectedManaged: Readonly<Record<string, unknown>> = {
        slug: seed.slug,
        title: seed.title,
        h1: seed.h1,
        metaDescription: seed.metaDescription,
        alt: seed.alt,
        caption: seed.caption,
        description: seed.description,
        usageTerms: seed.usageTerms,
        collectionPath: seed.collectionPath,
        status: seed.status,
        robots: seed.robots,
      };
      const actualManaged = card as unknown as Readonly<Record<string, unknown>>;
      for (const [field, expected] of Object.entries(expectedManaged)) {
        if (actualManaged[field] !== expected && !(field === 'status' && actualManaged[field] === 'review')) {
          errors.push(`Card ${cardKey} differs in managed field ${field}.`);
        }
      }
      errors.push(...activeManagedStatus(`Card ${cardKey}`, card));
      if (image === null) errors.push(`Card ${cardKey} exists without managed image ${imageKey}.`);
      else if (card.imageId === null || card.imageId === undefined || String(card.imageId) !== String(image.id)) {
        errors.push(`Card ${cardKey} differs in managed field image relation.`);
      }
    }
    if (image !== null) {
      if (image.sourceImportKey !== imageKey) errors.push(`Image identity mismatch for ${imageKey}.`);
      const expectedRevision = portraitFacts.get(seed.sourceFile)?.revision;
      if (expectedRevision === undefined || image.revision !== expectedRevision) {
        errors.push(`Image ${imageKey} differs in managed field revision.`);
      }
    }
    cardState.push({ cardKey, imageKey, card, image, slugMatch, collection });
  }

  const preparedCards: GeneratedLibraryPreparedCard[] = [];
  for (const seed of input.seeds.cards) {
    const fact = portraitFacts.get(seed.sourceFile);
    if (fact !== undefined) {
      preparedCards.push({
        seed,
        portraitPath: seed.sourceFile,
        portraitSha256: fact.sha256,
        portraitRevision: fact.revision,
      });
    }
  }

  const blockingErrors = [...new Set(errors)];
  const state = {
    actor,
    assets: assetFacts.sort((left, right) => left.path.localeCompare(right.path)),
    cards: cardState,
    collections: collectionState,
    plan: {
      aliases: input.plan.aliases,
      sourceRows: input.plan.sourceRowCount,
      uniqueSources: input.plan.uniqueSourceCount,
    },
    seeds: input.seeds,
  };
  const reportFingerprint = blockingErrors.length === 0 && actor !== null &&
      preparedCards.length === input.seeds.cards.length
    ? fingerprint(state)
    : null;
  return {
    mode: 'dry-run', mutationCount: 0,
    sourceRows: input.plan.sourceRowCount,
    uniqueSources: input.plan.uniqueSourceCount,
    existingPilotCards,
    cardsToCreate,
    cardsToResume,
    collectionsToCreate,
    blockingErrors,
    fingerprint: reportFingerprint,
    preparedCards: reportFingerprint === null ? [] : preparedCards,
  };
}
