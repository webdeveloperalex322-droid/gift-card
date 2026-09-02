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
  {
    key: 'generated-mame', slug: 'mame', path: '/otkrytki/prazdniki/den-rozhdeniya/mame',
    parentPath: '/otkrytki/prazdniki/den-rozhdeniya', nodeKind: 'recipient',
    title: 'Открытки маме на день рождения с душевными пожеланиями', h1: 'Открытки маме на день рождения',
    metaDescription: 'Красивые поздравительные открытки маме на день рождения: цветы, домашнее тепло и искренние пожелания.',
    intro: 'Для маминого дня рождения здесь собраны нежные цветочные сюжеты и спокойные домашние сцены. Тексты говорят о любви, благодарности и радости быть рядом.',
    description: 'Нежные открытки для мамы с цветами, уютными деталями и сердечными поздравлениями.',
    status: 'draft', robots: 'noindex,follow',
  },
  {
    key: 'generated-podruge', slug: 'podruge', path: '/otkrytki/prazdniki/den-rozhdeniya/podruge',
    parentPath: '/otkrytki/prazdniki/den-rozhdeniya', nodeKind: 'recipient',
    title: 'Открытки подруге на день рождения — яркие и тёплые', h1: 'Открытки подруге на день рождения',
    metaDescription: 'Открытки подруге на день рождения с цветами, праздничными деталями и добрыми словами о дружбе.',
    intro: 'Поздравление подруге может быть лёгким, весёлым или особенно душевным. В подборке — выразительные иллюстрации и пожелания, которыми приятно поделиться в её праздник.',
    description: 'Яркие поздравления подруге о дружбе, новых впечатлениях и счастливых событиях.',
    status: 'draft', robots: 'noindex,follow',
  },
  {
    key: 'generated-1-maya', slug: '1-maya', path: '/otkrytki/prazdniki/1-maya', parentPath: '/otkrytki/prazdniki', nodeKind: 'occasion',
    title: 'Советские открытки к 1 Мая', h1: 'Открытки к 1 Мая',
    metaDescription: 'Открытки к 1 Мая в советской стилистике: весенние ветви, голуби, праздничные флаги и пожелания мира.',
    intro: 'Первомайские сюжеты обращаются к визуальному языку советской открытки: весеннему небу, цветущим ветвям, голубям и праздничному городу. Поздравления желают мира, труда в радость и добрых перемен.',
    description: 'Весенние ретро-открытки к Первомаю с мирными и праздничными образами.',
    status: 'draft', robots: 'noindex,follow',
  },
  {
    key: 'generated-den-materi', slug: 'den-materi', path: '/otkrytki/prazdniki/den-materi', parentPath: '/otkrytki/prazdniki', nodeKind: 'occasion',
    title: 'Открытки ко Дню матери с благодарностью и любовью', h1: 'Открытки ко Дню матери',
    metaDescription: 'Тёплые открытки ко Дню матери с нежными иллюстрациями и искренними словами благодарности.',
    intro: 'День матери — повод сказать о том, что часто остаётся между строк. Эти открытки соединяют мягкие семейные образы, цветы и благодарные пожелания для самого близкого человека.',
    description: 'Душевные поздравления маме с нежными семейными и цветочными сюжетами.',
    status: 'draft', robots: 'noindex,follow',
  },
  {
    key: 'generated-den-svadby', slug: 'den-svadby', path: '/otkrytki/prazdniki/den-svadby', parentPath: '/otkrytki/prazdniki', nodeKind: 'occasion',
    title: 'Свадебные открытки с пожеланиями молодожёнам', h1: 'Открытки на свадьбу',
    metaDescription: 'Свадебные открытки для молодожёнов: кольца, цветы, праздничный стол и пожелания любви на долгие годы.',
    intro: 'Свадебная открытка сохраняет настроение важного дня: торжественное, нежное и радостное. Здесь есть лаконичные композиции и подробные праздничные сцены с пожеланиями согласия и счастливой совместной жизни.',
    description: 'Элегантные поздравления молодожёнам с символами любви, семьи и общего будущего.',
    status: 'draft', robots: 'noindex,follow',
  },
  {
    key: 'generated-den-uchitelya', slug: 'den-uchitelya', path: '/otkrytki/prazdniki/den-uchitelya', parentPath: '/otkrytki/prazdniki', nodeKind: 'occasion',
    title: 'Открытки ко Дню учителя с уважением и благодарностью', h1: 'Открытки ко Дню учителя',
    metaDescription: 'Поздравительные открытки учителям с осенними мотивами, книгами и словами признательности за знания и поддержку.',
    intro: 'В День учителя хочется поблагодарить за терпение, внимание и умение вдохновлять. Осенние букеты, книги и школьные детали сопровождают уважительные поздравления без лишней официальности.',
    description: 'Осенние поздравления педагогам со словами уважения за знания, труд и поддержку.',
    status: 'draft', robots: 'noindex,follow',
  },
  {
    key: 'generated-paskha', slug: 'paskha', path: '/otkrytki/prazdniki/paskha', parentPath: '/otkrytki/prazdniki', nodeKind: 'occasion',
    title: 'Открытки на Пасху с добрыми пожеланиями', h1: 'Открытки на Пасху',
    metaDescription: 'Светлые пасхальные открытки с весенними цветами, куличами и пожеланиями мира, тепла и добра.',
    intro: 'Пасхальные открытки наполнены тихим весенним светом и домашним теплом. Цветы, свечи и праздничные угощения помогают передать близким пожелания мира, надежды и добра.',
    description: 'Светлые пасхальные открытки с весенними цветами, куличами и тёплыми словами для семьи и друзей.',
    status: 'draft', robots: 'noindex,follow',
  },
  {
    key: 'generated-rozhdenie-malysha', slug: 'rozhdenie-malysha', path: '/otkrytki/prazdniki/rozhdenie-malysha', parentPath: '/otkrytki/prazdniki', nodeKind: 'occasion',
    title: 'Открытки с рождением малыша для счастливой семьи', h1: 'Открытки с рождением малыша',
    metaDescription: 'Нежные открытки с рождением ребёнка: колыбели, игрушки и добрые пожелания малышу и родителям.',
    intro: 'Рождение ребёнка меняет привычный мир семьи. Нежные иллюстрации с колыбелями, игрушками и звёздами сопровождают пожелания здоровья малышу, спокойных ночей и счастья родителям.',
    description: 'Трогательные поздравления семье с появлением малыша и началом новой счастливой главы.',
    status: 'draft', robots: 'noindex,follow',
  },
  {
    key: 'generated-rozhdestvo', slug: 'rozhdestvo', path: '/otkrytki/prazdniki/rozhdestvo', parentPath: '/otkrytki/prazdniki', nodeKind: 'occasion',
    title: 'Рождественские открытки с теплом зимнего праздника', h1: 'Открытки на Рождество',
    metaDescription: 'Рождественские открытки со свечами, зимним светом, семейным уютом и пожеланиями мира и благополучия.',
    intro: 'Рождество связывает зимнюю тишину, свет свечей и тепло семейной встречи. В открытках — спокойные праздничные образы и пожелания мира, веры и благополучия дому.',
    description: 'Светлые зимние поздравления с атмосферой семейного Рождества и домашнего уюта.',
    status: 'draft', robots: 'noindex,follow',
  },
  {
    key: 'generated-yubiley', slug: 'yubiley', path: '/otkrytki/prazdniki/yubiley', parentPath: '/otkrytki/prazdniki', nodeKind: 'occasion',
    title: 'Открытки на юбилей с торжественными пожеланиями', h1: 'Открытки на юбилей',
    metaDescription: 'Праздничные открытки на юбилей с элегантными композициями и пожеланиями здоровья, успехов и радости.',
    intro: 'Юбилейное поздравление отмечает пройденный путь и всё хорошее впереди. Торжественные цветы, золото и праздничный свет дополняют пожелания здоровья, уважения и новых счастливых лет.',
    description: 'Торжественные открытки для значимой даты с достойными и сердечными пожеланиями.',
    status: 'draft', robots: 'noindex,follow',
  },
  {
    key: 'generated-spasibo', slug: 'spasibo', path: '/otkrytki/pozhelaniya/spasibo', parentPath: '/otkrytki/pozhelaniya', nodeKind: 'occasion',
    title: 'Открытки «Спасибо» с искренними словами благодарности', h1: 'Открытки со словами благодарности',
    metaDescription: 'Красивые открытки, чтобы сказать спасибо за помощь, заботу, поддержку или приятный подарок.',
    intro: 'Иногда короткое «спасибо» говорит больше длинной речи. Цветочные, уютные и лаконичные открытки помогут поблагодарить за поддержку, заботу, помощь или добрый поступок.',
    description: 'Искренние открытки благодарности для близких, друзей, коллег и всех, кто оказался рядом.',
    status: 'draft', robots: 'noindex,follow',
  },
];

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
    description: `${headline} ${wish} ${alt}.`,
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
