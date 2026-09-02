/* eslint-disable @typescript-eslint/require-await -- In-memory store implements async persistence boundaries. */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { computeImageRevision } from '@otkritka/images';
import { APIError } from 'payload';

import type { GeneratedLibraryPlan, NormalizedGeneratedManifestRow } from './library-manifest';
import { applyGeneratedLibrary, type GeneratedLibraryApplyStore } from './library-apply';
import { runGeneratedLibraryPreflight } from './library-preflight';
import type { GeneratedLibrarySeeds } from './library-seeds';
import { pilotIntroDocument } from './pilot-types';
import { sourceCardImportKey, sourceImageImportKey } from './source-import-identity';

async function setup(refuseReview = false, includeCollection = false) {
  const source = await sharp({ create: { width: 640, height: 800, channels: 3, background: '#eee' } }).png().toBuffer();
  const portrait = await sharp(source).jpeg().toBuffer();
  const sha = createHash('sha256').update(source).digest('hex');
  const row: NormalizedGeneratedManifestRow = {
    id: 'P-01', package: 'popular-next10-2026-08', manifestOrder: 0, sourceSha256: sha,
    theme: 'Пасха', backgroundPath: 'source.png', finalPath: 'portrait.jpg',
    headline: 'С Пасхой!', wish: 'Добра!', alt: 'Открытка с цветами',
  };
  const group = { sourceSha256: sha, representative: row, rows: [row] };
  const plan: GeneratedLibraryPlan = {
    rows: [row], groups: [group], creationCandidates: [group], aliases: [], sourceRowCount: 1,
    uniqueSourceCount: 1, pilotRowCount: 0, pilotRepeatedOutsideCount: 0, sovietRepeatedInPopularCount: 0,
  };
  const seeds: GeneratedLibrarySeeds = {
    collections: includeCollection ? [{
      key: 'generated-den-materi', slug: 'den-materi', path: '/otkrytki/prazdniki/den-materi',
      parentPath: '/otkrytki/prazdniki', nodeKind: 'occasion', title: 'День матери', h1: 'День матери',
      metaDescription: 'Открытки ко Дню матери.', intro: 'Выберите открытку.', description: 'Открытки.',
      relatedPaths: ['/otkrytki/prazdniki'], status: 'draft', robots: 'noindex,follow',
    }] : [],
    cards: [{
      sourceSha256: sha, sourceFile: 'portrait.jpg', sourcePng: 'source.png', squareFile: null,
      slug: 'otkrytka-paskha-tsvety', title: 'С Пасхой — цветы', h1: 'С Пасхой — цветы!',
      metaDescription: 'Пасхальная открытка с цветами.', alt: 'Открытка с цветами',
      caption: 'С Пасхой! Добра!', description: 'Пасхальная открытка с цветами.', usageTerms: '',
      collectionPath: '/otkrytki/prazdniki/paskha', status: 'draft', robots: 'noindex,follow',
    }],
  };
  let nextId = 100;
  const cards = new Map<string, { id: number; sourceImportKey: string; slug: string; status: string; robots: string; imageId: number; collectionPath: string }>();
  const images = new Map<string, { id: number; sourceImportKey: string; revision: string }>();
  const collections = new Map<string, { id: number; sourceImportKey?: string; path: string; status: string; robots: string }>();
  const createdCards: Array<{ initialStatus: string }> = [];
  const orphanedImages: Array<{ sourceSha256: string; reason: string }> = [];
  const store: GeneratedLibraryApplyStore & { createdCards: typeof createdCards; imageCreates: number; relatedWrites: number } = {
    createdCards,
    imageCreates: 0,
    relatedWrites: 0,
    isSchemaReady: async () => true,
    findActor: async () => ({ id: 17, email: 'ai@example.test', role: 'ai-editor' }),
    findPilotCardByKey: async () => null,
    findPilotImageByKey: async () => null,
    findCollectionByPath: async (path) => collections.get(path) ?? (
      path === '/otkrytki/prazdniki/paskha' || path === '/otkrytki/prazdniki'
        ? { id: path.endsWith('paskha') ? 7 : 6, path, status: 'review', robots: 'noindex,follow' }
        : null),
    findCollectionBySourceKey: async (key) => [...collections.values()].find((item) => item.sourceImportKey === key) ?? null,
    findCardBySourceKey: async (key) => cards.get(key) ?? null,
    findImageBySourceKey: async (key) => images.get(key) ?? null,
    findCardBySlug: async (slug) => [...cards.values()].find((card) => card.slug === slug) ?? null,
    findContentPathClaimByPath: async (path) => {
      const card = [...cards.values()].find((item) => `/otkrytki/${item.slug}` === path);
      if (card !== undefined) return { path, ownerCollection: 'cards', ownerKey: `cards:${card.sourceImportKey}` };
      const collection = collections.get(path);
      return collection === undefined ? null : { path, ownerCollection: 'collections', ownerKey: `collections:${collection.sourceImportKey}` };
    },
    hasOriginal: async () => true,
    hasDerivative: async () => true,
    createCollection: async (seed) => {
      const value = { id: nextId++, sourceImportKey: `generated-library-2026-08:collection:${seed.key}`,
        pathClaimKey: `generated-library-2026-08:collection:${seed.key}`, path: seed.path, slug: seed.slug,
        createdAt: '2026-09-02T12:00:00.000Z', updatedAt: '2026-09-02T12:00:00.000Z',
        nodeKind: seed.nodeKind, parentPath: seed.parentPath, relatedPaths: [] as string[], title: seed.title,
        h1: seed.h1, metaDescription: seed.metaDescription, intro: pilotIntroDocument(seed.intro), description: seed.description,
        status: 'draft', robots: 'noindex,follow' };
      collections.set(seed.path, value);
      return value;
    },
    setCollectionRelated: async (collection) => {
      store.relatedWrites += 1;
      const value = collections.get(collection.path)!;
      (value as typeof value & { relatedPaths: string[] }).relatedPaths =
        seeds.collections.find(({ path }) => path === collection.path)?.relatedPaths.slice() ?? [];
      return value;
    },
    createImage: async (seed, bytes) => {
      store.imageCreates += 1;
      const image = { id: nextId++, sourceImportKey: sourceImageImportKey(seed.sourceSha256),
        revision: await computeImageRevision(bytes), keyBase: 'managed/key', originalKey: 'managed/original.jpg',
        variants: [{ key: 'managed/640.webp' }] };
      images.set(image.sourceImportKey, image);
      return image;
    },
    createCard: async (seed, imageId) => {
      createdCards.push({ initialStatus: seed.status });
      const card = {
        id: nextId++, sourceImportKey: sourceCardImportKey(seed.sourceSha256), pathClaimKey: sourceCardImportKey(seed.sourceSha256), slug: seed.slug,
        title: seed.title, h1: seed.h1, metaDescription: seed.metaDescription, alt: seed.alt,
        caption: seed.caption, description: seed.description, usageTerms: seed.usageTerms,
        status: seed.status, robots: seed.robots, imageId: Number(imageId), collectionPath: seed.collectionPath,
      };
      cards.set(card.sourceImportKey, card);
      return card;
    },
    moveCollectionToReview: async (collection) => {
      const stored = collections.get(collection.path)!;
      collections.set(collection.path, { ...stored, status: 'review' });
      return { ...collection, status: 'review' };
    },
    moveCardToReview: async (card) => {
      if (refuseReview) throw new APIError('pHash signal requires editor judgment', 400, { rule: 'visual-duplicate-unresolved' }, true);
      const reviewed = { ...card, status: 'review' };
      cards.set(card.sourceImportKey!, reviewed as never);
      return reviewed;
    },
  };
  const readBytes = async (path: string) => path === 'source.png' ? source : portrait;
  const recordOrphanedImage = async (value: { sourceSha256: string; reason: string }) => { orphanedImages.push(value); };
  return { plan, seeds, store, readBytes, recordOrphanedImage, orphanedImages };
}

describe('generated library apply', () => {
  it('creates draft first, promotes normally, and reports forbidden counters as zero', async () => {
    const input = await setup();
    const preflight = await runGeneratedLibraryPreflight({ ...input, actorEmail: 'ai@example.test' });
    const report = await applyGeneratedLibrary({ ...input, actorEmail: 'ai@example.test', preflight });
    expect(input.store.createdCards.every((card) => card.initialStatus === 'draft')).toBe(true);
    expect(report).toMatchObject({ createdCards: 1, review: 1, draft: 0, published: 0, indexed: 0, sitemapUrlsAdded: 0 });

    const resumedPreflight = await runGeneratedLibraryPreflight({ ...input, actorEmail: 'ai@example.test' });
    const resumed = await applyGeneratedLibrary({ ...input, actorEmail: 'ai@example.test', preflight: resumedPreflight });
    expect(resumed.createdCards).toBe(0);
    expect(resumed.resumedCards).toBe(1);
    expect(input.store.imageCreates).toBe(1);
  });

  it('leaves the card in draft and records an exact normal-hook review refusal', async () => {
    const input = await setup(true);
    const preflight = await runGeneratedLibraryPreflight({ ...input, actorEmail: 'ai@example.test' });
    const report = await applyGeneratedLibrary({ ...input, actorEmail: 'ai@example.test', preflight });
    expect(report).toMatchObject({ draft: 1, review: 0, published: 0, indexed: 0 });
    expect(report.reviewRefusals[0]?.reason).toBe('pHash signal requires editor judgment');
  });

  it('retains the reviewed result returned by the collection status hook', async () => {
    const input = await setup(false, true);
    const preflight = await runGeneratedLibraryPreflight({ ...input, actorEmail: 'ai@example.test' });
    const report = await applyGeneratedLibrary({ ...input, actorEmail: 'ai@example.test', preflight });
    expect(report).toMatchObject({ collectionReview: 1, collectionDraft: 0 });
  });

  it('reports the exact collection review refusal instead of swallowing it', async () => {
    const input = await setup(false, true);
    input.store.moveCollectionToReview = async () => { throw new APIError('related links require editor judgment', 400, { rule: 'incomplete-for-review' }, true); };
    const preflight = await runGeneratedLibraryPreflight({ ...input, actorEmail: 'ai@example.test' });
    const report = await applyGeneratedLibrary({ ...input, actorEmail: 'ai@example.test', preflight });
    expect(report.collectionReviewRefusals).toEqual([{
      path: '/otkrytki/prazdniki/den-materi',
      reason: 'related links require editor judgment',
    }]);
  });

  it('rethrows unknown persistence errors instead of reporting a moderation refusal', async () => {
    const input = await setup(true);
    input.store.moveCardToReview = async () => { throw new Error('database connection lost'); };
    const preflight = await runGeneratedLibraryPreflight({ ...input, actorEmail: 'ai@example.test' });
    await expect(applyGeneratedLibrary({ ...input, actorEmail: 'ai@example.test', preflight }))
      .rejects.toThrow('database connection lost');
  });

  it('re-reads the portrait immediately before image create and rejects changed bytes', async () => {
    const input = await setup();
    const changed = await sharp({ create: { width: 640, height: 800, channels: 3, background: '#111' } }).jpeg().toBuffer();
    const originalRead = input.readBytes;
    let portraitReads = 0;
    input.readBytes = async (path) => {
      if (path !== 'portrait.jpg') return originalRead(path);
      portraitReads += 1;
      return portraitReads >= 3 ? changed : originalRead(path);
    };
    const preflight = await runGeneratedLibraryPreflight({ ...input, actorEmail: 'ai@example.test' });
    await expect(applyGeneratedLibrary({ ...input, actorEmail: 'ai@example.test', preflight }))
      .rejects.toThrow(/portrait changed after preflight/u);
    expect(input.store.imageCreates).toBe(0);
  });

  it('refuses apply when state no longer matches the preflight fingerprint', async () => {
    const input = await setup();
    const preflight = await runGeneratedLibraryPreflight({ ...input, actorEmail: 'ai@example.test' });
    input.store.findCardBySlug = async () => ({
      id: 999, sourceImportKey: null, slug: 'otkrytka-paskha-tsvety', status: 'draft', robots: 'noindex,follow',
    });
    await expect(applyGeneratedLibrary({ ...input, actorEmail: 'ai@example.test', preflight }))
      .rejects.toThrow(/state changed after preflight/u);
  });

  it('does not overwrite established imported related links on resume', async () => {
    const input = await setup(false, true);
    const preflight = await runGeneratedLibraryPreflight({ ...input, actorEmail: 'ai@example.test' });
    await applyGeneratedLibrary({ ...input, actorEmail: 'ai@example.test', preflight });
    const writes = input.store.relatedWrites;
    const resumedPreflight = await runGeneratedLibraryPreflight({ ...input, actorEmail: 'ai@example.test' });
    await applyGeneratedLibrary({ ...input, actorEmail: 'ai@example.test', preflight: resumedPreflight });
    expect(input.store.relatedWrites).toBe(writes);
  });

  it('refreshes the actor again before each mutation and stops on role revocation', async () => {
    const input = await setup();
    const preflight = await runGeneratedLibraryPreflight({ ...input, actorEmail: 'ai@example.test' });
    let actorReads = 0;
    input.store.findActor = async () => ({
      id: 17, email: 'ai@example.test', role: ++actorReads >= 3 ? 'admin' : 'ai-editor',
    });
    await expect(applyGeneratedLibrary({ ...input, actorEmail: 'ai@example.test', preflight }))
      .rejects.toThrow(/current ai-editor/u);
    expect(input.store.imageCreates).toBe(0);
  });

  it('fails closed when the atomic review transition observes concurrent drift', async () => {
    const input = await setup();
    input.store.moveCardToReview = async () => null;
    const preflight = await runGeneratedLibraryPreflight({ ...input, actorEmail: 'ai@example.test' });
    await expect(applyGeneratedLibrary({ ...input, actorEmail: 'ai@example.test', preflight }))
      .rejects.toThrow(/changed concurrently/u);
  });

  it('rechecks the final card path immediately before creating its image', async () => {
    const input = await setup();
    const preflight = await runGeneratedLibraryPreflight({ ...input, actorEmail: 'ai@example.test' });
    let claimReads = 0;
    input.store.findContentPathClaimByPath = async (path) => ++claimReads >= 2
      ? { path, ownerCollection: 'cards', ownerKey: 'cards:concurrent-human' }
      : null;
    await expect(applyGeneratedLibrary({ ...input, actorEmail: 'ai@example.test', preflight }))
      .rejects.toThrow(/became occupied before image creation/u);
    expect(input.store.imageCreates).toBe(0);
  });

  it('durably reports an uploaded orphan if the card path is claimed before card create', async () => {
    const input = await setup();
    const preflight = await runGeneratedLibraryPreflight({ ...input, actorEmail: 'ai@example.test' });
    let claimReads = 0;
    input.store.findContentPathClaimByPath = async (path) => ++claimReads >= 3
      ? { path, ownerCollection: 'cards', ownerKey: 'cards:concurrent-human' }
      : null;
    await expect(applyGeneratedLibrary({ ...input, actorEmail: 'ai@example.test', preflight }))
      .rejects.toThrow(/became occupied after image creation/u);
    expect(input.store.imageCreates).toBe(1);
    expect(input.orphanedImages).toEqual([expect.objectContaining({ sourceSha256: input.seeds.cards[0]!.sourceSha256,
      reason: 'Card path /otkrytki/otkrytka-paskha-tsvety became occupied after image creation.' })]);
  });

  it('records exactly one orphan when physical storage verification fails after upload', async () => {
    const input = await setup();
    input.store.hasDerivative = async () => false;
    const preflight = await runGeneratedLibraryPreflight({ ...input, actorEmail: 'ai@example.test' });
    await expect(applyGeneratedLibrary({ ...input, actorEmail: 'ai@example.test', preflight }))
      .rejects.toThrow(/derivative .* is missing/u);
    expect(input.orphanedImages).toHaveLength(1);
    expect(input.orphanedImages[0]?.reason).toMatch(/derivative .* is missing/u);
  });

  it('records exactly one orphan when the actor role is revoked after upload', async () => {
    const input = await setup();
    const preflight = await runGeneratedLibraryPreflight({ ...input, actorEmail: 'ai@example.test' });
    let actorReads = 0;
    input.store.findActor = async () => ({ id: 17, email: 'ai@example.test',
      role: ++actorReads >= 4 ? 'admin' : 'ai-editor' });
    await expect(applyGeneratedLibrary({ ...input, actorEmail: 'ai@example.test', preflight }))
      .rejects.toThrow(/current ai-editor/u);
    expect(input.orphanedImages).toHaveLength(1);
    expect(input.orphanedImages[0]?.reason).toMatch(/current ai-editor/u);
  });

  it('repairs related links only for a source-owned untouched interrupted collection', async () => {
    const input = await setup(false, true);
    const seed = input.seeds.collections[0]!;
    await input.store.findActor('ai@example.test');
    await input.store.createCollection(seed, 6);
    const preflight = await runGeneratedLibraryPreflight({ ...input, actorEmail: 'ai@example.test' });
    expect(preflight.blockingErrors).toEqual([]);
    await applyGeneratedLibrary({ ...input, actorEmail: 'ai@example.test', preflight });
    expect(input.store.relatedWrites).toBe(1);
  });

  it('never resumes a collection found only by path after current preflight', async () => {
    const input = await setup(false, true);
    const preflight = await runGeneratedLibraryPreflight({ ...input, actorEmail: 'ai@example.test' });
    const sourceLookup = input.store.findCollectionBySourceKey.bind(input.store);
    const pathLookup = input.store.findCollectionByPath.bind(input.store);
    let sourceReads = 0;
    let raced = false;
    input.store.findCollectionBySourceKey = async (key) => {
      sourceReads += 1;
      if (sourceReads >= 2) raced = true;
      return sourceLookup(key);
    };
    input.store.findCollectionByPath = async (path) => raced && path === input.seeds.collections[0]!.path
      ? { id: 999, path, status: 'draft', robots: 'noindex,follow' }
      : pathLookup(path);
    await expect(applyGeneratedLibrary({ ...input, actorEmail: 'ai@example.test', preflight }))
      .rejects.toThrow(/without exact source identity/u);
    expect(input.store.relatedWrites).toBe(0);
  });

  it('fails final audit when a managed card field drifts after review', async () => {
    const input = await setup();
    const move = input.store.moveCardToReview.bind(input.store);
    input.store.moveCardToReview = async (card) => {
      const reviewed = await move(card);
      if (reviewed !== null) (reviewed as { title?: string }).title = 'Concurrent manual title';
      return reviewed;
    };
    const preflight = await runGeneratedLibraryPreflight({ ...input, actorEmail: 'ai@example.test' });
    await expect(applyGeneratedLibrary({ ...input, actorEmail: 'ai@example.test', preflight }))
      .rejects.toThrow(/differs in managed fields: title/u);
  });
});
