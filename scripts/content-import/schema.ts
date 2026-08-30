import { readFile } from 'node:fs/promises';
import type { CardRecord } from '../content-pilot/manifest.mjs';

export interface CollectionSeed {
  key: string;
  slug: string;
  nodeKind: 'group' | 'occasion' | 'recipient';
  parentKey: string | null;
  path: string;
  title: string;
  h1: string;
  metaDescription: string;
  intro: string;
  description: string;
  leafTopic: boolean;
  status: 'draft';
  robots: 'noindex,follow';
}

export interface CardSeed {
  pilotId: string;
  collectionKey: string;
  sourceFile: string;
  slug: string;
  title: string;
  h1: string;
  metaDescription: string;
  alt: string;
  caption: string;
  description: string;
  usageTerms: null;
  status: 'draft';
  robots: 'noindex,follow';
}

export interface SiteContentMatrix {
  collections: CollectionSeed[];
  cards: CardSeed[];
}

interface ExpectedCollection {
  slug: string;
  nodeKind: CollectionSeed['nodeKind'];
  parentKey: string | null;
  path: string;
  leafTopic: boolean;
}

const expectedCollections: Readonly<Record<string, ExpectedCollection>> = {
  prazdniki: {
    slug: 'prazdniki',
    nodeKind: 'group',
    parentKey: null,
    path: '/otkrytki/prazdniki',
    leafTopic: false,
  },
  'den-rozhdeniya': {
    slug: 'den-rozhdeniya',
    nodeKind: 'occasion',
    parentKey: 'prazdniki',
    path: '/otkrytki/prazdniki/den-rozhdeniya',
    leafTopic: false,
  },
  'den-rozhdeniya-zhenshchine': {
    slug: 'zhenshchine',
    nodeKind: 'recipient',
    parentKey: 'den-rozhdeniya',
    path: '/otkrytki/prazdniki/den-rozhdeniya/zhenshchine',
    leafTopic: true,
  },
  'den-rozhdeniya-muzhchine': {
    slug: 'muzhchine',
    nodeKind: 'recipient',
    parentKey: 'den-rozhdeniya',
    path: '/otkrytki/prazdniki/den-rozhdeniya/muzhchine',
    leafTopic: true,
  },
  'novyy-god': {
    slug: 'novyy-god',
    nodeKind: 'occasion',
    parentKey: 'prazdniki',
    path: '/otkrytki/prazdniki/novyy-god',
    leafTopic: true,
  },
  '8-marta': {
    slug: '8-marta',
    nodeKind: 'occasion',
    parentKey: 'prazdniki',
    path: '/otkrytki/prazdniki/8-marta',
    leafTopic: true,
  },
  '23-fevralya': {
    slug: '23-fevralya',
    nodeKind: 'occasion',
    parentKey: 'prazdniki',
    path: '/otkrytki/prazdniki/23-fevralya',
    leafTopic: true,
  },
  '9-maya': {
    slug: '9-maya',
    nodeKind: 'occasion',
    parentKey: 'prazdniki',
    path: '/otkrytki/prazdniki/9-maya',
    leafTopic: true,
  },
  '14-fevralya': {
    slug: '14-fevralya',
    nodeKind: 'occasion',
    parentKey: 'prazdniki',
    path: '/otkrytki/prazdniki/14-fevralya',
    leafTopic: true,
  },
  pozhelaniya: {
    slug: 'pozhelaniya',
    nodeKind: 'group',
    parentKey: null,
    path: '/otkrytki/pozhelaniya',
    leafTopic: false,
  },
  'dobroe-utro': {
    slug: 'dobroe-utro',
    nodeKind: 'occasion',
    parentKey: 'pozhelaniya',
    path: '/otkrytki/pozhelaniya/dobroe-utro',
    leafTopic: true,
  },
  'horoshego-dnya': {
    slug: 'horoshego-dnya',
    nodeKind: 'occasion',
    parentKey: 'pozhelaniya',
    path: '/otkrytki/pozhelaniya/horoshego-dnya',
    leafTopic: true,
  },
  'spokoynoy-nochi': {
    slug: 'spokoynoy-nochi',
    nodeKind: 'occasion',
    parentKey: 'pozhelaniya',
    path: '/otkrytki/pozhelaniya/spokoynoy-nochi',
    leafTopic: true,
  },
};

const collectionByPilotId = new Map<string, string>([
  ...assignments(1, 5, 'den-rozhdeniya-zhenshchine'),
  ...assignments(6, 10, 'den-rozhdeniya-muzhchine'),
  ...assignments(11, 15, 'dobroe-utro'),
  ...assignments(16, 20, 'horoshego-dnya'),
  ...assignments(21, 25, 'spokoynoy-nochi'),
  ...assignments(26, 30, 'novyy-god'),
  ...assignments(31, 35, '8-marta'),
  ...assignments(36, 40, '23-fevralya'),
  ...assignments(41, 45, '9-maya'),
  ...assignments(46, 50, '14-fevralya'),
]);

function ids(first: number, last: number): string[] {
  return Array.from(
    { length: last - first + 1 },
    (_, index) => String(first + index).padStart(2, '0'),
  );
}

function assignments(first: number, last: number, key: string): Array<readonly [string, string]> {
  return ids(first, last).map((id) => [id, key] as const);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase('ru-RU');
}

function hasDuplicateNormalized(records: readonly Record<string, unknown>[], field: string): boolean {
  const values = records
    .map((record) => record[field])
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map(normalized);
  return new Set(values).size !== values.length;
}

function requireText(
  errors: string[],
  record: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  for (const field of fields) {
    if (typeof record[field] !== 'string' || record[field].trim() === '') {
      errors.push(`${label} ${field} must be a non-empty string.`);
    }
  }
}

function filenameSlug(fileName: string): string {
  return fileName.endsWith('.jpg') ? fileName.slice(0, -4) : fileName;
}

export async function loadSiteContent(path: string): Promise<SiteContentMatrix> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.collections) || !Array.isArray(parsed.cards)) {
    throw new Error('Site content matrix must contain collections and cards arrays.');
  }
  return {
    collections: parsed.collections as CollectionSeed[],
    cards: parsed.cards as CardSeed[],
  };
}

export function validateSiteContent(matrix: unknown, manifest: readonly CardRecord[]): string[] {
  const errors: string[] = [];
  if (!isRecord(matrix) || !Array.isArray(matrix.collections) || !Array.isArray(matrix.cards)) {
    return ['Site content matrix must contain collections and cards arrays.'];
  }

  const collections = matrix.collections.filter(isRecord);
  const cards = matrix.cards.filter(isRecord);
  if (collections.length !== matrix.collections.length) errors.push('Every collection must be an object.');
  if (cards.length !== matrix.cards.length) errors.push('Every card must be an object.');
  if (matrix.collections.length !== 13) errors.push('Matrix must contain exactly 13 collection nodes.');
  if (matrix.cards.length !== 50) errors.push('Matrix must contain exactly 50 cards.');

  const collectionsByKey = new Map<string, Record<string, unknown>>();
  for (const collection of collections) {
    const key = typeof collection.key === 'string' ? collection.key : 'unknown';
    requireText(
      errors,
      collection,
      ['key', 'slug', 'path', 'title', 'h1', 'metaDescription', 'intro', 'description'],
      `Collection ${key}`,
    );
    if (collectionsByKey.has(key)) errors.push(`Collection key ${key} must be unique.`);
    collectionsByKey.set(key, collection);

    const expected = expectedCollections[key];
    if (!expected) {
      errors.push(`Collection ${key} is not part of the approved taxonomy.`);
    } else {
      for (const field of ['slug', 'nodeKind', 'parentKey', 'path', 'leafTopic'] as const) {
        if (collection[field] !== expected[field]) {
          errors.push(`Collection ${key} ${field} must be ${String(expected[field])}.`);
        }
      }
    }
    if (collection.status !== 'draft' || collection.robots !== 'noindex,follow') {
      errors.push(`Collection ${key} must remain draft with noindex,follow.`);
    }
    if (collection.leafTopic === true && (
      typeof collection.intro !== 'string' || collection.intro.trim().length < 120
    )) {
      errors.push(`Leaf collection ${key} intro must contain at least 120 characters.`);
    }
  }
  for (const key of Object.keys(expectedCollections)) {
    if (!collectionsByKey.has(key)) errors.push(`Approved collection ${key} is missing.`);
  }
  if (collections.filter((collection) => collection.leafTopic === true).length !== 10) {
    errors.push('Matrix must contain exactly 10 leaf collections.');
  }

  for (const [field, label] of [
    ['title', 'title'],
    ['h1', 'h1'],
    ['metaDescription', 'metaDescription'],
  ] as const) {
    if (hasDuplicateNormalized(collections, field)) {
      errors.push(`Collection ${label} values must be unique after normalization.`);
    }
  }

  const manifestById = new Map(manifest.map((record) => [record.id, record]));
  const cardsByPilotId = new Map<string, Record<string, unknown>>();
  for (const card of cards) {
    const pilotId = typeof card.pilotId === 'string' ? card.pilotId : 'unknown';
    requireText(
      errors,
      card,
      ['pilotId', 'collectionKey', 'sourceFile', 'slug', 'title', 'h1', 'metaDescription', 'alt', 'caption', 'description'],
      `Card ${pilotId}`,
    );
    if (cardsByPilotId.has(pilotId)) errors.push(`Card pilotId ${pilotId} must be unique.`);
    cardsByPilotId.set(pilotId, card);

    const manifestCard = manifestById.get(pilotId);
    if (!manifestCard) {
      errors.push(`Matrix card ${pilotId} does not exist in the manifest.`);
    } else {
      const expectedCollection = collectionByPilotId.get(pilotId);
      if (card.collectionKey !== expectedCollection) {
        errors.push(`Card ${pilotId} must belong to collection ${expectedCollection}.`);
      }
      if (card.sourceFile !== manifestCard.fileName) {
        errors.push(`Card ${pilotId} sourceFile must match the accepted manifest exactly.`);
      }
      const expectedSlug = filenameSlug(manifestCard.fileName);
      if (card.slug !== expectedSlug) {
        errors.push(`Card ${pilotId} slug must equal ${expectedSlug}.`);
      }
      if (card.alt !== manifestCard.alt) {
        errors.push(`Card ${pilotId} alt must match the accepted manifest exactly.`);
      }
      if (card.caption !== `${manifestCard.headline} ${manifestCard.wish}`) {
        errors.push(`Card ${pilotId} caption must be the exact manifest headline plus wish.`);
      }
    }

    if (typeof card.collectionKey === 'string') {
      const collection = collectionsByKey.get(card.collectionKey);
      if (!collection || collection.leafTopic !== true) {
        errors.push(`Card ${pilotId} must reference an approved leaf collection.`);
      }
    }
    if (typeof card.description !== 'string' || card.description.trim().length < 40) {
      errors.push(`Card ${pilotId} description must contain at least 40 characters.`);
    }
    if (card.status !== 'draft' || card.robots !== 'noindex,follow') {
      errors.push(`Card ${pilotId} must remain draft with noindex,follow.`);
    }
    if (card.usageTerms !== null) {
      errors.push(`Card ${pilotId} usageTerms must remain null until a human approves legal wording.`);
    }
  }

  for (const manifestCard of manifest) {
    if (!cardsByPilotId.has(manifestCard.id)) {
      errors.push(`Manifest card ${manifestCard.id} is missing from the matrix.`);
    }
  }
  if (new Set(cards.map((card) => card.slug)).size !== cards.length) {
    errors.push('Card slug values must be unique.');
  }
  for (const [field, label] of [
    ['title', 'title'],
    ['h1', 'h1'],
    ['metaDescription', 'metaDescription'],
  ] as const) {
    if (hasDuplicateNormalized(cards, field)) {
      errors.push(`Card ${label} values must be unique after normalization.`);
    }
  }
  const allContent = [...collections, ...cards];
  for (const [field, label] of [
    ['title', 'title'],
    ['h1', 'h1'],
    ['metaDescription', 'metaDescription'],
  ] as const) {
    if (hasDuplicateNormalized(allContent, field)) {
      errors.push(`Content ${label} values must be unique after normalization.`);
    }
  }

  return errors;
}
