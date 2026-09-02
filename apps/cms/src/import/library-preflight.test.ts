/* eslint-disable @typescript-eslint/require-await -- Read-only store fakes implement async database boundaries. */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { computeImageRevision } from '@otkritka/images';

import type { GeneratedLibraryPlan, NormalizedGeneratedManifestRow } from './library-manifest';
import type { GeneratedLibrarySeeds } from './library-seeds';
import { runGeneratedLibraryPreflight, type GeneratedLibraryReadStore } from './library-preflight';

async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 640, height: 800, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
}

function fixture(sourceSha256: string): { plan: GeneratedLibraryPlan; seeds: GeneratedLibrarySeeds } {
  const representative: NormalizedGeneratedManifestRow = {
    id: 'A-01', package: 'popular-next10-2026-08', manifestOrder: 0,
    sourceSha256, theme: 'Пасха', backgroundPath: 'source.png',
    finalPath: 'portrait.jpg', headline: 'С Пасхой!', wish: 'Добра!', alt: 'Цветы',
  };
  const group = { sourceSha256: representative.sourceSha256, representative, rows: [representative] };
  return {
    plan: {
      rows: [representative], groups: [group], creationCandidates: [group], aliases: [],
      sourceRowCount: 1, uniqueSourceCount: 1, pilotRowCount: 0,
      pilotRepeatedOutsideCount: 0, sovietRepeatedInPopularCount: 0,
    },
    seeds: {
      collections: [],
      cards: [{
        sourceSha256: representative.sourceSha256, sourceFile: 'portrait.jpg', sourcePng: 'source.png', squareFile: null,
        slug: 'otkrytka-paskha-tsvety', title: 'С Пасхой — цветы', h1: 'С Пасхой — цветы!',
        metaDescription: 'Пасхальная открытка с цветами.', alt: 'Цветы', caption: 'С Пасхой! Добра!',
        description: 'Пасхальная открытка с цветами и добрым пожеланием.', usageTerms: '',
        collectionPath: '/otkrytki/prazdniki/paskha', status: 'draft', robots: 'noindex,follow',
      }],
    },
  };
}

function store(overrides: Partial<GeneratedLibraryReadStore> = {}): GeneratedLibraryReadStore & { mutationCount: number } {
  return {
    mutationCount: 0,
    findActor: async () => ({ id: 17, email: 'ai@example.test', role: 'ai-editor' }),
    findPilotCardByKey: async () => null,
    findCollectionByPath: async () => ({ id: 7, path: '/otkrytki/prazdniki/paskha', status: 'review', robots: 'noindex,follow' }),
    findCollectionBySourceKey: async () => null,
    findCardBySourceKey: async () => null,
    findImageBySourceKey: async () => null,
    findCardBySlug: async () => null,
    ...overrides,
  };
}

describe('generated library preflight', () => {
  it('performs zero writes and returns prepared portrait bytes bound to a stable fingerprint', async () => {
    const [image, source] = await Promise.all([
      jpeg(),
      sharp({ create: { width: 640, height: 800, channels: 3, background: '#eeeeee' } }).png().toBuffer(),
    ]);
    const data = fixture(createHash('sha256').update(source).digest('hex'));
    const inputStore = store();
    const reads = new Map<string, number>();
    const report = await runGeneratedLibraryPreflight({
      ...data,
      actorEmail: 'ai@example.test',
      store: inputStore,
      readBytes: async (path) => {
        reads.set(path, (reads.get(path) ?? 0) + 1);
        return path === 'source.png' ? source : image;
      },
    });
    expect(report).toMatchObject({
      mutationCount: 0, sourceRows: 1, uniqueSources: 1, existingPilotCards: 0,
      cardsToCreate: 1, blockingErrors: [],
    });
    expect(report.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.preparedCards[0]).toMatchObject({
      portraitPath: 'portrait.jpg',
      portraitSha256: createHash('sha256').update(image).digest('hex'),
      portraitRevision: await computeImageRevision(image),
    });
    expect(report.preparedCards[0]).not.toHaveProperty('portraitBytes');
    expect(reads).toEqual(new Map([['source.png', 1], ['portrait.jpg', 1]]));
    expect(inputStore.mutationCount).toBe(0);
  });

  it('fails closed on slug collision and non-ai-editor actor', async () => {
    const [image, source] = await Promise.all([
      jpeg(),
      sharp({ create: { width: 640, height: 800, channels: 3, background: '#eeeeee' } }).png().toBuffer(),
    ]);
    const data = fixture(createHash('sha256').update(source).digest('hex'));
    const report = await runGeneratedLibraryPreflight({
      ...data,
      actorEmail: 'admin@example.test',
      store: store({
        findActor: async () => ({ id: 1, email: 'admin@example.test', role: 'admin' }),
        findCardBySlug: async () => ({
          id: 99, sourceImportKey: null, slug: 'otkrytka-paskha-tsvety', status: 'draft', robots: 'noindex,follow',
        }),
      }),
      readBytes: async (path) => path === 'source.png' ? source : image,
    });
    expect(report.fingerprint).toBeNull();
    expect(report.blockingErrors.join(' ')).toMatch(/must have role ai-editor/u);
    expect(report.blockingErrors.join(' ')).toMatch(/slug .* occupied/u);
  });

  it.each([
    ['image relation', { imageId: 999 }],
    ['collection path', { collectionPath: '/otkrytki/prazdniki/8-marta' }],
    ['SEO title', { title: 'Mutated title' }],
  ])('blocks resume when the managed %s drifted', async (_label, mutation) => {
    const [image, source] = await Promise.all([
      jpeg(),
      sharp({ create: { width: 640, height: 800, channels: 3, background: '#eeeeee' } }).png().toBuffer(),
    ]);
    const data = fixture(createHash('sha256').update(source).digest('hex'));
    const seed = data.seeds.cards[0]!;
    const key = `generated-library-2026-08:card:${seed.sourceSha256}`;
    const imageKey = `generated-library-2026-08:image:${seed.sourceSha256}`;
    const existing = {
      id: 81, sourceImportKey: key, imageId: 82, collectionPath: seed.collectionPath,
      slug: seed.slug, title: seed.title, h1: seed.h1, metaDescription: seed.metaDescription,
      alt: seed.alt, caption: seed.caption, description: seed.description, usageTerms: seed.usageTerms,
      status: seed.status, robots: seed.robots, ...mutation,
    };
    const report = await runGeneratedLibraryPreflight({
      ...data, actorEmail: 'ai@example.test',
      store: store({
        findCardBySourceKey: async () => existing,
        findCardBySlug: async () => existing,
        findImageBySourceKey: async () => ({ id: 82, sourceImportKey: imageKey, revision: await computeImageRevision(image) }),
      }),
      readBytes: async (path) => path === 'source.png' ? source : image,
    });
    expect(report.fingerprint).toBeNull();
    expect(report.blockingErrors.join(' ')).toMatch(/managed field/u);
  });

  it('rejects a human collection occupying a generated collection path without the matching source key', async () => {
    const [image, source] = await Promise.all([
      jpeg(),
      sharp({ create: { width: 640, height: 800, channels: 3, background: '#eeeeee' } }).png().toBuffer(),
    ]);
    const data = fixture(createHash('sha256').update(source).digest('hex'));
    data.seeds = {
      ...data.seeds,
      collections: [{
        key: 'generated-paskha', slug: 'paskha', path: '/otkrytki/prazdniki/paskha',
        parentPath: '/otkrytki/prazdniki', nodeKind: 'occasion', title: 'Пасха', h1: 'Пасха',
        metaDescription: 'Открытки на Пасху.', intro: 'Пасхальные открытки.', description: 'Открытки.',
        relatedPaths: ['/otkrytki/prazdniki'], status: 'draft', robots: 'noindex,follow',
      }],
    };
    const report = await runGeneratedLibraryPreflight({
      ...data, actorEmail: 'ai@example.test', store: store(),
      readBytes: async (path) => path === 'source.png' ? source : image,
    });
    expect(report.fingerprint).toBeNull();
    expect(report.blockingErrors.join(' ')).toMatch(/occupied by a record without matching sourceImportKey/u);
  });
});
