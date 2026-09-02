import { describe, expect, it } from 'vitest';

import type { GeneratedLibraryPlan, NormalizedGeneratedManifestRow } from './library-manifest';
import {
  buildGeneratedLibrarySeeds,
  collectionPathForTheme,
  validateGeneratedLibrarySeeds,
} from './library-seeds';

function candidate(overrides: Partial<NormalizedGeneratedManifestRow> = {}): NormalizedGeneratedManifestRow {
  return {
    id: 'A-01',
    package: 'popular-next10-2026-08',
    manifestOrder: 0,
    sourceSha256: 'a'.repeat(64),
    theme: 'Пасха',
    backgroundPath: 'paskha/backgrounds/01.png',
    finalPath: 'paskha/final/otkrytka-paskha-vesennie-tsvety.jpg',
    headline: 'С Пасхой!',
    wish: 'Света, мира и добра вашему дому!',
    alt: 'Пасхальная открытка с весенними цветами и куличом',
    ...overrides,
  };
}

function plan(rows: NormalizedGeneratedManifestRow[]): GeneratedLibraryPlan {
  const groups = rows.map((representative) => ({ sourceSha256: representative.sourceSha256, representative, rows: [representative] }));
  return {
    rows,
    groups,
    creationCandidates: groups,
    aliases: [],
    sourceRowCount: rows.length,
    uniqueSourceCount: rows.length,
    pilotRowCount: 0,
    pilotRepeatedOutsideCount: 0,
    sovietRepeatedInPopularCount: 0,
  };
}

describe('generated library seeds', () => {
  it.each([
    ['День рождения маме', '/otkrytki/prazdniki/den-rozhdeniya/mame'],
    ['День рождения подруге', '/otkrytki/prazdniki/den-rozhdeniya/podruge'],
    ['1 Мая', '/otkrytki/prazdniki/1-maya'],
    ['Пасха', '/otkrytki/prazdniki/paskha'],
    ['Спасибо', '/otkrytki/pozhelaniya/spasibo'],
    ['Новый год', '/otkrytki/prazdniki/novyy-god'],
  ])('maps %s to %s', (theme, path) => {
    expect(collectionPathForTheme(theme)).toBe(path);
  });

  it('builds eleven new collection seeds and complete draft-only card content', () => {
    const seeds = buildGeneratedLibrarySeeds(plan([candidate()]));
    expect(seeds.collections).toHaveLength(11);
    expect(seeds.cards).toEqual([
      expect.objectContaining({
        slug: 'otkrytka-paskha-vesennie-tsvety',
        collectionPath: '/otkrytki/prazdniki/paskha',
        status: 'draft',
        robots: 'noindex,follow',
        usageTerms: '',
      }),
    ]);
    expect(seeds.cards[0]?.title).not.toBe(seeds.cards[0]?.metaDescription);
    expect(seeds.cards[0]?.description).not.toMatch(/На открытке размещено|Тематическая подборка/u);
    expect(seeds.collections.find(({ path }) => path.endsWith('/paskha'))).toMatchObject({
      title: 'Открытки на Пасху с добрыми пожеланиями',
      h1: 'Открытки на Пасху',
      description: 'Светлые пасхальные открытки с весенними цветами, куличами и тёплыми словами для семьи и друзей.',
    });
    expect(new Set(seeds.collections.map(({ intro }) => intro))).toHaveLength(11);
  });

  it('derives a descriptive slug only for numeric Soviet filenames', () => {
    const row = candidate({
      id: 'MAY-07', package: 'soviet-holidays-2026-08', theme: '1 Мая',
      finalPath: '1-maya/final/07.jpg', manifestOrder: 6,
    });
    expect(buildGeneratedLibrarySeeds(plan([row])).cards[0]?.slug)
      .toBe('otkrytka-1-maya-sovetskaya-07');
  });

  it('rejects numeric filenames outside the closed Soviet exception and unknown themes', () => {
    expect(() => buildGeneratedLibrarySeeds(plan([candidate({ finalPath: 'final/07.jpg' })])))
      .toThrow(/numeric-only/u);
    expect(() => buildGeneratedLibrarySeeds(plan([candidate({ theme: 'Неизвестный праздник' })])))
      .toThrow(/Unknown generated-library theme/u);
  });

  it('rejects duplicate SEO fields, slug collisions, invalid lengths, and forbidden states', () => {
    const first = candidate();
    const second = candidate({ sourceSha256: 'b'.repeat(64), id: 'A-02' });
    expect(() => buildGeneratedLibrarySeeds(plan([first, second]))).toThrow(/Duplicate card slug/u);

    const valid = buildGeneratedLibrarySeeds(plan([first]));
    expect(() => validateGeneratedLibrarySeeds({
      ...valid,
      cards: [{ ...valid.cards[0]!, status: 'published' as 'draft' }],
    })).toThrow(/status must be draft/u);
    expect(() => buildGeneratedLibrarySeeds(plan([candidate({
      finalPath: `final/${'a'.repeat(81)}.jpg`, fileName: `${'a'.repeat(81)}.jpg`,
    })]))).toThrow(/filename exceeds 68/u);
  });
});
