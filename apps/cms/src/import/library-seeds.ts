import { basename, extname } from 'node:path';

import type { GeneratedLibraryPlan, NormalizedGeneratedManifestRow } from './library-manifest';

interface ThemeDefinition {
  readonly path: string;
  readonly label: string;
}

const THEMES: Readonly<Record<string, ThemeDefinition>> = {
  '14 Февраля': { path: '/otkrytki/prazdniki/14-fevralya', label: '14 Февраля' },
  '23 Февраля': { path: '/otkrytki/prazdniki/23-fevralya', label: '23 Февраля' },
  '8 Марта': { path: '/otkrytki/prazdniki/8-marta', label: '8 Марта' },
  '9 Мая': { path: '/otkrytki/prazdniki/9-maya', label: '9 Мая' },
  '1 Мая': { path: '/otkrytki/prazdniki/1-maya', label: '1 Мая' },
  'День рождения женщине': { path: '/otkrytki/prazdniki/den-rozhdeniya/zhenshchine', label: 'день рождения женщине' },
  'День рождения мужчине': { path: '/otkrytki/prazdniki/den-rozhdeniya/muzhchine', label: 'день рождения мужчине' },
  'День рождения маме': { path: '/otkrytki/prazdniki/den-rozhdeniya/mame', label: 'день рождения маме' },
  'День рождения подруге': { path: '/otkrytki/prazdniki/den-rozhdeniya/podruge', label: 'день рождения подруге' },
  'День матери': { path: '/otkrytki/prazdniki/den-materi', label: 'День матери' },
  'День свадьбы': { path: '/otkrytki/prazdniki/den-svadby', label: 'день свадьбы' },
  'День учителя': { path: '/otkrytki/prazdniki/den-uchitelya', label: 'День учителя' },
  'Доброе утро': { path: '/otkrytki/pozhelaniya/dobroe-utro', label: 'доброе утро' },
  'Новый год': { path: '/otkrytki/prazdniki/novyy-god', label: 'Новый год' },
  'Пасха': { path: '/otkrytki/prazdniki/paskha', label: 'Пасху' },
  'Рождение малыша': { path: '/otkrytki/prazdniki/rozhdenie-malysha', label: 'рождение малыша' },
  'Рождество Христово': { path: '/otkrytki/prazdniki/rozhdestvo', label: 'Рождество' },
  'Спасибо': { path: '/otkrytki/pozhelaniya/spasibo', label: 'слова благодарности' },
  'Спокойной ночи': { path: '/otkrytki/pozhelaniya/spokoynoy-nochi', label: 'спокойную ночь' },
  'Хорошего дня': { path: '/otkrytki/pozhelaniya/horoshego-dnya', label: 'хороший день' },
  'Юбилей': { path: '/otkrytki/prazdniki/yubiley', label: 'юбилей' },
};

export interface GeneratedCollectionSeed {
  readonly key: string;
  readonly slug: string;
  readonly path: string;
  readonly parentPath: string;
  readonly nodeKind: 'occasion' | 'recipient';
  readonly title: string;
  readonly h1: string;
  readonly metaDescription: string;
  readonly intro: string;
  readonly description: string;
  readonly relatedPaths: readonly string[];
  readonly status: 'draft';
  readonly robots: 'noindex,follow';
}

export interface GeneratedCardSeed {
  readonly sourceSha256: string;
  readonly sourceFile: string;
  readonly sourcePng: string;
  readonly squareFile: string | null;
  readonly slug: string;
  readonly title: string;
  readonly h1: string;
  readonly metaDescription: string;
  readonly alt: string;
  readonly caption: string;
  readonly description: string;
  readonly usageTerms: '';
  readonly collectionPath: string;
  readonly status: 'draft';
  readonly robots: 'noindex,follow';
}

export interface GeneratedLibrarySeeds {
  readonly collections: readonly GeneratedCollectionSeed[];
  readonly cards: readonly GeneratedCardSeed[];
}

const NEW_COLLECTIONS: readonly Omit<GeneratedCollectionSeed, 'relatedPaths'>[] = [
  ['mame', '/otkrytki/prazdniki/den-rozhdeniya/mame', '/otkrytki/prazdniki/den-rozhdeniya', 'recipient', 'Открытки маме на день рождения'],
  ['podruge', '/otkrytki/prazdniki/den-rozhdeniya/podruge', '/otkrytki/prazdniki/den-rozhdeniya', 'recipient', 'Открытки подруге на день рождения'],
  ['1-maya', '/otkrytki/prazdniki/1-maya', '/otkrytki/prazdniki', 'occasion', 'Открытки к 1 Мая'],
  ['den-materi', '/otkrytki/prazdniki/den-materi', '/otkrytki/prazdniki', 'occasion', 'Открытки ко Дню матери'],
  ['den-svadby', '/otkrytki/prazdniki/den-svadby', '/otkrytki/prazdniki', 'occasion', 'Открытки на свадьбу'],
  ['den-uchitelya', '/otkrytki/prazdniki/den-uchitelya', '/otkrytki/prazdniki', 'occasion', 'Открытки ко Дню учителя'],
  ['paskha', '/otkrytki/prazdniki/paskha', '/otkrytki/prazdniki', 'occasion', 'Открытки на Пасху'],
  ['rozhdenie-malysha', '/otkrytki/prazdniki/rozhdenie-malysha', '/otkrytki/prazdniki', 'occasion', 'Открытки с рождением малыша'],
  ['rozhdestvo', '/otkrytki/prazdniki/rozhdestvo', '/otkrytki/prazdniki', 'occasion', 'Открытки на Рождество'],
  ['yubiley', '/otkrytki/prazdniki/yubiley', '/otkrytki/prazdniki', 'occasion', 'Открытки на юбилей'],
  ['spasibo', '/otkrytki/pozhelaniya/spasibo', '/otkrytki/pozhelaniya', 'occasion', 'Открытки со словами благодарности'],
].map(([slug, path, parentPath, nodeKind, h1]) => ({
  key: `generated-${slug}`,
  slug,
  path,
  parentPath,
  nodeKind,
  title: `${h1} — выбрать и скачать`,
  h1,
  metaDescription: `${h1}: оригинальные иллюстрации и тёплые поздравления для близких.`,
  intro: `${h1} собраны в этой тематической подборке. Выберите подходящую иллюстрацию и текст поздравления.`,
  description: `Тематическая подборка «${h1}» с оригинальными открытками.`,
  status: 'draft',
  robots: 'noindex,follow',
})) as readonly Omit<GeneratedCollectionSeed, 'relatedPaths'>[];

export function collectionPathForTheme(theme: string): string {
  const definition = THEMES[theme];
  if (definition === undefined) throw new Error(`Unknown generated-library theme: ${theme}.`);
  return definition.path;
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function slugFor(row: NormalizedGeneratedManifestRow): string {
  const filename = row.fileName === undefined ? basename(row.finalPath) : basename(row.fileName);
  if (filename.length > 68) throw new Error(`Portrait filename exceeds 68 characters: ${filename}.`);
  const stem = basename(filename, extname(filename)).toLowerCase();
  if (/^\d+$/u.test(stem)) {
    if (row.package !== 'soviet-holidays-2026-08') {
      throw new Error(`Portrait filename has a numeric-only slug outside the Soviet exception: ${filename}.`);
    }
    const themeSlug = collectionPathForTheme(row.theme).split('/').at(-1);
    const ordinal = stem.padStart(2, '0');
    return `otkrytka-${themeSlug}-sovetskaya-${ordinal}`;
  }
  return stem;
}

function cardSeed(row: NormalizedGeneratedManifestRow): GeneratedCardSeed {
  const theme = THEMES[row.theme];
  if (theme === undefined) throw new Error(`Unknown generated-library theme: ${row.theme}.`);
  const alt = normalized(row.alt);
  const headline = normalized(row.headline);
  const wish = normalized(row.wish);
  return {
    sourceSha256: row.sourceSha256,
    sourceFile: row.finalPath,
    sourcePng: row.backgroundPath,
    squareFile: typeof row.squarePath === 'string' ? row.squarePath : null,
    slug: slugFor(row),
    title: `${headline} — ${alt}`,
    h1: `${headline} ${alt}`,
    metaDescription: `${alt}. ${wish}`,
    alt,
    caption: `${headline} ${wish}`,
    description: `${alt}. На открытке размещено поздравление: «${headline} ${wish}»`,
    usageTerms: '',
    collectionPath: theme.path,
    status: 'draft',
    robots: 'noindex,follow',
  };
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = normalized(value).toLocaleLowerCase('ru');
    if (seen.has(key)) throw new Error(`Duplicate ${label}: ${value}.`);
    seen.add(key);
  }
}

export function validateGeneratedLibrarySeeds(seeds: GeneratedLibrarySeeds): void {
  for (const card of seeds.cards) {
    const fields = ['title', 'h1', 'metaDescription', 'alt', 'caption', 'description', 'collectionPath'] as const;
    for (const field of fields) {
      if (normalized(card[field]) === '') throw new Error(`Card ${card.sourceSha256} has empty ${field}.`);
    }
    if (card.status !== 'draft') throw new Error(`Card ${card.sourceSha256} status must be draft.`);
    if (card.robots !== 'noindex,follow') throw new Error(`Card ${card.sourceSha256} robots must be noindex,follow.`);
    if (card.slug.length > 80) throw new Error(`Card slug exceeds 80 characters: ${card.slug}.`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(card.slug) || /^\d+$/u.test(card.slug)) {
      throw new Error(`Invalid card slug: ${card.slug}.`);
    }
    if (/(?:^|-)(?:19|20)\d{2}(?:-|$)/u.test(card.slug)) throw new Error(`Card slug contains a year: ${card.slug}.`);
  }
  assertUnique(seeds.cards.map(({ slug }) => slug), 'card slug');
  assertUnique(seeds.cards.map(({ title }) => title), 'card title');
  assertUnique(seeds.cards.map(({ h1 }) => h1), 'card H1');
  assertUnique(seeds.cards.map(({ metaDescription }) => metaDescription), 'card meta description');
  assertUnique(seeds.cards.map(({ sourceFile }) => sourceFile), 'portrait final path');
}

export function buildGeneratedLibrarySeeds(plan: GeneratedLibraryPlan): GeneratedLibrarySeeds {
  const collections = NEW_COLLECTIONS.map((seed) => ({
    ...seed,
    relatedPaths: [
      seed.parentPath,
      ...NEW_COLLECTIONS.filter((candidate) => candidate.parentPath === seed.parentPath && candidate.path !== seed.path)
        .map(({ path }) => path),
    ],
  }));
  const seeds = { collections, cards: plan.creationCandidates.map(({ representative }) => cardSeed(representative)) };
  validateGeneratedLibrarySeeds(seeds);
  return seeds;
}
