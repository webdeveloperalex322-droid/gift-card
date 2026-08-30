import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import type { Payload } from 'payload';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { computeImageRevision } from '@otkritka/images';

import {
  loadSiteContent,
  type CardSeed,
  type CollectionSeed,
  type SiteContentMatrix,
} from '../../../../scripts/content-import/schema.js';
import {
  applyPilotContent,
  sortPilotCollections,
  type PilotApplyStore,
  type PilotImportedIds,
} from './pilot-apply';
import type {
  ExistingCard,
  ExistingCollection,
  PilotImportActor,
  PilotPreflightReport,
} from './pilot-types';
import { pilotIntroDocument } from './pilot-types';
import { createPayloadPilotApplyStore } from '../../scripts/import-pilot-content';
import type { Card, CardImage, Collection, User } from '../payload-types';

const temporaryPaths: string[] = [];
let matrix: SiteContentMatrix;
let jpeg: Buffer;
let revision: string;

beforeAll(async () => {
  matrix = await loadSiteContent('content/pilot-2026-08/site-content.json');
  jpeg = await sharp({
    create: { width: 1024, height: 1280, channels: 3, background: '#d7cab9' },
  }).jpeg().toBuffer();
  revision = await computeImageRevision(jpeg);
});

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function paths(): Promise<{ assetRoot: string; reportPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'otkritka-pilot-apply-'));
  temporaryPaths.push(root);
  const assetRoot = join(root, 'assets');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(assetRoot));
  await Promise.all(matrix.cards.map((card) => writeFile(join(assetRoot, card.sourceFile), jpeg)));
  return { assetRoot, reportPath: join(root, 'import-report.json') };
}

const actor: PilotImportActor = { id: 91, role: 'ai-editor' };

function successfulPreflight(): PilotPreflightReport {
  return {
    mode: 'dry-run',
    blockingErrors: [],
    cards: 50,
    collectionNodes: 13,
    leafTopics: 10,
    mutationCount: 0,
    records: [
      ...matrix.collections.map((seed) => ({
        key: `collection:${seed.key}`,
        kind: 'collection' as const,
        path: seed.path,
        state: 'create' as const,
        detail: 'validated creation candidate',
      })),
      ...matrix.cards.map((seed) => ({
        key: `card:${seed.pilotId}`,
        kind: 'card' as const,
        path: `/otkrytki/${seed.slug}`,
        state: 'create' as const,
        detail: 'validated creation candidate',
      })),
    ],
    resumed: 0,
    validFiles: 50,
  };
}

interface StatefulStore extends PilotApplyStore {
  readonly cards: Map<string, ExistingCard>;
  readonly collections: Map<string, ExistingCollection>;
  readonly createdImages: Array<{ id: string; sourceFile: string }>;
  readonly deleted: string[];
  failUploadFor: string | null;
  failCardCreateFor: string | null;
  pHashSignalFor: string | null;
}

function statefulStore(): StatefulStore {
  const cards = new Map<string, ExistingCard>();
  const collections = new Map<string, ExistingCollection>();
  const images = new Map<string, { id: string; sourceFile: string }>();
  let nextImage = 1;
  const store: StatefulStore = {
    cards,
    collections,
    createdImages: [],
    deleted: [],
    failUploadFor: null,
    failCardCreateFor: null,
    pHashSignalFor: null,
    findActor() {
      return Promise.resolve(actor);
    },
    findCardBySlug(slug) {
      return Promise.resolve(cards.get(slug) ?? null);
    },
    findCollectionByPath(path) {
      return Promise.resolve(collections.get(path) ?? null);
    },
    findContentPathClaimByPath() {
      return Promise.resolve(null);
    },
    createCollection(seed, parentId) {
      const parentPath = seed.parentKey === null
        ? null
        : [...collections.values()].find((item) => String(item.id) === String(parentId))?.path ?? null;
      const result: ExistingCollection = {
        id: `collection-${seed.key}`,
        description: seed.description,
        h1: seed.h1,
        intro: pilotIntroDocument(seed.intro),
        metaDescription: seed.metaDescription,
        nodeKind: seed.nodeKind,
        parentPath,
        path: seed.path,
        pathClaimKey: `pilot-collection-${seed.key}`,
        robots: seed.robots,
        slug: seed.slug,
        status: 'draft',
        title: seed.title,
      };
      collections.set(seed.path, result);
      return Promise.resolve(result);
    },
    createImage(seed) {
      if (store.failUploadFor === seed.pilotId) {
        throw new Error(`upload refused for ${seed.pilotId}`);
      }
      const image = { id: `image-${String(nextImage++)}`, sourceFile: seed.sourceFile };
      images.set(String(image.id), image);
      store.createdImages.push(image);
      return Promise.resolve({ id: image.id });
    },
    createCard(seed, imageId, collectionId) {
      if (store.failCardCreateFor === seed.pilotId) {
        throw new Error(`card create refused for ${seed.pilotId}`);
      }
      const collection = [...collections.values()].find((item) => String(item.id) === String(collectionId));
      const image = images.get(String(imageId));
      if (!collection || !image) throw new Error('Fake relation missing.');
      const result = existingCard(seed, collection.path);
      if (store.pHashSignalFor === seed.pilotId) {
        result.visualDuplicateMatches = [{ id: 'published-card-7', distance: 4 }];
      }
      cards.set(seed.slug, result);
      return Promise.resolve(result);
    },
    moveCollectionToReview(id) {
      const existing = [...collections.values()].find((item) => String(item.id) === String(id));
      if (!existing) throw new Error(`Collection ${String(id)} missing.`);
      existing.status = 'review';
      return Promise.resolve(existing);
    },
    moveCardToReview(id) {
      const existing = [...cards.values()].find((item) => String(item.id) === String(id));
      if (!existing) throw new Error(`Card ${String(id)} missing.`);
      if ((existing.visualDuplicateMatches?.length ?? 0) > 0) {
        throw new Error('визуально похоже на опубликованную открытку #published-card-7');
      }
      existing.status = 'review';
      return Promise.resolve(existing);
    },
    verifyImported(ids) {
      return Promise.resolve(verifyState(ids, cards, collections));
    },
  };
  return store;
}

function verifyState(
  ids: PilotImportedIds,
  cards: ReadonlyMap<string, ExistingCard>,
  collections: ReadonlyMap<string, ExistingCollection>,
): { published: number; indexed: number } {
  const selected = [
    ...[...cards.values()].filter((doc) => ids.cardIds.some((id) => String(id) === String(doc.id))),
    ...[...collections.values()].filter((doc) => ids.collectionIds.some((id) => String(id) === String(doc.id))),
  ];
  return {
    published: selected.filter((doc) => doc.status === 'published').length,
    indexed: selected.filter((doc) => doc.robots === 'index,follow').length,
  };
}

function existingCard(seed: CardSeed, collectionPath: string): ExistingCard {
  return {
    id: `card-${seed.pilotId}`,
    alt: seed.alt,
    caption: seed.caption,
    collectionPaths: [collectionPath],
    description: seed.description,
    h1: seed.h1,
    imageAssignedFilename: seed.sourceFile,
    imageHeight: 1280,
    imageMimeType: 'image/jpeg',
    imageRevision: revision,
    imageWidth: 1024,
    metaDescription: seed.metaDescription,
    pathClaimKey: `pilot-card-${seed.pilotId}`,
    robots: seed.robots,
    slug: seed.slug,
    status: 'draft',
    title: seed.title,
    usageTerms: seed.usageTerms,
    visualDuplicateMatches: [],
  };
}

function applyInput(store: PilotApplyStore, path: { assetRoot: string; reportPath: string }) {
  return {
    actor,
    assetRoot: path.assetRoot,
    matrix,
    preflight: successfulPreflight(),
    reportPath: path.reportPath,
    store,
  };
}

describe('pilot apply', () => {
  it('creates all drafts through the store, promotes them individually, and resumes without duplicate images', async () => {
    const path = await paths();
    const store = statefulStore();

    const first = await applyPilotContent(applyInput(store, path));
    expect(first.counts).toMatchObject({
      cardsCreated: 50,
      collectionsCreated: 13,
      published: 0,
      indexed: 0,
      review: 63,
    });
    expect(store.createdImages).toHaveLength(50);

    const second = await applyPilotContent(applyInput(store, path));
    expect(second.counts).toMatchObject({
      cardsCreated: 0,
      collectionsCreated: 0,
      resumed: 63,
      published: 0,
      indexed: 0,
      review: 63,
    });
    expect(store.createdImages).toHaveLength(50);
    expect(store.deleted).toEqual([]);
    expect(JSON.parse(await readFile(path.reportPath, 'utf8'))).toEqual(second);
    expect((await readdir(join(path.reportPath, '..'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses any mutation unless the preflight succeeded and the actor is a real ai-editor', async () => {
    const path = await paths();
    const store = statefulStore();
    const blocked = { ...successfulPreflight(), blockingErrors: ['managed drift'] };

    await expect(applyPilotContent({ ...applyInput(store, path), preflight: blocked })).rejects.toThrow(
      /successful preflight/i,
    );
    const inconsistent = successfulPreflight();
    const firstRecord = inconsistent.records[0];
    if (!firstRecord) throw new Error('Expected preflight records.');
    await expect(applyPilotContent({
      ...applyInput(store, path),
      preflight: {
        ...inconsistent,
        records: [{ ...firstRecord, state: 'blocked' }, ...inconsistent.records.slice(1)],
      },
    })).rejects.toThrow(/successful preflight/i);
    await expect(applyPilotContent({
      ...applyInput(store, path),
      actor: { id: 1, role: 'admin' },
    })).rejects.toThrow(/ai-editor/i);
    expect(store.collections).toHaveLength(0);
    expect(store.cards).toHaveLength(0);
    expect(store.createdImages).toHaveLength(0);
  });

  it('continues after one upload failure and leaves all other correct records intact', async () => {
    const path = await paths();
    const store = statefulStore();
    store.failUploadFor = '07';

    const report = await applyPilotContent(applyInput(store, path));

    expect(report.counts).toMatchObject({ cardsCreated: 49, collectionsCreated: 13, review: 62 });
    expect(report.records).toContainEqual({
      key: 'card:07',
      kind: 'card',
      state: 'error',
      detail: 'upload refused for 07',
    });
    expect(store.cards).toHaveLength(49);
    expect(store.createdImages).toHaveLength(49);
    expect(store.deleted).toEqual([]);
  });

  it('reports an orphan upload exactly when card creation fails and never deletes it or prior drafts', async () => {
    const path = await paths();
    const store = statefulStore();
    store.failCardCreateFor = '08';

    const report = await applyPilotContent(applyInput(store, path));

    expect(report.records.find((record) => record.key === 'card:08')).toEqual({
      key: 'card:08',
      kind: 'card',
      state: 'error',
      detail: 'card create refused for 08; uploaded image image-8 remains; post-failure lookup found no card with the pilot slug, so the image is unlinked; it was not deleted',
    });
    expect(store.createdImages).toHaveLength(50);
    expect(store.cards).toHaveLength(49);
    expect(store.deleted).toEqual([]);
  });

  it('records managed drift as a conflict and does not overwrite the existing card', async () => {
    const path = await paths();
    const store = statefulStore();
    const seed = matrix.cards[0];
    const collectionSeed = matrix.collections.find((item) => item.key === seed?.collectionKey);
    if (!seed || !collectionSeed) throw new Error('Expected first pilot card and collection.');
    const changed = existingCard(seed, collectionSeed.path);
    changed.title = 'Человек вручную изменил заголовок';
    store.cards.set(seed.slug, changed);

    const report = await applyPilotContent(applyInput(store, path));

    expect(report.records.find((record) => record.key === `card:${seed.pilotId}`)).toEqual({
      key: `card:${seed.pilotId}`,
      kind: 'card',
      state: 'conflict',
      detail: `existing record ${String(changed.id)} differs in managed field title`,
    });
    expect(store.cards.get(seed.slug)?.title).toBe('Человек вручную изменил заголовок');
    expect(store.createdImages).toHaveLength(49);
  });

  it('records the pHash signal and exact server refusal while leaving that card in draft', async () => {
    const path = await paths();
    const store = statefulStore();
    store.pHashSignalFor = '09';

    const report = await applyPilotContent(applyInput(store, path));

    expect(report.records.find((record) => record.key === 'card:09')).toEqual({
      key: 'card:09',
      kind: 'card',
      state: 'draft',
      detail: 'pHash signal: published-card-7 (distance 4); review refused: визуально похоже на опубликованную открытку #published-card-7',
    });
    expect(report.counts).toMatchObject({ draft: 1, review: 62, published: 0, indexed: 0 });
    expect(store.cards.get(matrix.cards[8]?.slug ?? '')?.status).toBe('draft');
  });

  it('rejects cyclic or missing-parent collection graphs before creating anything', () => {
    const first = matrix.collections[0];
    const second = matrix.collections[1];
    if (!first || !second) throw new Error('Expected two collection seeds.');
    const cycle: CollectionSeed[] = [
      { ...first, parentKey: second.key },
      { ...second, parentKey: first.key },
    ];
    expect(() => sortPilotCollections(cycle)).toThrow(/cycle/i);
    expect(() => sortPilotCollections([{ ...first, parentKey: 'missing-parent' }])).toThrow(
      /missing parent/i,
    );
  });

  it('does not write a report when imported IDs verify as published or indexable', async () => {
    const path = await paths();
    const store = statefulStore();
    store.verifyImported = () => Promise.resolve({ published: 1, indexed: 0 });

    await expect(applyPilotContent(applyInput(store, path))).rejects.toThrow(/published=1/i);
    await expect(readFile(path.reportPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the real ai-editor actor with overrideAccess false for every Payload mutation', async () => {
    const collectionSeed = matrix.collections[0];
    const cardSeed = matrix.cards[0];
    if (!collectionSeed || !cardSeed) throw new Error('Expected pilot seeds.');
    const actorDocument = {
      id: 91,
      collection: 'users',
      createdAt: '2026-08-30T00:00:00.000Z',
      email: 'pilot-ai@example.test',
      role: 'ai-editor',
      updatedAt: '2026-08-30T00:00:00.000Z',
    } satisfies User;
    const mutations: Array<Record<string, unknown>> = [];
    const collectionDoc = payloadCollection(collectionSeed);
    const cardDoc = payloadCard(cardSeed, collectionDoc);
    const imageDoc = { id: 301 } as CardImage;
    const payload = {
      create(input: Record<string, unknown>) {
        mutations.push(input);
        if (input.collection === 'collections') return Promise.resolve(collectionDoc);
        if (input.collection === 'card-images') return Promise.resolve(imageDoc);
        return Promise.resolve(cardDoc);
      },
      update(input: Record<string, unknown>) {
        mutations.push(input);
        return Promise.resolve(input.collection === 'collections'
          ? { ...collectionDoc, status: 'review' }
          : { ...cardDoc, status: 'review' });
      },
    } as unknown as Payload;
    const store = createPayloadPilotApplyStore(payload, actorDocument);

    const createdCollection = await store.createCollection(collectionSeed, null);
    const image = await store.createImage(cardSeed, jpeg);
    const createdCard = await store.createCard(cardSeed, image.id, createdCollection.id);
    await store.moveCollectionToReview(createdCollection.id);
    await store.moveCardToReview(createdCard.id);

    expect(mutations).toHaveLength(5);
    expect(mutations.every((call) => call.overrideAccess === false && call.user === actorDocument)).toBe(true);
    for (const call of mutations) {
      const data = call.data as Record<string, unknown>;
      expect(data).not.toHaveProperty('canonical');
      expect(data).not.toHaveProperty('publishedAt');
      expect(data).not.toHaveProperty('path');
      expect(data).not.toHaveProperty('robots', 'index,follow');
      expect(data).not.toHaveProperty('status', 'published');
    }
  });
});

function payloadCollection(seed: CollectionSeed): Collection {
  return {
    id: 201,
    createdAt: '2026-08-30T00:00:00.000Z',
    description: seed.description,
    h1: seed.h1,
    intro: pilotIntroDocument(seed.intro) as NonNullable<Collection['intro']>,
    metaDescription: seed.metaDescription,
    nodeKind: seed.nodeKind,
    parent: null,
    path: seed.path,
    pathClaimKey: `pilot-collection-${seed.key}`,
    robots: seed.robots,
    slug: seed.slug,
    status: 'draft',
    title: seed.title,
    updatedAt: '2026-08-30T00:00:00.000Z',
  };
}

function payloadCard(seed: CardSeed, collection: Collection): Card {
  return {
    id: 401,
    alt: seed.alt,
    caption: seed.caption,
    collections: [collection],
    createdAt: '2026-08-30T00:00:00.000Z',
    description: seed.description,
    h1: seed.h1,
    image: {
      id: 301,
      createdAt: '2026-08-30T00:00:00.000Z',
      filename: seed.sourceFile,
      height: 1280,
      mimeType: 'image/jpeg',
      revision,
      source: { format: 'jpeg', height: 1280, width: 1024 },
      title: seed.alt,
      updatedAt: '2026-08-30T00:00:00.000Z',
      width: 1024,
    },
    metaDescription: seed.metaDescription,
    pathClaimKey: `pilot-card-${seed.pilotId}`,
    robots: seed.robots,
    slug: seed.slug,
    status: 'draft',
    title: seed.title,
    updatedAt: '2026-08-30T00:00:00.000Z',
    usageTerms: seed.usageTerms,
  };
}
