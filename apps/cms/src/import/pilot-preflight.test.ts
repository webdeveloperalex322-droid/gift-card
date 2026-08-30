import { mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { computeImageRevision } from '@otkritka/images';

import { loadManifest, type CardRecord } from '../../../../scripts/content-pilot/manifest.mjs';
import {
  loadSiteContent,
  type SiteContentMatrix,
} from '../../../../scripts/content-import/schema.js';
import {
  runPilotPreflight,
  type PilotImportStore,
} from './pilot-preflight';
import type {
  ExistingCard,
  ExistingCollection,
  ExistingContentPathClaim,
} from './pilot-types';
import { pilotIntroDocument } from './pilot-types';
import {
  initializePilotDryRun,
  parsePilotImportMode,
  requirePilotImportEnvironment,
  resolvePilotWorkspaceRoot,
} from '../../scripts/import-pilot-content';

const manifestPath = 'content/pilot-2026-08/manifest.json';
const matrixPath = 'content/pilot-2026-08/site-content.json';
const temporaryPaths: string[] = [];

let manifest: CardRecord[];
let matrix: SiteContentMatrix;
let validJpeg: Buffer;
let validRevision: string;

beforeAll(async () => {
  manifest = await loadManifest(manifestPath);
  matrix = await loadSiteContent(matrixPath);
  validJpeg = await sharp({
    create: {
      width: 1024,
      height: 1280,
      channels: 3,
      background: '#ddd4c8',
    },
  }).jpeg().toBuffer();
  validRevision = await computeImageRevision(validJpeg);
});

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

interface FakeStore extends PilotImportStore {
  readonly claimLookups: string[];
  readonly mutations: string[];
}

function fakeStore(input: {
  actor?: { id: number | string; role: string } | null;
  cards?: readonly ExistingCard[];
  claims?: readonly ExistingContentPathClaim[];
  collections?: readonly ExistingCollection[];
} = {}): FakeStore {
  const cards = new Map((input.cards ?? []).map((card) => [card.slug, card]));
  const collections = new Map(
    (input.collections ?? []).map((collection) => [collection.path, collection]),
  );
  const claims = new Map((input.claims ?? []).map((claim) => [claim.path, claim]));
  const store: FakeStore = {
    claimLookups: [],
    mutations: [],
    findActor() {
      return Promise.resolve(
        input.actor === undefined ? { id: 91, role: 'ai-editor' } : input.actor,
      );
    },
    findCardBySlug(slug) {
      return Promise.resolve(cards.get(slug) ?? null);
    },
    findCollectionByPath(path) {
      return Promise.resolve(collections.get(path) ?? null);
    },
    findContentPathClaimByPath(path) {
      store.claimLookups.push(path);
      return Promise.resolve(claims.get(path) ?? null);
    },
  };
  return store;
}

async function assetRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'otkritka-pilot-preflight-'));
  temporaryPaths.push(root);
  await Promise.all(matrix.cards.map((card) => writeFile(join(root, card.sourceFile), validJpeg)));
  return root;
}

function input(root: string, store: PilotImportStore, sourceMatrix = matrix) {
  return {
    actorEmail: 'pilot-ai@example.test',
    assetRoot: root,
    manifest,
    matrix: sourceMatrix,
    store,
  };
}

describe('pilot import preflight', () => {
  it('validates exactly fifty JPEG masters and performs zero mutations', async () => {
    const root = await assetRoot();
    const store = fakeStore();

    const report = await runPilotPreflight(input(root, store));

    expect(report).toMatchObject({
      mode: 'dry-run',
      blockingErrors: [],
      cards: 50,
      collectionNodes: 13,
      leafTopics: 10,
      validFiles: 50,
      mutationCount: 0,
    });
    expect(store.mutations).toEqual([]);
    expect(store.claimLookups).toHaveLength(63);
    expect(new Set(store.claimLookups)).toEqual(new Set([
      ...matrix.collections.map((seed) => seed.path),
      ...matrix.cards.map((seed) => `/otkrytki/${seed.slug}`),
    ]));
  });

  it('blocks a missing accepted JPEG', async () => {
    const root = await assetRoot();
    const [first] = matrix.cards;
    if (!first) throw new Error('Expected a pilot card.');
    await unlink(join(root, first.sourceFile));

    const report = await runPilotPreflight(input(root, fakeStore()));

    expect(report.validFiles).toBe(49);
    expect(report.blockingErrors).toContain(`Asset ${first.sourceFile} is missing.`);
  });

  it('blocks a JPEG below 1024 by 1280', async () => {
    const root = await assetRoot();
    const [first] = matrix.cards;
    if (!first) throw new Error('Expected a pilot card.');
    const undersized = await sharp({
      create: { width: 800, height: 1000, channels: 3, background: '#ffffff' },
    }).jpeg().toBuffer();
    await writeFile(join(root, first.sourceFile), undersized);

    const report = await runPilotPreflight(input(root, fakeStore()));

    expect(report.blockingErrors).toContain(
      `Asset ${first.sourceFile} must be at least 1024x1280; received 800x1000.`,
    );
  });

  it('requires JPEG format and an exact 4:5 ratio', async () => {
    const root = await assetRoot();
    const [first, second] = matrix.cards;
    if (!first || !second) throw new Error('Expected two pilot cards.');
    const png = await sharp({
      create: { width: 1024, height: 1280, channels: 3, background: '#ffffff' },
    }).png().toBuffer();
    const wrongRatio = await sharp({
      create: { width: 1024, height: 1281, channels: 3, background: '#ffffff' },
    }).jpeg().toBuffer();
    await Promise.all([
      writeFile(join(root, first.sourceFile), png),
      writeFile(join(root, second.sourceFile), wrongRatio),
    ]);

    const report = await runPilotPreflight(input(root, fakeStore()));

    expect(report.blockingErrors).toEqual(expect.arrayContaining([
      `Asset ${first.sourceFile} must be JPEG; received png.`,
      `Asset ${second.sourceFile} must have exact 4:5 ratio; received 1024x1281.`,
    ]));
  });

  it('runs the closed matrix validator before reporting a clean preflight', async () => {
    const root = await assetRoot();
    const changed = structuredClone(matrix);
    changed.cards.pop();

    const report = await runPilotPreflight(input(root, fakeStore(), changed));

    expect(report.blockingErrors).toContain('Matrix must contain exactly 50 cards.');
  });

  it('blocks candidate cards colliding with an existing collection final path', async () => {
    const root = await assetRoot();
    const [first] = matrix.cards;
    if (!first) throw new Error('Expected a pilot card.');
    const path = `/otkrytki/${first.slug}`;

    const report = await runPilotPreflight(input(root, fakeStore({
      collections: [{
        id: 14,
        h1: 'Чужая подборка',
        intro: null,
        metaDescription: 'Чужая подборка',
        nodeKind: 'occasion',
        parentPath: null,
        path,
        pathClaimKey: 'foreign-collection',
        robots: 'noindex,follow',
        slug: first.slug,
        status: 'draft',
        title: 'Чужая подборка',
        description: 'Чужая подборка',
      }],
    })));

    expect(report.blockingErrors).toContain(
      `Card ${first.pilotId} final path ${path} is occupied by collection 14.`,
    );
  });

  it('blocks candidate collections colliding with an existing card final path', async () => {
    const root = await assetRoot();
    const changed = structuredClone(matrix);
    const [firstCollection] = changed.collections;
    if (!firstCollection) throw new Error('Expected a pilot collection.');
    firstCollection.path = `/otkrytki/${firstCollection.slug}`;
    const cardSeed = changed.cards[0] ?? matrix.cards[0];
    if (!cardSeed) throw new Error('Expected a pilot card.');
    const existingCard = existingCardFor(cardSeed);
    existingCard.id = 27;
    existingCard.slug = firstCollection.slug;

    const report = await runPilotPreflight(input(root, fakeStore({ cards: [existingCard] }), changed));

    expect(report.blockingErrors).toContain(
      `Collection ${firstCollection.key} final path ${firstCollection.path} is occupied by card 27.`,
    );
  });

  it('marks exact existing records as resume and blocks managed-field drift', async () => {
    const root = await assetRoot();
    const [first, second] = matrix.cards;
    if (!first || !second) throw new Error('Expected two pilot cards.');
    const exact = existingCardFor(first);
    const drifted = existingCardFor(second);
    drifted.title = 'Ручная редакторская правка';

    const report = await runPilotPreflight(input(root, fakeStore({
      cards: [exact, drifted],
      claims: [matchingCardClaim(exact), matchingCardClaim(drifted)],
    })));

    expect(report.records).toContainEqual(expect.objectContaining({
      key: `card:${first.pilotId}`,
      state: 'resume',
    }));
    expect(report.blockingErrors).toContain(
      `Card ${second.pilotId} existing record ${String(drifted.id)} differs in managed field title.`,
    );
  });

  it('blocks managed-field drift on an existing collection', async () => {
    const root = await assetRoot();
    const [first] = matrix.collections;
    if (!first) throw new Error('Expected a pilot collection.');
    const existing = existingCollectionFor(first);
    existing.description = 'Ручная редакторская правка';

    const report = await runPilotPreflight(input(root, fakeStore({
      claims: [matchingCollectionClaim(existing)],
      collections: [existing],
    })));

    expect(report.blockingErrors).toContain(
      `Collection ${first.key} existing record ${String(existing.id)} differs in managed field description.`,
    );
  });

  it('requires an explicit existing ai-editor actor', async () => {
    const root = await assetRoot();
    const missing = await runPilotPreflight(input(root, fakeStore({ actor: null })));
    const admin = await runPilotPreflight(input(root, fakeStore({
      actor: { id: 1, role: 'admin' },
    })));

    expect(missing.blockingErrors).toContain(
      'Import actor pilot-ai@example.test does not exist.',
    );
    expect(admin.blockingErrors).toContain(
      'Import actor pilot-ai@example.test must have role ai-editor; received admin.',
    );
  });

  it('blocks permanent claims without the matching stable owner', async () => {
    const root = await assetRoot();
    const [first] = matrix.cards;
    if (!first) throw new Error('Expected a pilot card.');
    const path = `/otkrytki/${first.slug}`;

    const report = await runPilotPreflight(input(root, fakeStore({
      claims: [{
        ownerCollection: 'collections',
        ownerKey: 'collections:permanent-foreign-owner',
        path,
      }],
    })));

    expect(report.blockingErrors).toContain(
      `Card ${first.pilotId} final path ${path} is permanently claimed by collections:permanent-foreign-owner.`,
    );
  });

  it('resumes an exact record whose permanent claim has the same stable owner', async () => {
    const root = await assetRoot();
    const [first] = matrix.cards;
    if (!first) throw new Error('Expected a pilot card.');
    const existing = existingCardFor(first);
    const path = `/otkrytki/${first.slug}`;

    const report = await runPilotPreflight(input(root, fakeStore({
      cards: [existing],
      claims: [{
        ownerCollection: 'cards',
        ownerKey: `cards:${String(existing.pathClaimKey)}`,
        path,
      }],
    })));

    expect(report.blockingErrors).toEqual([]);
    expect(report.records).toContainEqual(expect.objectContaining({
      key: `card:${first.pilotId}`,
      state: 'resume',
    }));
  });

  it('resumes by original bytes and dimensions while preserving a suffixed assigned filename', async () => {
    const root = await assetRoot();
    const [first] = matrix.cards;
    if (!first) throw new Error('Expected a pilot card.');
    const existing = existingCardFor(first);
    existing.imageAssignedFilename = 'assigned-name-2.jpg';

    const report = await runPilotPreflight(input(root, fakeStore({
      cards: [existing],
      claims: [matchingCardClaim(existing)],
    })));

    expect(report.blockingErrors).toEqual([]);
    expect(report.records).toContainEqual(expect.objectContaining({
      key: `card:${first.pilotId}`,
      state: 'resume',
    }));
    expect(existing.imageAssignedFilename).toBe('assigned-name-2.jpg');
  });

  it('blocks resume when accepted master bytes differ from the stored original revision', async () => {
    const root = await assetRoot();
    const [first] = matrix.cards;
    if (!first) throw new Error('Expected a pilot card.');
    const existing = existingCardFor(first);
    const changedBytes = await sharp({
      create: { width: 1024, height: 1280, channels: 3, background: '#17324d' },
    }).jpeg().toBuffer();
    await writeFile(join(root, first.sourceFile), changedBytes);

    const report = await runPilotPreflight(input(root, fakeStore({
      cards: [existing],
      claims: [matchingCardClaim(existing)],
    })));

    expect(report.blockingErrors).toContain(
      `Card ${first.pilotId} existing record ${String(existing.id)} differs in managed field imageRevision.`,
    );
  });

  it('normalizes Lexical service defaults but preserves text, format, and link semantics', async () => {
    const root = await assetRoot();
    const [first, second, third, fourth] = matrix.collections;
    if (!first || !second || !third || !fourth) throw new Error('Expected four collections.');
    const equivalent = existingCollectionFor(first);
    const equivalentRoot = (equivalent.intro as { root: Record<string, unknown> }).root;
    equivalentRoot.direction = 'ltr';
    delete equivalentRoot.version;
    const textChanged = existingCollectionFor(second);
    const textNode = lexicalTextNode(textChanged);
    textNode.text = `${String(textNode.text)}!`;
    const formatChanged = existingCollectionFor(third);
    lexicalTextNode(formatChanged).format = 1;
    const linkChanged = existingCollectionFor(fourth);
    const originalText = lexicalTextNode(linkChanged);
    const paragraph = lexicalParagraph(linkChanged);
    paragraph.children = [{
      type: 'link',
      fields: { linkType: 'custom', newTab: false, url: '/kontakty' },
      children: [originalText],
      direction: null,
      format: '',
      indent: 0,
      version: 1,
    }];
    const existing = [equivalent, textChanged, formatChanged, linkChanged];

    const report = await runPilotPreflight(input(root, fakeStore({
      claims: existing.map(matchingCollectionClaim),
      collections: existing,
    })));

    expect(report.records).toContainEqual(expect.objectContaining({
      key: `collection:${first.key}`,
      state: 'resume',
    }));
    for (const changed of [second, third, fourth]) {
      expect(report.blockingErrors).toContain(
        `Collection ${changed.key} existing record collection-${changed.key} differs in managed field intro.`,
      );
    }
  });

  it('does not treat extra directory entries as accepted masters', async () => {
    const root = await assetRoot();
    await writeFile(join(root, 'unexpected.jpg'), validJpeg);

    const report = await runPilotPreflight(input(root, fakeStore()));

    expect(await readdir(root)).toHaveLength(51);
    expect(report.blockingErrors).toContain('Asset root must contain exactly the 50 matrix JPEGs; unexpected: unexpected.jpg.');
  });
});

describe('pilot import CLI contract', () => {
  it('uses dry-run by default and accepts exactly one explicit mode', () => {
    expect(parsePilotImportMode([])).toBe('dry-run');
    expect(parsePilotImportMode(['--dry-run'])).toBe('dry-run');
    expect(parsePilotImportMode(['--apply'])).toBe('apply');
    expect(() => parsePilotImportMode(['--dry-run', '--apply'])).toThrow(/only one mode/i);
    expect(() => parsePilotImportMode(['--dry-run', '--dry-run'])).toThrow(/unknown arguments/i);
    expect(() => parsePilotImportMode(['--other'])).toThrow(/unknown arguments/i);
  });

  it('requires explicit actor email and asset root before Payload initialization', async () => {
    const initializePayload = vi.fn();

    await expect(initializePilotDryRun([], {}, 'D:/workspace', initializePayload)).rejects.toThrow(
      /CONTENT_IMPORT_AI_EDITOR_EMAIL/,
    );
    expect(initializePayload).not.toHaveBeenCalled();
    await expect(initializePilotDryRun([], {
      CONTENT_IMPORT_AI_EDITOR_EMAIL: 'pilot-ai@example.test',
    }, 'D:/workspace', initializePayload)).rejects.toThrow(/CONTENT_IMPORT_ASSET_ROOT/);
    expect(initializePayload).not.toHaveBeenCalled();
    expect(requirePilotImportEnvironment({
      CONTENT_IMPORT_AI_EDITOR_EMAIL: ' pilot-ai@example.test ',
      CONTENT_IMPORT_ASSET_ROOT: ' content/pilot/final ',
    }, 'D:/workspace')).toEqual({
      actorEmail: 'pilot-ai@example.test',
      assetRoot: 'D:\\workspace\\content\\pilot\\final',
    });
  });

  it('rejects apply before Payload initialization until Task 7 implements it', async () => {
    const initializePayload = vi.fn();

    await expect(initializePilotDryRun(['--apply'], {
      CONTENT_IMPORT_AI_EDITOR_EMAIL: 'pilot-ai@example.test',
      CONTENT_IMPORT_ASSET_ROOT: 'content/pilot/final',
    }, 'D:/workspace', initializePayload)).rejects.toThrow(/not implemented/i);
    expect(initializePayload).not.toHaveBeenCalled();
  });

  it('rejects destructive database environment before Payload/config initialization', async () => {
    const initializePayload = vi.fn();

    await expect(initializePilotDryRun([], {
      CONTENT_IMPORT_AI_EDITOR_EMAIL: 'pilot-ai@example.test',
      CONTENT_IMPORT_ASSET_ROOT: 'content/pilot/final',
      PAYLOAD_DROP_DATABASE: 'true',
    }, 'D:/workspace', initializePayload)).rejects.toThrow(/PAYLOAD_DROP_DATABASE/);
    expect(initializePayload).not.toHaveBeenCalled();
  });

  it('resolves the same workspace from repository and apps/cms working directories', () => {
    const original = process.cwd();
    const expected = resolvePilotWorkspaceRoot();
    try {
      process.chdir(expected);
      expect(resolvePilotWorkspaceRoot()).toBe(expected);
      process.chdir(join(expected, 'apps/cms'));
      expect(resolvePilotWorkspaceRoot()).toBe(expected);
    } finally {
      process.chdir(original);
    }
  });
});

function existingCardFor(seed: SiteContentMatrix['cards'][number]): ExistingCard {
  const collection = matrix.collections.find((item) => item.key === seed.collectionKey);
  if (!collection) throw new Error(`Missing collection ${seed.collectionKey}.`);
  return {
    id: Number(seed.pilotId),
    alt: seed.alt,
    caption: seed.caption,
    collectionPaths: [collection.path],
    description: seed.description,
    h1: seed.h1,
    imageAssignedFilename: seed.sourceFile.replace(/\.jpg$/u, '-2.jpg'),
    imageHeight: 1280,
    imageMimeType: 'image/jpeg',
    imageRevision: validRevision,
    imageWidth: 1024,
    metaDescription: seed.metaDescription,
    pathClaimKey: `pilot-card-${seed.pilotId}`,
    robots: seed.robots,
    slug: seed.slug,
    status: seed.status,
    title: seed.title,
    usageTerms: seed.usageTerms,
  };
}

function matchingCardClaim(existing: ExistingCard): ExistingContentPathClaim {
  return {
    ownerCollection: 'cards',
    ownerKey: `cards:${String(existing.pathClaimKey)}`,
    path: `/otkrytki/${existing.slug}`,
  };
}

function matchingCollectionClaim(existing: ExistingCollection): ExistingContentPathClaim {
  return {
    ownerCollection: 'collections',
    ownerKey: `collections:${String(existing.pathClaimKey)}`,
    path: existing.path,
  };
}

function lexicalParagraph(existing: ExistingCollection): { children: unknown[] } {
  const root = (existing.intro as { root: { children: Array<{ children: unknown[] }> } }).root;
  const paragraph = root.children[0];
  if (!paragraph) throw new Error('Expected Lexical paragraph.');
  return paragraph;
}

function lexicalTextNode(existing: ExistingCollection): Record<string, unknown> {
  const node = lexicalParagraph(existing).children[0];
  if (typeof node !== 'object' || node === null) throw new Error('Expected Lexical text node.');
  return node as Record<string, unknown>;
}

function existingCollectionFor(
  seed: SiteContentMatrix['collections'][number],
): ExistingCollection {
  const parent = seed.parentKey === null
    ? null
    : matrix.collections.find((item) => item.key === seed.parentKey)?.path ?? null;
  return {
    id: `collection-${seed.key}`,
    description: seed.description,
    h1: seed.h1,
    intro: pilotIntroDocument(seed.intro),
    metaDescription: seed.metaDescription,
    nodeKind: seed.nodeKind,
    parentPath: parent,
    path: seed.path,
    pathClaimKey: `pilot-collection-${seed.key}`,
    robots: seed.robots,
    slug: seed.slug,
    status: seed.status,
    title: seed.title,
  };
}
