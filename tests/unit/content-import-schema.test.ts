import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest } from '../../scripts/content-pilot/manifest.mjs';
import {
  loadSiteContent,
  validateSiteContent,
  type SiteContentMatrix,
} from '../../scripts/content-import/schema.js';

const manifestPath = 'content/pilot-2026-08/manifest.json';
const matrixPath = 'content/pilot-2026-08/site-content.json';
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function loadFixture(): Promise<SiteContentMatrix> {
  return loadSiteContent(matrixPath);
}

describe('pilot site content matrix', () => {
  it('contains the approved taxonomy and fifty safe draft cards', async () => {
    const manifest = await loadManifest(manifestPath);
    const matrix = await loadFixture();

    expect(matrix.collections).toHaveLength(13);
    expect(matrix.cards).toHaveLength(50);
    expect(matrix.collections.filter((item) => item.leafTopic)).toHaveLength(10);
    expect(new Set(matrix.cards.map((item) => item.slug)).size).toBe(50);
    expect(new Set(matrix.cards.map((item) => item.title.trim().toLocaleLowerCase('ru-RU'))).size).toBe(50);
    expect(new Set(matrix.cards.map((item) => item.metaDescription.trim().toLocaleLowerCase('ru-RU'))).size).toBe(50);
    expect(matrix.cards.every((item) => item.status === 'draft' && item.robots === 'noindex,follow')).toBe(true);
    expect(validateSiteContent(matrix, manifest)).toEqual([]);
  });

  it('rejects a collection graph that differs from the approved thirteen nodes', async () => {
    const manifest = await loadManifest(manifestPath);
    const matrix = structuredClone(await loadFixture());
    const birthdayWomen = matrix.collections.find((item) => item.key === 'den-rozhdeniya-zhenshchine');
    if (!birthdayWomen) throw new Error('Expected the women birthday collection.');
    birthdayWomen.path = '/otkrytki/prazdniki/zhenshchine';

    expect(validateSiteContent(matrix, manifest)).toContain(
      'Collection den-rozhdeniya-zhenshchine path must be /otkrytki/prazdniki/den-rozhdeniya/zhenshchine.',
    );
  });

  it('preserves and rejects unknown own enumerable keys at every schema level', async () => {
    const manifest = await loadManifest(manifestPath);
    const source = structuredClone(await loadFixture()) as unknown as {
      collections: Array<Record<string, unknown>>;
      cards: Array<Record<string, unknown>>;
      publishedAt?: string;
    };
    const [collection] = source.collections;
    const [card] = source.cards;
    if (!collection || !card) throw new Error('Expected matrix records.');
    source.publishedAt = '2026-08-30T00:00:00.000Z';
    collection.canonical = 'https://example.test/forbidden';
    card.publishedAt = '2026-08-30T00:00:00.000Z';

    const directory = await mkdtemp(join(tmpdir(), 'otkritka-site-content-'));
    temporaryPaths.push(directory);
    const path = join(directory, 'site-content.json');
    await writeFile(path, JSON.stringify(source), 'utf8');
    const loaded = await loadSiteContent(path);
    const loadedRoot = loaded as unknown as Record<string, unknown>;
    const loadedCollection = loaded.collections[0] as unknown as Record<string, unknown>;
    const loadedCard = loaded.cards[0] as unknown as Record<string, unknown>;

    expect(Object.hasOwn(loadedRoot, 'publishedAt')).toBe(true);
    expect(Object.hasOwn(loadedCollection, 'canonical')).toBe(true);
    expect(Object.hasOwn(loadedCard, 'publishedAt')).toBe(true);
    expect(validateSiteContent(loaded, manifest)).toEqual(expect.arrayContaining([
      'Site content matrix contains unknown key "publishedAt".',
      'Collection prazdniki contains unknown key "canonical".',
      'Card 01 contains unknown key "publishedAt".',
    ]));
  });

  it('does not treat inherited enumerable properties as JSON fields', async () => {
    const manifest = await loadManifest(manifestPath);
    const matrix = structuredClone(await loadFixture());
    const [first] = matrix.cards;
    if (!first) throw new Error('Expected a pilot card.');
    const inherited = Object.assign(
      Object.create({ canonical: 'https://example.test/inherited' }) as Record<string, unknown>,
      first,
    );
    matrix.cards[0] = inherited;

    expect(Object.keys(inherited)).not.toContain('canonical');
    expect(validateSiteContent(matrix, manifest)).toEqual([]);
  });

  it('rejects missing, extra, misplaced, or manifest-divergent cards', async () => {
    const manifest = await loadManifest(manifestPath);
    const matrix = structuredClone(await loadFixture());
    const [first, second, third, fourth] = matrix.cards;
    if (!first || !second || !third || !fourth) throw new Error('Expected four pilot cards.');
    first.pilotId = 'extra';
    second.collectionKey = 'novyy-god';
    third.slug = 'wrong-slug';
    fourth.alt = 'Изменённый alt';

    expect(validateSiteContent(matrix, manifest)).toEqual(expect.arrayContaining([
      'Manifest card 01 is missing from the matrix.',
      'Matrix card extra does not exist in the manifest.',
      'Card 02 must belong to collection den-rozhdeniya-zhenshchine.',
      'Card 03 slug must equal den-rozhdeniya-zhenshchine-buket.',
      'Card 04 alt must match the accepted manifest exactly.',
    ]));
  });

  it('rejects changed source names and captions', async () => {
    const manifest = await loadManifest(manifestPath);
    const matrix = structuredClone(await loadFixture());
    const [first, second] = matrix.cards;
    if (!first || !second) throw new Error('Expected two pilot cards.');
    first.sourceFile = 'other.jpg';
    second.caption = 'Неточная подпись';

    expect(validateSiteContent(matrix, manifest)).toEqual(expect.arrayContaining([
      'Card 01 sourceFile must match the accepted manifest exactly.',
      'Card 02 caption must be the exact manifest headline plus wish.',
    ]));
  });

  it.each(['rejected', 'generated', 'planned'] as const)(
    'rejects a manifest card with %s status',
    async (status) => {
      const manifest = structuredClone(await loadManifest(manifestPath));
      const matrix = await loadFixture();
      const [first] = manifest;
      if (!first) throw new Error('Expected a manifest card.');
      first.status = status;

      expect(validateSiteContent(matrix, manifest)).toContain(
        `Manifest card 01 must have accepted status; received ${status}.`,
      );
    },
  );

  it('rejects normalized duplicate title, H1, and meta description values', async () => {
    const manifest = await loadManifest(manifestPath);
    const matrix = structuredClone(await loadFixture());
    const [first, second] = matrix.cards;
    if (!first || !second) throw new Error('Expected two pilot cards.');
    second.title = `  ${first.title.toLocaleUpperCase('ru-RU')}  `;
    second.h1 = ` ${first.h1.toLocaleUpperCase('ru-RU')} `;
    second.metaDescription = ` ${first.metaDescription.toLocaleUpperCase('ru-RU')} `;

    expect(validateSiteContent(matrix, manifest)).toEqual(expect.arrayContaining([
      'Card title values must be unique after normalization.',
      'Card h1 values must be unique after normalization.',
      'Card metaDescription values must be unique after normalization.',
    ]));
  });

  it('rejects normalized metadata duplicates across cards and collections', async () => {
    const manifest = await loadManifest(manifestPath);
    const matrix = structuredClone(await loadFixture());
    const [collection] = matrix.collections;
    const [card] = matrix.cards;
    if (!collection || !card) throw new Error('Expected a collection and a card.');
    collection.title = ` ${card.title.toLocaleUpperCase('ru-RU')} `;
    collection.h1 = ` ${card.h1.toLocaleUpperCase('ru-RU')} `;
    collection.metaDescription = ` ${card.metaDescription.toLocaleUpperCase('ru-RU')} `;

    expect(validateSiteContent(matrix, manifest)).toEqual(expect.arrayContaining([
      'Content title values must be unique after normalization.',
      'Content h1 values must be unique after normalization.',
      'Content metaDescription values must be unique after normalization.',
    ]));
  });

  it('rejects weak leaf copy and short card descriptions', async () => {
    const manifest = await loadManifest(manifestPath);
    const matrix = structuredClone(await loadFixture());
    const leaf = matrix.collections.find((item) => item.leafTopic);
    const [card] = matrix.cards;
    if (!leaf || !card) throw new Error('Expected a leaf and a card.');
    leaf.intro = 'Слишком короткий текст.';
    card.description = 'Слишком короткий текст.';

    expect(validateSiteContent(matrix, manifest)).toEqual(expect.arrayContaining([
      `Leaf collection ${leaf.key} intro must contain at least 120 characters.`,
      `Card ${card.pilotId} description must contain at least 40 characters.`,
    ]));
  });

  it('rejects publication, indexability, or invented usage terms', async () => {
    const manifest = await loadManifest(manifestPath);
    const matrix = structuredClone(await loadFixture()) as unknown as {
      collections: Array<Record<string, unknown>>;
      cards: Array<Record<string, unknown>>;
    };
    const [collection] = matrix.collections;
    const [card] = matrix.cards;
    if (!collection || !card) throw new Error('Expected matrix records.');
    collection.status = 'published';
    collection.robots = 'index,follow';
    card.status = 'review';
    card.robots = 'index,follow';
    card.usageTerms = 'Можно использовать без ограничений.';

    expect(validateSiteContent(matrix, manifest)).toEqual(expect.arrayContaining([
      'Collection prazdniki must remain draft with noindex,follow.',
      'Card 01 must remain draft with noindex,follow.',
      'Card 01 usageTerms must remain null until a human approves legal wording.',
    ]));
  });
});
