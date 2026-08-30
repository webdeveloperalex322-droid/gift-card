import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import sharp from 'sharp';

import { computeImageRevision } from '@otkritka/images';

import type {
  CardSeed,
  CollectionSeed,
  SiteContentMatrix,
} from '../../../../scripts/content-import/schema.js';
import {
  cardManagedFieldDifferences,
  collectionManagedFieldDifferences,
} from './pilot-preflight';
import type {
  ExistingCard,
  ExistingCollection,
  PilotAssetIdentity,
  PilotImportActor,
  PilotImportStore,
  PilotPreflightReport,
} from './pilot-types';

export interface PilotImportedIds {
  readonly cardIds: readonly (number | string)[];
  readonly collectionIds: readonly (number | string)[];
}

export interface PilotApplyStore extends PilotImportStore {
  createCollection(
    seed: CollectionSeed,
    parentId: number | string | null,
  ): Promise<ExistingCollection>;
  createImage(seed: CardSeed, bytes: Buffer): Promise<{ readonly id: number | string }>;
  createCard(
    seed: CardSeed,
    imageId: number | string,
    collectionId: number | string,
  ): Promise<ExistingCard>;
  moveCollectionToReview(id: number | string): Promise<ExistingCollection>;
  moveCardToReview(id: number | string): Promise<ExistingCard>;
  verifyImported(ids: PilotImportedIds): Promise<{ readonly published: number; readonly indexed: number }>;
}

export type PilotImportRecordState = 'draft' | 'review' | 'conflict' | 'error';

export interface PilotImportRecord {
  readonly key: string;
  readonly kind: 'card' | 'collection';
  readonly state: PilotImportRecordState;
  readonly detail: string;
}

export interface PilotImportReport {
  readonly mode: 'apply';
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly counts: {
    readonly collectionNodes: number;
    readonly leafTopics: number;
    readonly cards: number;
    readonly collectionsCreated: number;
    readonly cardsCreated: number;
    readonly resumed: number;
    readonly draft: number;
    readonly review: number;
    readonly published: 0;
    readonly indexed: 0;
    readonly sitemapUrlsAdded: 0;
  };
  readonly records: readonly PilotImportRecord[];
}

export interface PilotApplyInput {
  readonly actor: PilotImportActor;
  readonly assetRoot: string;
  readonly matrix: SiteContentMatrix;
  readonly preflight: PilotPreflightReport;
  readonly reportPath: string;
  readonly store: PilotApplyStore;
  readonly now?: () => Date;
}

interface WorkingRecord {
  readonly key: string;
  readonly kind: PilotImportRecord['kind'];
  readonly id: number | string;
  detail: string;
  status: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ensureSuccessfulPreflight(input: PilotApplyInput): void {
  const report = input.preflight;
  const expectedRecordKeys = new Set([
    ...input.matrix.collections.map((seed) => `collection:${seed.key}`),
    ...input.matrix.cards.map((seed) => `card:${seed.pilotId}`),
  ]);
  const actualRecordKeys = new Set(report.records.map((record) => record.key));
  const recordSetMatches =
    report.records.length === expectedRecordKeys.size &&
    actualRecordKeys.size === expectedRecordKeys.size &&
    [...actualRecordKeys].every((key) => expectedRecordKeys.has(key)) &&
    report.records.every((record) => record.state === 'create' || record.state === 'resume');
  if (
    report.mode !== 'dry-run' ||
    report.mutationCount !== 0 ||
    report.blockingErrors.length > 0 ||
    report.cards !== input.matrix.cards.length ||
    report.collectionNodes !== input.matrix.collections.length ||
    report.leafTopics !== input.matrix.collections.filter((seed) => seed.leafTopic).length ||
    report.validFiles !== input.matrix.cards.length ||
    !recordSetMatches
  ) {
    throw new Error('Pilot apply requires a successful preflight for this exact matrix and asset set.');
  }
  if (input.actor.role !== 'ai-editor' || String(input.actor.id).trim() === '') {
    throw new Error('Pilot apply requires an existing ai-editor actor; admin or fallback attribution is forbidden.');
  }
}

/** Kahn sort kept independent of matrix validation so apply cannot trust a stale graph. */
export function sortPilotCollections(seeds: readonly CollectionSeed[]): CollectionSeed[] {
  const byKey = new Map<string, CollectionSeed>();
  for (const seed of seeds) {
    if (byKey.has(seed.key)) throw new Error(`Duplicate collection key ${seed.key}.`);
    byKey.set(seed.key, seed);
  }
  for (const seed of seeds) {
    if (seed.parentKey !== null && !byKey.has(seed.parentKey)) {
      throw new Error(`Collection ${seed.key} has missing parent ${seed.parentKey}.`);
    }
  }

  const ordered: CollectionSeed[] = [];
  const remaining = new Map(byKey);
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((seed) => seed.parentKey === null || ordered.some((item) => item.key === seed.parentKey))
      .sort((left, right) => left.key.localeCompare(right.key));
    if (ready.length === 0) {
      throw new Error(`Collection graph contains a cycle: ${[...remaining.keys()].sort().join(', ')}.`);
    }
    for (const seed of ready) {
      ordered.push(seed);
      remaining.delete(seed.key);
    }
  }
  return ordered;
}

async function assetIdentity(bytes: Buffer): Promise<PilotAssetIdentity> {
  const metadata = await sharp(bytes).metadata();
  if (metadata.format !== 'jpeg' || !Number.isInteger(metadata.width) || !Number.isInteger(metadata.height)) {
    throw new Error('Preflight-approved asset no longer decodes as a JPEG with integer dimensions.');
  }
  return {
    revision: await computeImageRevision(bytes),
    mimeType: 'image/jpeg',
    width: metadata.width,
    height: metadata.height,
  };
}

function visualSignal(doc: ExistingCard): string | null {
  const matches = doc.visualDuplicateMatches ?? [];
  if (matches.length === 0) return null;
  return `pHash signal: ${matches
    .map((match) => `${String(match.id)} (distance ${String(match.distance)})`)
    .join(', ')}`;
}

function recordIndex(records: readonly PilotImportRecord[], key: string): number {
  return records.findIndex((record) => record.key === key);
}

function replaceRecord(records: PilotImportRecord[], record: PilotImportRecord): void {
  const index = recordIndex(records, record.key);
  if (index === -1) records.push(record);
  else records[index] = record;
}

async function writeReportAtomically(path: string, report: PilotImportReport): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${String(process.pid)}.${String(Date.now())}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function applyPilotContent(input: PilotApplyInput): Promise<PilotImportReport> {
  ensureSuccessfulPreflight(input);
  const orderedCollections = sortPilotCollections(input.matrix.collections);
  const startedAt = (input.now?.() ?? new Date()).toISOString();
  const collectionsByKey = new Map(input.matrix.collections.map((seed) => [seed.key, seed]));
  const collectionDocs = new Map<string, WorkingRecord>();
  const cardDocs = new Map<string, WorkingRecord>();
  const records: PilotImportRecord[] = [];
  let collectionsCreated = 0;
  let cardsCreated = 0;
  let resumed = 0;

  for (const seed of orderedCollections) {
    const key = `collection:${seed.key}`;
    const parent = seed.parentKey === null ? null : collectionDocs.get(seed.parentKey) ?? null;
    if (seed.parentKey !== null && parent === null) {
      records.push({
        key,
        kind: 'collection',
        state: 'conflict',
        detail: `parent ${seed.parentKey} is unavailable after its apply result`,
      });
      continue;
    }
    const existing = await input.store.findCollectionByPath(seed.path);
    if (existing !== null) {
      const differences = collectionManagedFieldDifferences(seed, existing, collectionsByKey);
      if (existing.status !== 'draft' && existing.status !== 'review') differences.push('status');
      if (differences.length > 0) {
        records.push({
          key,
          kind: 'collection',
          state: 'conflict',
          detail: `existing record ${String(existing.id)} differs in managed field ${differences[0]}`,
        });
        continue;
      }
      resumed += 1;
      collectionDocs.set(seed.key, {
        key,
        kind: 'collection',
        id: existing.id,
        status: existing.status,
        detail: `resumed existing ${String(existing.id)}`,
      });
      continue;
    }

    try {
      const created = await input.store.createCollection(seed, parent?.id ?? null);
      collectionsCreated += 1;
      collectionDocs.set(seed.key, {
        key,
        kind: 'collection',
        id: created.id,
        status: created.status,
        detail: `created draft ${String(created.id)}`,
      });
    } catch (error) {
      records.push({ key, kind: 'collection', state: 'error', detail: errorMessage(error) });
    }
  }

  const orderedCards = [...input.matrix.cards].sort((left, right) =>
    left.pilotId.localeCompare(right.pilotId));
  for (const seed of orderedCards) {
    const key = `card:${seed.pilotId}`;
    const collection = collectionDocs.get(seed.collectionKey);
    if (collection === undefined) {
      records.push({
        key,
        kind: 'card',
        state: 'conflict',
        detail: `collection ${seed.collectionKey} is unavailable after its apply result`,
      });
      continue;
    }

    let bytes: Buffer;
    let identity: PilotAssetIdentity;
    try {
      bytes = await readFile(join(input.assetRoot, seed.sourceFile));
      identity = await assetIdentity(bytes);
    } catch (error) {
      records.push({ key, kind: 'card', state: 'error', detail: errorMessage(error) });
      continue;
    }

    const existing = await input.store.findCardBySlug(seed.slug);
    if (existing !== null) {
      const differences = cardManagedFieldDifferences(seed, existing, collectionsByKey, identity);
      if (existing.status !== 'draft' && existing.status !== 'review') differences.push('status');
      if (differences.length > 0) {
        records.push({
          key,
          kind: 'card',
          state: 'conflict',
          detail: `existing record ${String(existing.id)} differs in managed field ${differences[0]}`,
        });
        continue;
      }
      resumed += 1;
      cardDocs.set(seed.pilotId, {
        key,
        kind: 'card',
        id: existing.id,
        status: existing.status,
        detail: [
          `resumed existing ${String(existing.id)}`,
          visualSignal(existing),
        ].filter((value): value is string => value !== null).join('; '),
      });
      continue;
    }

    let imageId: number | string | null = null;
    try {
      const image = await input.store.createImage(seed, bytes);
      imageId = image.id;
      const created = await input.store.createCard(seed, image.id, collection.id);
      cardsCreated += 1;
      cardDocs.set(seed.pilotId, {
        key,
        kind: 'card',
        id: created.id,
        status: created.status,
        detail: [
          `created draft ${String(created.id)}`,
          visualSignal(created),
        ].filter((value): value is string => value !== null).join('; '),
      });
    } catch (error) {
      const message = errorMessage(error);
      let failureState = '';
      if (imageId !== null) {
        try {
          const afterFailure = await input.store.findCardBySlug(seed.slug);
          failureState = afterFailure === null
            ? '; post-failure lookup found no card with the pilot slug, so the image is unlinked'
            : `; post-failure lookup found card ${String(afterFailure.id)} in ${afterFailure.status}; the image link must be inspected`;
        } catch (lookupError) {
          failureState = `; post-failure card lookup failed: ${errorMessage(lookupError)}`;
        }
      }
      records.push({
        key,
        kind: 'card',
        state: 'error',
        detail: imageId === null
          ? message
          : `${message}; uploaded image ${String(imageId)} remains${failureState}; it was not deleted`,
      });
    }
  }

  // Cards are promoted first so every later card is scanned against earlier
  // review candidates by the server pHash hook. No signal is auto-approved.
  for (const item of cardDocs.values()) {
    if (item.status === 'review') {
      records.push({ key: item.key, kind: item.kind, state: 'review', detail: item.detail });
      continue;
    }
    try {
      const moved = await input.store.moveCardToReview(item.id);
      if (moved.status !== 'review') throw new Error(`review update returned status ${moved.status}`);
      item.status = moved.status;
      const signal = visualSignal(moved);
      records.push({
        key: item.key,
        kind: item.kind,
        state: 'review',
        detail: [item.detail, signal].filter((value): value is string => value !== null).join('; '),
      });
    } catch (error) {
      replaceRecord(records, {
        key: item.key,
        kind: item.kind,
        state: 'draft',
        detail: `${item.detail.replace(/^.*?; (?=pHash signal:)/u, '')}; review refused: ${errorMessage(error)}`,
      });
    }
  }

  for (const item of collectionDocs.values()) {
    if (item.status === 'review') {
      records.push({ key: item.key, kind: item.kind, state: 'review', detail: item.detail });
      continue;
    }
    try {
      const moved = await input.store.moveCollectionToReview(item.id);
      if (moved.status !== 'review') throw new Error(`review update returned status ${moved.status}`);
      item.status = moved.status;
      records.push({ key: item.key, kind: item.kind, state: 'review', detail: item.detail });
    } catch (error) {
      records.push({
        key: item.key,
        kind: item.kind,
        state: 'draft',
        detail: `${item.detail}; review refused: ${errorMessage(error)}`,
      });
    }
  }

  const importedIds: PilotImportedIds = {
    cardIds: [...cardDocs.values()].map((item) => item.id),
    collectionIds: [...collectionDocs.values()].map((item) => item.id),
  };
  const verified = await input.store.verifyImported(importedIds);
  if (verified.published !== 0 || verified.indexed !== 0) {
    throw new Error(
      `Pilot invariant failed before report write: published=${String(verified.published)}, indexed=${String(verified.indexed)}.`,
    );
  }

  records.sort((left, right) => left.key.localeCompare(right.key));
  const report: PilotImportReport = {
    mode: 'apply',
    startedAt,
    finishedAt: (input.now?.() ?? new Date()).toISOString(),
    counts: {
      collectionNodes: input.matrix.collections.length,
      leafTopics: input.matrix.collections.filter((seed) => seed.leafTopic).length,
      cards: input.matrix.cards.length,
      collectionsCreated,
      cardsCreated,
      resumed,
      draft: records.filter((record) => record.state === 'draft').length,
      review: records.filter((record) => record.state === 'review').length,
      published: 0,
      indexed: 0,
      sitemapUrlsAdded: 0,
    },
    records,
  };
  await writeReportAtomically(input.reportPath, report);
  return report;
}
