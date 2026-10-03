import { describe, expect, it } from 'vitest';

import { CARD_TOOLS } from './card-tools';
import { createFakeGateway } from './fake-gateway';
import { type WriteOutcome, diffApplied } from './types';

function tool(name: string) {
  const found = CARD_TOOLS.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`Инструмент ${name} не объявлен`);
  }
  return found;
}

const FULL_ARGS = {
  alt: 'Тюльпаны на столе',
  metaDescription: 'Открытка маме на 8 марта с тюльпанами',
  slug: 'otkrytka-mame-na-8-marta',
  title: 'Открытка маме на 8 марта',
};

describe('diffApplied', () => {
  it('ловит молчаливо проигнорированное поле', () => {
    expect(diffApplied({ requested: { title: 'Новый' }, saved: { title: 'Старый' } })).toEqual([
      {
        actual: 'Старый',
        field: 'title',
        reason: expect.stringContaining('не применилось'),
        requested: 'Новый',
      },
    ]);
  });

  it('совпадающие значения расхождением не считает', () => {
    expect(diffApplied({ requested: { title: 'Одно' }, saved: { title: 'Одно' } })).toEqual([]);
  });

  it('связи сравнивает по идентификаторам, а не по форме значения', () => {
    expect(
      diffApplied({ requested: { collections: [1, 2] }, saved: { collections: ['2', '1'] } }),
    ).toEqual([]);
  });

  it('поля, которых не просили, не проверяет', () => {
    expect(diffApplied({ requested: {}, saved: { robots: 'noindex,follow' } })).toEqual([]);
  });
});

describe('create_card_draft', () => {
  it('создаёт карточку в draft и не посылает ни статуса published, ни robots', async () => {
    const gateway = createFakeGateway({});
    const result = (await tool('create_card_draft').run({ gateway }, FULL_ARGS)) as WriteOutcome;

    expect(result.created).toBe(true);
    expect(result.path).toBe('/otkrytki/otkrytka-mame-na-8-marta');
    expect(result.ignored).toEqual([]);

    const sent = gateway.calls.createCard[0] ?? {};
    expect(sent.status).toBe('draft');
    expect(sent).not.toHaveProperty('robots');
    expect(sent).not.toHaveProperty('publishedAt');
  });

  it('повторный вызов с тем же slug ничего не создаёт', async () => {
    const gateway = createFakeGateway({
      cards: [{ id: 7, slug: FULL_ARGS.slug, status: 'draft', title: 'Старый заголовок' }],
    });
    const result = (await tool('create_card_draft').run({ gateway }, FULL_ARGS)) as WriteOutcome;

    expect(result).toMatchObject({ created: false, id: 7 });
    expect(gateway.calls.createCard).toHaveLength(0);
  });

  it('повторный вызов не затирает существующие тексты', async () => {
    const gateway = createFakeGateway({
      cards: [{ id: 7, slug: FULL_ARGS.slug, status: 'draft', title: 'Работа редактора' }],
    });
    await tool('create_card_draft').run({ gateway }, FULL_ARGS);
    expect(gateway.rows.cards[0]?.title).toBe('Работа редактора');
    expect(gateway.calls.updateCard).toHaveLength(0);
  });

  it('переживает гонку: уникальный индекс бросил, запись найдена повторным чтением', async () => {
    const gateway = createFakeGateway({ createCardThrowsDuplicateOnce: true });
    const result = (await tool('create_card_draft').run({ gateway }, FULL_ARGS)) as WriteOutcome;
    expect(result.created).toBe(false);
    expect(result.path).toBe('/otkrytki/otkrytka-mame-na-8-marta');
  });

  it('передаёт привязки и изображение, когда они заданы', async () => {
    const gateway = createFakeGateway({});
    await tool('create_card_draft').run(
      { gateway },
      { ...FULL_ARGS, collectionIds: [1, 2], imageId: '9' },
    );
    const sent = gateway.calls.createCard[0] ?? {};
    expect(sent.collections).toEqual([1, 2]);
    expect(sent.image).toBe('9');
  });

  it('схема не объявляет ни status, ни robots: передать их нельзя', () => {
    const schema = tool('create_card_draft').schema;
    expect(schema).not.toHaveProperty('status');
    expect(schema).not.toHaveProperty('robots');
    expect(schema).not.toHaveProperty('canonical');
    expect(schema).not.toHaveProperty('publishedAt');
  });
});

describe('update_card_text', () => {
  it('правит переданные поля и не трогает остальные', async () => {
    const gateway = createFakeGateway({
      cards: [{ alt: 'Прежний alt', id: 7, slug: 'a', status: 'draft', title: 'Старый' }],
    });
    const result = (await tool('update_card_text').run(
      { gateway },
      { slug: 'a', title: 'Новый' },
    )) as WriteOutcome;

    expect(result.ignored).toEqual([]);
    expect(gateway.calls.updateCard[0]?.data).toEqual({ title: 'Новый' });
    expect(gateway.rows.cards[0]?.alt).toBe('Прежний alt');
  });

  it('без текстовых полей отказывает, а не делает пустую запись', async () => {
    const gateway = createFakeGateway({ cards: [{ id: 7, slug: 'a' }] });
    await expect(tool('update_card_text').run({ gateway }, { slug: 'a' })).rejects.toThrow(
      /ни одного текстового поля/,
    );
  });

  it('schema не позволяет сменить slug существующей записи', () => {
    const description = tool('update_card_text').schema.slug?.description ?? '';
    expect(description).toMatch(/Сам slug этим не меняется/);
  });
});

describe('attach_card_to_collections', () => {
  it('добавляет к имеющимся привязкам, а не заменяет их', async () => {
    const gateway = createFakeGateway({
      cards: [{ collections: [1], id: 7, slug: 'a', status: 'draft' }],
    });
    await tool('attach_card_to_collections').run({ gateway }, { collectionIds: [2], slug: 'a' });
    expect(gateway.calls.updateCard[0]?.data.collections).toEqual(['1', '2']);
  });

  it('повторная привязка не дублирует связь', async () => {
    const gateway = createFakeGateway({
      cards: [{ collections: [1], id: 7, slug: 'a', status: 'draft' }],
    });
    await tool('attach_card_to_collections').run({ gateway }, { collectionIds: [1], slug: 'a' });
    expect(gateway.calls.updateCard[0]?.data.collections).toEqual(['1']);
  });
});

describe('detach_card_from_collections', () => {
  it('убирает названные привязки и сохраняет остальные', async () => {
    const gateway = createFakeGateway({
      cards: [{ collections: [1, 2, 3], id: 7, slug: 'a', status: 'draft' }],
    });
    await tool('detach_card_from_collections').run(
      { gateway },
      { collectionIds: [2], slug: 'a' },
    );
    expect(gateway.calls.updateCard[0]?.data.collections).toEqual(['1', '3']);
  });
});

describe('attach_image', () => {
  it('привязывает существующее изображение', async () => {
    const gateway = createFakeGateway({
      cardImages: [{ id: 9 }],
      cards: [{ id: 7, slug: 'a', status: 'draft' }],
    });
    const result = (await tool('attach_image').run(
      { gateway },
      { imageId: '9', slug: 'a' },
    )) as WriteOutcome;
    expect(result.ignored).toEqual([]);
    expect(gateway.calls.updateCard[0]?.data).toEqual({ image: '9' });
  });

  it('несуществующее изображение — отказ с объяснением, откуда берутся файлы', async () => {
    const gateway = createFakeGateway({ cards: [{ id: 7, slug: 'a', status: 'draft' }] });
    await expect(tool('attach_image').run({ gateway }, { imageId: '9', slug: 'a' })).rejects.toThrow(
      /не найдено в card-images/,
    );
  });

  it('сообщает, что молчаливый отказ на поле image виден как расхождение', async () => {
    // Двойник не применяет image: так ведёт себя Payload, когда правило доступа
    // поля запрещает замену изображения опубликованной карточки роли ai-editor.
    const gateway = createFakeGateway({
      cardImages: [{ id: 9 }],
      cards: [{ id: 7, image: 1, slug: 'a', status: 'published' }],
    });
    const original = gateway.updateCard;
    gateway.updateCard = async ({ id }) => {
      void original;
      return gateway.rows.cards.find((row) => String(row.id) === String(id)) as never;
    };

    const result = (await tool('attach_image').run(
      { gateway },
      { imageId: '9', slug: 'a' },
    )) as WriteOutcome;

    expect(result.ignored).toHaveLength(1);
    expect(result.ignored[0]?.field).toBe('image');
  });
});

describe('объявления пишущих инструментов по карточкам', () => {
  it('ни один не помечен readOnly', () => {
    expect(CARD_TOOLS.some((definition) => definition.readOnly)).toBe(false);
  });

  it('инструмента публикации среди них нет', () => {
    const names = CARD_TOOLS.map((definition) => definition.name).join(' ');
    expect(names).not.toMatch(/publish|robots|index/);
  });
});
