import { describe, expect, it } from 'vitest';

import { DEFAULT_MIN_PUBLISHED_CARDS } from '../../collections/collection-volume';
import { createFakeGateway } from './fake-gateway';
import { READ_TOOLS } from './read-tools';
import { ToolRefusal } from './types';

function tool(name: string) {
  const found = READ_TOOLS.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`Инструмент ${name} не объявлен`);
  }
  return found;
}

describe('catalog_overview', () => {
  it('считает опубликованные открытки узла и нехватку до порога', async () => {
    const gateway = createFakeGateway({
      cards: [
        { collections: [1], id: 11, status: 'published' },
        { collections: [1], id: 12, status: 'published' },
        { collections: [1], id: 13, status: 'draft' },
      ],
      collections: [
        { id: 1, nodeKind: 'occasion', path: '/otkrytki/prazdniki/8-marta', status: 'published' },
      ],
    });

    const result = (await tool('catalog_overview').run({ gateway }, {})) as {
      nodes: { missingForIndex: number; publishedCards: number }[];
    };

    expect(result.nodes[0]?.publishedCards).toBe(2);
    expect(result.nodes[0]?.missingForIndex).toBe(DEFAULT_MIN_PUBLISHED_CARDS - 2);
  });

  it('у группирующего узла считает поддерево, иначе его объём был бы нулевым всегда', async () => {
    const gateway = createFakeGateway({
      cards: [
        { collections: [2], id: 11, status: 'published' },
        { collections: [2], id: 12, status: 'published' },
      ],
      collections: [
        { id: 1, nodeKind: 'group', path: '/otkrytki/prazdniki', status: 'published' },
        { id: 2, nodeKind: 'occasion', parent: 1, path: '/otkrytki/prazdniki/8-marta' },
      ],
    });

    const result = (await tool('catalog_overview').run({ gateway }, { nodeKind: 'group' })) as {
      nodes: { publishedCards: number; volumeScope: string }[];
    };

    expect(result.nodes[0]?.volumeScope).toBe('subtree');
    expect(result.nodes[0]?.publishedCards).toBe(2);
  });

  it('черновики в счёт опубликованных не идут', async () => {
    const gateway = createFakeGateway({
      cards: [{ collections: [1], id: 11, status: 'draft' }],
      collections: [{ id: 1, nodeKind: 'occasion', path: '/otkrytki/prazdniki/8-marta' }],
    });
    const result = (await tool('catalog_overview').run({ gateway }, {})) as {
      nodes: { publishedCards: number }[];
    };
    expect(result.nodes[0]?.publishedCards).toBe(0);
  });

  it('признак усечения выставляется, когда отдано не всё', async () => {
    const gateway = createFakeGateway({
      collections: [
        { id: 1, nodeKind: 'occasion', path: '/otkrytki/a' },
        { id: 2, nodeKind: 'occasion', path: '/otkrytki/b' },
      ],
    });
    const result = (await tool('catalog_overview').run({ gateway }, { limit: 1 })) as {
      returned: number;
      total: number;
      truncated: boolean;
    };
    expect(result).toMatchObject({ returned: 1, total: 2, truncated: true });
  });

  it('оговаривает, что выполненный порог не равен разрешению на индексацию', async () => {
    const gateway = createFakeGateway({
      collections: [{ id: 1, nodeKind: 'occasion', path: '/otkrytki/a' }],
    });
    const result = (await tool('catalog_overview').run({ gateway }, {})) as { note: string };
    expect(result.note).toMatch(/решение принимает человек/);
  });
});

describe('collection_get', () => {
  it('отдаёт узел, детей и карточки', async () => {
    const gateway = createFakeGateway({
      cards: [{ collections: [1], id: 11, slug: 'otkrytka', status: 'review', title: 'Открытка' }],
      collections: [
        { id: 1, nodeKind: 'occasion', path: '/otkrytki/prazdniki/8-marta', title: 'Праздник' },
        { id: 2, nodeKind: 'recipient', parent: 1, path: '/otkrytki/prazdniki/8-marta/mame' },
      ],
    });

    const result = (await tool('collection_get').run(
      { gateway },
      { path: '/otkrytki/prazdniki/8-marta' },
    )) as { cards: { path: string }[]; children: { path: string }[]; node: { title: string } };

    expect(result.node.title).toBe('Праздник');
    expect(result.children[0]?.path).toBe('/otkrytki/prazdniki/8-marta/mame');
    expect(result.cards[0]?.path).toBe('/otkrytki/otkrytka');
  });

  it('отсутствие узла — отказ, а не пустой результат', async () => {
    const gateway = createFakeGateway({});
    await expect(
      tool('collection_get').run({ gateway }, { path: '/otkrytki/net' }),
    ).rejects.toBeInstanceOf(ToolRefusal);
  });

  it('без id и path отказывает', async () => {
    const gateway = createFakeGateway({});
    await expect(tool('collection_get').run({ gateway }, {})).rejects.toThrow(/либо id, либо path/);
  });
});

describe('card_get', () => {
  it('отдаёт поля карточки и её путь', async () => {
    const gateway = createFakeGateway({
      cards: [
        {
          alt: 'Тюльпаны',
          collections: [1, 2],
          id: 11,
          image: 5,
          slug: 'otkrytka-mame',
          status: 'draft',
          title: 'Открытка маме',
        },
      ],
    });
    const result = (await tool('card_get').run({ gateway }, { slug: 'otkrytka-mame' })) as {
      collectionIds: unknown[];
      hasImage: boolean;
      imageId: unknown;
      path: string;
    };
    expect(result.path).toBe('/otkrytki/otkrytka-mame');
    expect(result.hasImage).toBe(true);
    expect(result.imageId).toBe(5);
    expect(result.collectionIds).toEqual([1, 2]);
  });

  it('несуществующая карточка — отказ', async () => {
    const gateway = createFakeGateway({});
    await expect(tool('card_get').run({ gateway }, { slug: 'net' })).rejects.toBeInstanceOf(
      ToolRefusal,
    );
  });
});

describe('find_weak_content', () => {
  it('находит повтор metaDescription у двух карточек', async () => {
    const gateway = createFakeGateway({
      cards: [
        {
          alt: 'a',
          collections: [1],
          id: 11,
          image: 1,
          metaDescription: 'Открытка  маме',
          slug: 'a',
          title: 'A',
        },
        {
          alt: 'b',
          collections: [1],
          id: 12,
          image: 2,
          metaDescription: 'открытка маме',
          slug: 'b',
          title: 'B',
        },
      ],
    });
    const result = (await tool('find_weak_content').run({ gateway }, {})) as {
      cards: { problems: string[] }[];
    };
    expect(result.cards).toHaveLength(2);
    for (const finding of result.cards) {
      expect(finding.problems.join(' ')).toMatch(/metaDescription повторяется/);
    }
  });

  it('называет карточку без изображения, без alt и без привязок', async () => {
    const gateway = createFakeGateway({
      cards: [{ id: 11, metaDescription: 'Уникально', slug: 'a', title: 'A' }],
    });
    const result = (await tool('find_weak_content').run({ gateway }, {})) as {
      cards: { problems: string[] }[];
    };
    const problems = result.cards[0]?.problems.join(' ') ?? '';
    expect(problems).toMatch(/нет изображения/);
    expect(problems).toMatch(/alt не заполнен/);
    expect(problems).toMatch(/не привязана/);
  });

  it('полностью заполненная запись в находки не попадает', async () => {
    const gateway = createFakeGateway({
      cards: [
        {
          alt: 'a',
          collections: [1],
          id: 11,
          image: 1,
          metaDescription: 'Уникально',
          slug: 'a',
          title: 'A',
        },
      ],
    });
    const result = (await tool('find_weak_content').run({ gateway }, {})) as { cards: unknown[] };
    expect(result.cards).toEqual([]);
  });
});

describe('check_duplicates', () => {
  it('находит совпадение title независимо от регистра и пробелов', async () => {
    const gateway = createFakeGateway({
      cards: [{ id: 11, slug: 'a', title: 'Открытка маме' }],
    });
    const result = (await tool('check_duplicates').run(
      { gateway },
      { title: '  ОТКРЫТКА   МАМЕ  ' },
    )) as { conflicts: { field: string; id: number }[] };
    expect(result.conflicts).toEqual([
      expect.objectContaining({ field: 'title', id: 11, path: '/otkrytki/a' }),
    ]);
  });

  it('не считает совпадением саму правимую запись', async () => {
    const gateway = createFakeGateway({ cards: [{ id: 11, slug: 'a', title: 'Открытка' }] });
    const result = (await tool('check_duplicates').run(
      { gateway },
      { excludeId: '11', title: 'Открытка' },
    )) as { conflicts: unknown[] };
    expect(result.conflicts).toEqual([]);
  });

  it('без title и metaDescription отказывает', async () => {
    const gateway = createFakeGateway({});
    await expect(tool('check_duplicates').run({ gateway }, {})).rejects.toThrow(
      /хотя бы title или metaDescription/,
    );
  });

  it('прямо говорит, что визуальных дублей не ищет', async () => {
    const gateway = createFakeGateway({});
    const result = (await tool('check_duplicates').run({ gateway }, { title: 'x' })) as {
      note: string;
    };
    expect(result.note).toMatch(/pHash/);
  });
});

describe('объявления читающих инструментов', () => {
  it('все помечены readOnly: клиент не должен спрашивать подтверждение на чтение', () => {
    expect(READ_TOOLS.every((definition) => definition.readOnly)).toBe(true);
  });

  it('имена уникальны', () => {
    const names = READ_TOOLS.map((definition) => definition.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
