/* eslint-disable @typescript-eslint/require-await -- Read-only store fakes implement async database boundaries. */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { computeImageRevision } from '@otkritka/images';

import type { GeneratedLibraryPlan, NormalizedGeneratedManifestRow } from './library-manifest';
import type { GeneratedLibrarySeeds } from './library-seeds';
import { pilotIntroDocument } from './pilot-types';
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
    isSchemaReady: async () => true,
    findActor: async () => ({ id: 17, email: 'ai@example.test', role: 'ai-editor' }),
    findPilotCardByKey: async () => null,
    findPilotImageByKey: async () => null,
    findCollectionByPath: async () => ({ id: 7, path: '/otkrytki/prazdniki/paskha', status: 'review', robots: 'noindex,follow' }),
    findCollectionBySourceKey: async () => null,
    findCardBySourceKey: async () => null,
    findImageBySourceKey: async () => null,
    findCardBySlug: async () => null,
    findContentPathClaimByPath: async () => null,
    hasOriginal: async () => true,
    hasDerivative: async () => true,
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
        findImageBySourceKey: async () => ({
          id: 82, sourceImportKey: imageKey, revision: await computeImageRevision(image),
          keyBase: 'managed/key', originalKey: 'managed/original.jpg', variants: [{ key: 'managed/640.webp' }],
        }),
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

  it('fails before reading assets when the source-import schema was not pushed', async () => {
    const data = fixture('a'.repeat(64));
    let reads = 0;
    const report = await runGeneratedLibraryPreflight({
      ...data, actorEmail: 'ai@example.test', store: store({ isSchemaReady: async () => false }),
      readBytes: async () => { reads += 1; return Buffer.alloc(0); },
    });
    expect(reads).toBe(0);
    expect(report.blockingErrors.join(' ')).toMatch(/PAYLOAD_DB_PUSH=true/u);
  });

  it('blocks a claimed card path before an image can be created', async () => {
    const [image, source] = await Promise.all([
      jpeg(), sharp({ create: { width: 640, height: 800, channels: 3, background: '#eee' } }).png().toBuffer(),
    ]);
    const data = fixture(createHash('sha256').update(source).digest('hex'));
    const report = await runGeneratedLibraryPreflight({
      ...data, actorEmail: 'ai@example.test',
      store: store({ findContentPathClaimByPath: async () => ({
        path: '/otkrytki/otkrytka-paskha-tsvety', ownerCollection: 'cards', ownerKey: 'cards:human',
      }) }),
      readBytes: async (path) => path === 'source.png' ? source : image,
    });
    expect(report.fingerprint).toBeNull();
    expect(report.blockingErrors.join(' ')).toMatch(/permanently claimed/u);
  });

  it('blocks an image whose physical derivative is missing', async () => {
    const [image, source] = await Promise.all([
      jpeg(), sharp({ create: { width: 640, height: 800, channels: 3, background: '#eee' } }).png().toBuffer(),
    ]);
    const data = fixture(createHash('sha256').update(source).digest('hex'));
    const seed = data.seeds.cards[0]!;
    const imageKey = `generated-library-2026-08:image:${seed.sourceSha256}`;
    const report = await runGeneratedLibraryPreflight({
      ...data, actorEmail: 'ai@example.test', store: store({
        findImageBySourceKey: async () => ({ id: 82, sourceImportKey: imageKey,
          revision: await computeImageRevision(image), keyBase: 'managed/key', originalKey: 'original.jpg',
          variants: [{ key: '640.webp' }] }),
        hasDerivative: async () => false,
      }), readBytes: async (path) => path === 'source.png' ? source : image,
    });
    expect(report.blockingErrors.join(' ')).toMatch(/derivative 640.webp is missing/u);
  });

  it('blocks duplicate pilot ids and a mismatched pilot card/image relation', async () => {
    const [image, source] = await Promise.all([
      jpeg(), sharp({ create: { width: 640, height: 800, channels: 3, background: '#eee' } }).png().toBuffer(),
    ]);
    const data = fixture(createHash('sha256').update(source).digest('hex'));
    const pilotRow = { ...data.plan.rows[0]!, package: 'pilot-2026-08' as const, id: '07' };
    data.plan = { ...data.plan, rows: [pilotRow, { ...pilotRow, manifestOrder: 1 }], pilotRowCount: 2 };
    data.seeds = { collections: [], cards: [] };
    const report = await runGeneratedLibraryPreflight({
      ...data, actorEmail: 'ai@example.test', store: store({
        findPilotCardByKey: async () => ({ id: 7, imageId: 999 }),
        findPilotImageByKey: async () => ({ id: 8, sourceImportKey: 'pilot-2026-08:image:07', revision: await computeImageRevision(image) }),
      }), readBytes: async (path) => path === 'source.png' ? source : image,
    });
    expect(report.blockingErrors.join(' ')).toMatch(/occurs more than once/u);
    expect(report.blockingErrors.join(' ')).toMatch(/relation does not match/u);
  });

  it('blocks nonempty related-link drift on an interrupted imported collection', async () => {
    const [image, source] = await Promise.all([
      jpeg(), sharp({ create: { width: 640, height: 800, channels: 3, background: '#eee' } }).png().toBuffer(),
    ]);
    const data = fixture(createHash('sha256').update(source).digest('hex'));
    const seed = {
      key: 'generated-paskha', slug: 'paskha', path: '/otkrytki/prazdniki/paskha', parentPath: '/otkrytki/prazdniki',
      nodeKind: 'occasion' as const, title: 'Пасха', h1: 'Пасха', metaDescription: 'Открытки на Пасху.',
      intro: 'Пасхальные открытки.', description: 'Открытки.', relatedPaths: ['/otkrytki/prazdniki'],
      status: 'draft' as const, robots: 'noindex,follow' as const,
    };
    data.seeds = { ...data.seeds, collections: [seed] };
    const key = `generated-library-2026-08:collection:${seed.key}`;
    const existing = { id: 11, sourceImportKey: key, pathClaimKey: key, path: seed.path, slug: seed.slug,
      nodeKind: seed.nodeKind, parentPath: seed.parentPath, relatedPaths: ['/otkrytki/prazdniki/other'],
      title: seed.title, h1: seed.h1, metaDescription: seed.metaDescription, intro: pilotIntroDocument(seed.intro),
      description: seed.description, status: seed.status, robots: seed.robots };
    const report = await runGeneratedLibraryPreflight({
      ...data, actorEmail: 'ai@example.test', store: store({
        findCollectionBySourceKey: async () => existing,
        findCollectionByPath: async (path) => path === seed.path ? existing : { id: 6, path, status: 'review', robots: 'noindex,follow' },
        findContentPathClaimByPath: async (path) => path === seed.path
          ? { path, ownerCollection: 'collections', ownerKey: `collections:${key}` }
          : null,
      }), readBytes: async (path) => path === 'source.png' ? source : image,
    });
    expect(report.blockingErrors.join(' ')).toMatch(/related paths/u);
  });
});
