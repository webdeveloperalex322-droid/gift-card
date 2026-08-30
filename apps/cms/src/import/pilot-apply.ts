import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import sharp from 'sharp';

import { computeImageRevision } from '@otkritka/images';
import type { CardRecord } from '../../../../scripts/content-pilot/manifest.mjs';

import type {
  CardSeed,
  CollectionSeed,
  SiteContentMatrix,
} from '../../../../scripts/content-import/schema.js';
import {
  cardManagedFieldDifferences,
  collectionManagedFieldDifferences,
  runPilotPreflight,
} from './pilot-preflight';
import { pilotCardImportKey, pilotImageImportKey } from './pilot-import-identity';
import type {
  ExistingCard,
  ExistingCollection,
  ExistingImage,
  PilotAssetIdentity,
  PilotImportActor,
  PilotImportStore,
  PilotPreflightReport,
} from './pilot-types';

export interface PilotVerificationExpected {
  readonly cards: readonly { readonly key: string; readonly id: number | string | null }[];
  readonly collections: readonly { readonly path: string; readonly id: number | string | null }[];
  readonly images: readonly { readonly key: string; readonly id: number | string | null }[];
}

export interface PilotVerificationSnapshot {
  readonly cards: readonly { readonly key: string | null; readonly id: number | string; readonly status: string; readonly robots: string }[];
  readonly collections: readonly { readonly path: string; readonly id: number | string; readonly status: string; readonly robots: string }[];
  readonly images: readonly { readonly key: string | null; readonly id: number | string }[];
}

export interface PilotApplyStore extends PilotImportStore {
  createCollection(
    seed: CollectionSeed,
    parentId: number | string | null,
  ): Promise<ExistingCollection>;
  createImage(seed: CardSeed, bytes: Buffer): Promise<ExistingImage>;
  createCard(
    seed: CardSeed,
    imageId: number | string,
    collectionId: number | string,
  ): Promise<ExistingCard>;
  moveCollectionToReview(id: number | string, expectedUpdatedAt: string): Promise<ExistingCollection | null>;
  moveCardToReview(id: number | string, expectedUpdatedAt: string): Promise<ExistingCard | null>;
  verifyImported(expected: PilotVerificationExpected): Promise<PilotVerificationSnapshot>;
}

export type PilotImportRecordState = 'draft' | 'review' | 'conflict' | 'error';

export interface PilotImportRecord {
  readonly key: string;
  readonly kind: 'card' | 'collection';
  readonly state: PilotImportRecordState;
  readonly detail: string;
  readonly id?: number | string;
  readonly stableKey?: string;
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
    readonly published: number;
    readonly indexed: number;
    readonly sitemapUrlsAdded: number;
  };
  readonly records: readonly PilotImportRecord[];
}

export interface PilotApplyInput {
  readonly actor: PilotImportActor;
  readonly assetRoot: string;
  readonly actorEmail: string;
  readonly manifest: readonly CardRecord[];
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
  updatedAt: string;
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

async function assetIdentity(bytes: Buffer, path: string): Promise<PilotAssetIdentity> {
  const metadata = await sharp(bytes).metadata();
  if (metadata.format !== 'jpeg' || !Number.isInteger(metadata.width) || !Number.isInteger(metadata.height)) {
    throw new Error('Preflight-approved asset no longer decodes as a JPEG with integer dimensions.');
  }
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    revision: await computeImageRevision(bytes),
    mimeType: 'image/jpeg',
    format: 'jpeg',
    width: metadata.width,
    height: metadata.height,
    ratio: '4:5',
    path,
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

const reportWriteQueues = new Map<string, Promise<void>>();

async function writePilotImportReportOnce(path: string, report: PilotImportReport): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function writePilotImportReportAtomically(
  path: string,
  report: PilotImportReport,
): Promise<void> {
  const previous = reportWriteQueues.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => writePilotImportReportOnce(path, report));
  reportWriteQueues.set(path, current);
  try {
    await current;
  } finally {
    if (reportWriteQueues.get(path) === current) reportWriteQueues.delete(path);
  }
}

export async function applyPilotContent(input: PilotApplyInput): Promise<PilotImportReport> {
  ensureSuccessfulPreflight(input);
  const resolvedActor = await input.store.findActor(input.actorEmail);
  if (resolvedActor === null || String(resolvedActor.id) !== String(input.actor.id) ||
      resolvedActor.role !== 'ai-editor' ||
      (input.actor.email !== undefined && input.actor.email !== input.actorEmail)) {
    throw new Error('Pilot apply actor no longer matches the ai-editor bound by preflight.');
  }
  const refreshed = await runPilotPreflight({
    actorEmail: input.actorEmail,
    assetRoot: input.assetRoot,
    manifest: input.manifest,
    matrix: input.matrix,
    store: input.store,
  });
  if (refreshed.blockingErrors.length > 0 || refreshed.fingerprint === null ||
      refreshed.fingerprint !== input.preflight.fingerprint) {
    throw new Error('Pilot inputs or managed CMS state changed after preflight; apply performed zero mutations.');
  }
  const orderedCollections = sortPilotCollections(input.matrix.collections);
  const startedAt = (input.now?.() ?? new Date()).toISOString();
  const collectionsByKey = new Map(input.matrix.collections.map((seed) => [seed.key, seed]));
  const collectionDocs = new Map<string, WorkingRecord>();
  const cardDocs = new Map<string, WorkingRecord>();
  const imageDocs = new Map<string, { readonly id: number | string; readonly key: string }>();
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
        updatedAt: existing.updatedAt ?? '',
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
        updatedAt: created.updatedAt ?? '',
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
      const sourcePath = join(input.assetRoot, seed.sourceFile);
      bytes = await readFile(sourcePath);
      identity = await assetIdentity(bytes, sourcePath);
    } catch (error) {
      records.push({ key, kind: 'card', state: 'error', detail: errorMessage(error) });
      continue;
    }

    const importKey = pilotCardImportKey(seed.pilotId);
    const imageImportKey = pilotImageImportKey(seed.pilotId);
    const [existing, slugMatch] = await Promise.all([
      input.store.findCardByPilotImportKey(importKey),
      input.store.findCardBySlug(seed.slug),
    ]);
    if (slugMatch !== null && (existing === null || String(slugMatch.id) !== String(existing.id))) {
      records.push({
        key,
        kind: 'card',
        state: 'conflict',
        detail: `pilot slug is occupied by card ${String(slugMatch.id)} with another import identity`,
      });
      continue;
    }
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
        updatedAt: existing.updatedAt ?? '',
      });
      if (existing.imageId !== null && existing.imageId !== undefined) {
        imageDocs.set(seed.pilotId, { id: existing.imageId, key: imageImportKey });
      }
      continue;
    }

    let imageId: number | string | null = null;
    try {
      const existingImage = await input.store.findImageByPilotImportKey(imageImportKey);
      const image = existingImage ?? await input.store.createImage(seed, bytes);
      imageId = image.id;
      imageDocs.set(seed.pilotId, { id: image.id, key: imageImportKey });
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
        updatedAt: created.updatedAt ?? '',
      });
    } catch (error) {
      const message = errorMessage(error);
      let failureState = '';
      if (imageId !== null) {
        try {
          const afterFailure = await input.store.findCardByPilotImportKey(importKey);
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
      const moved = await input.store.moveCardToReview(item.id, item.updatedAt);
      if (moved === null) throw new Error('concurrent update detected; conditional review update matched zero records');
      if (moved.status !== 'review') throw new Error(`review update returned status ${moved.status}`);
      item.status = moved.status;
      item.updatedAt = moved.updatedAt ?? item.updatedAt;
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
      const moved = await input.store.moveCollectionToReview(item.id, item.updatedAt);
      if (moved === null) throw new Error('concurrent update detected; conditional review update matched zero records');
      if (moved.status !== 'review') throw new Error(`review update returned status ${moved.status}`);
      item.status = moved.status;
      item.updatedAt = moved.updatedAt ?? item.updatedAt;
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

  const expected: PilotVerificationExpected = {
    cards: input.matrix.cards.map((seed) => ({
      key: pilotCardImportKey(seed.pilotId),
      id: cardDocs.get(seed.pilotId)?.id ?? null,
    })),
    collections: input.matrix.collections.map((seed) => ({
      path: seed.path,
      id: collectionDocs.get(seed.key)?.id ?? null,
    })),
    images: input.matrix.cards.map((seed) => ({
      key: pilotImageImportKey(seed.pilotId),
      id: imageDocs.get(seed.pilotId)?.id ?? null,
    })),
  };
  const verified = await input.store.verifyImported(expected);
  const verifyUnique = <T>(values: readonly T[], label: string): void => {
    if (new Set(values.map(String)).size !== values.length) throw new Error(`Pilot verification found ambiguous ${label}.`);
  };
  verifyUnique(verified.cards.map((doc) => doc.key), 'card import keys');
  verifyUnique(verified.collections.map((doc) => doc.path), 'collection paths');
  verifyUnique(verified.images.map((doc) => doc.key), 'image import keys');
  const missing = [
    ...expected.cards.filter((item) => verified.cards.filter((doc) => doc.key === item.key &&
      (item.id === null || String(doc.id) === String(item.id))).length !== 1).map((item) => item.key),
    ...expected.collections.filter((item) => verified.collections.filter((doc) => doc.path === item.path &&
      (item.id === null || String(doc.id) === String(item.id))).length !== 1).map((item) => item.path),
    ...expected.images.filter((item) => verified.images.filter((doc) => doc.key === item.key &&
      (item.id === null || String(doc.id) === String(item.id))).length !== 1).map((item) => item.key),
  ];
  if (missing.length > 0 || verified.cards.length !== 50 || verified.collections.length !== 13 ||
      verified.images.length !== 50) {
    throw new Error(`Pilot verification vetoed report: missing or ambiguous expected records: ${missing.join(', ') || 'count mismatch'}.`);
  }
  const contentDocs = [...verified.cards, ...verified.collections];
  const published = contentDocs.filter((doc) => doc.status === 'published').length;
  const indexed = contentDocs.filter((doc) => doc.robots === 'index,follow').length;
  const sitemapUrlsAdded = contentDocs.filter((doc) =>
    doc.status === 'published' && doc.robots === 'index,follow').length;
  const invalidState = contentDocs.filter((doc) =>
    (doc.status !== 'draft' && doc.status !== 'review') || doc.robots !== 'noindex,follow');
  if (published !== 0 || indexed !== 0 || sitemapUrlsAdded !== 0 || invalidState.length > 0) {
    throw new Error(`Pilot invariant failed before report write: published=${String(published)}, indexed=${String(indexed)}.`);
  }

  records.sort((left, right) => left.key.localeCompare(right.key));
  const mappedRecords = records.map((record): PilotImportRecord => {
    if (record.kind === 'card') {
      const pilotId = record.key.slice('card:'.length);
      const stableKey = pilotCardImportKey(pilotId);
      const doc = verified.cards.find((item) => item.key === stableKey);
      if (doc === undefined) throw new Error(`Pilot verification lost ${record.key}.`);
      return { ...record, id: doc.id, stableKey };
    }
    const seed = input.matrix.collections.find((item) => `collection:${item.key}` === record.key);
    const doc = seed === undefined ? undefined : verified.collections.find((item) => item.path === seed.path);
    if (seed === undefined || doc === undefined) throw new Error(`Pilot verification lost ${record.key}.`);
    return { ...record, id: doc.id, stableKey: seed.path };
  });
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
      draft: contentDocs.filter((doc) => doc.status === 'draft').length,
      review: contentDocs.filter((doc) => doc.status === 'review').length,
      published,
      indexed,
      sitemapUrlsAdded,
    },
    records: mappedRecords,
  };
  await writePilotImportReportAtomically(input.reportPath, report);
  return report;
}
