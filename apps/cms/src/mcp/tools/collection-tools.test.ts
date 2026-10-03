import { describe, expect, it } from 'vitest';

import { COLLECTION_TOOLS } from './collection-tools';
import { createFakeGateway } from './fake-gateway';
import { type WriteOutcome } from './types';

function tool(name: string) {
  const found = COLLECTION_TOOLS.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`Инструмент ${name} не объявлен`);
  }
  return found;
}

describe('create_collection_draft', () => {
  it('создаёт узел в draft и не передаёт ни пути, ни статуса публикации', async () => {
    const gateway = createFakeGateway({});
    const result = (await tool('create_collection_draft').run(
      { gateway },
      { nodeKind: 'occasion', slug: '8-marta', title: '8 марта' },
    )) as WriteOutcome;

    expect(result.created).toBe(true);
    const sent = gateway.calls.createCollection[0] ?? {};
    expect(sent.status).toBe('draft');
    expect(sent).not.toHaveProperty('path');
    expect(sent).not.toHaveProperty('robots');
  });

  it('повторный вызов на том же уровне ничего не создаёт', async () => {
    const gateway = createFakeGateway({
      collections: [{ id: 3, parent: 1, slug: 'mame', status: 'draft' }],
    });
    const result = (await tool('create_collection_draft').run(
      { gateway },
      { nodeKind: 'recipient', parentId: '1', slug: 'mame', title: 'Маме' },
    )) as WriteOutcome;

    expect(result).toMatchObject({ created: false, id: 3 });
    expect(gateway.calls.createCollection).toHaveLength(0);
  });

  it('тот же slug под другим родителем создаётся: уникален путь, а не сегмент', async () => {
    const gateway = createFakeGateway({
      collections: [{ id: 3, parent: 1, slug: 'mame', status: 'draft' }],
    });
    const result = (await tool('create_collection_draft').run(
      { gateway },
      { nodeKind: 'recipient', parentId: '2', slug: 'mame', title: 'Маме' },
    )) as WriteOutcome;

    expect(result.created).toBe(true);
  });

  it('создание корневой группы не находит одноимённый узел под родителем', async () => {
    // Узел «prazdniki» уже есть, но он лежит ПОД родителем. Вызов на создание
    // КОРНЕВОЙ группы с тем же slug обязан создать запись, а не отдать чужую:
    // иначе модель получила бы путь не той подборки и дальше правила бы её тексты.
    const gateway = createFakeGateway({
      collections: [
        { id: 5, parent: 1, path: '/otkrytki/adresaty/prazdniki', slug: 'prazdniki', status: 'draft' },
      ],
    });

    const result = (await tool('create_collection_draft').run(
      { gateway },
      { nodeKind: 'group', slug: 'prazdniki', title: 'Праздники' },
    )) as WriteOutcome;

    expect(result.created).toBe(true);
    expect(gateway.calls.createCollection).toHaveLength(1);
    // Поиск шёл именно по «корневому» условию, а не по одному slug.
    expect(gateway.calls.findCollections[0]?.where).toEqual({
      and: [{ slug: { equals: 'prazdniki' } }, { parent: { exists: false } }],
    });
  });

  it('отказ сервера про недопустимого родителя передаётся наружу дословно', async () => {
    const gateway = createFakeGateway({});
    gateway.createCollection = () =>
      Promise.reject(
        new Error('Группирующий узел живёт только в корне /otkrytki: родитель задан, а вид — group.'),
      );
    await expect(
      tool('create_collection_draft').run(
        { gateway },
        { nodeKind: 'group', parentId: '1', slug: 'prazdniki', title: 'Праздники' },
      ),
    ).rejects.toThrow(/только в корне \/otkrytki/);
  });

  it('вид узла ограничен закрытым набором', () => {
    expect(tool('create_collection_draft').schema.nodeKind).toMatchObject({
      enum: ['group', 'occasion', 'recipient'],
    });
  });
});

describe('update_collection_text', () => {
  it('правит только переданные поля', async () => {
    const gateway = createFakeGateway({
      collections: [{ id: 3, path: '/otkrytki/prazdniki/8-marta', status: 'draft', title: 'Старый' }],
    });
    await tool('update_collection_text').run(
      { gateway },
      { path: '/otkrytki/prazdniki/8-marta', title: 'Новый' },
    );
    expect(gateway.calls.updateCollection[0]?.data).toEqual({ title: 'Новый' });
  });

  it('схема не объявляет ни slug, ни robots, ни canonical', () => {
    const schema = tool('update_collection_text').schema;
    expect(schema).not.toHaveProperty('slug');
    expect(schema).not.toHaveProperty('robots');
    expect(schema).not.toHaveProperty('canonical');
  });
});

describe('send_to_review', () => {
  const FULL_CARD = {
    alt: 'Тюльпаны',
    caption: 'С праздником',
    collections: [1],
    id: 7,
    image: 9,
    metaDescription: 'Открытка маме на 8 марта',
    slug: 'a',
    status: 'draft',
    title: 'Открытка маме',
  };

  it('переводит полную карточку в review и не трогает robots', async () => {
    const gateway = createFakeGateway({ cards: [{ ...FULL_CARD }] });
    const result = (await tool('send_to_review').run(
      { gateway },
      { id: '7', kind: 'card' },
    )) as WriteOutcome;

    expect(result.status).toBe('review');
    expect(gateway.calls.updateCard[0]?.data).toEqual({ status: 'review' });
  });

  it('отказ хука о неполноте передаётся наружу дословно, со списком полей', async () => {
    // Полноту проверяет ОДИН хук коллекции: только он знает набор полей схемы.
    // Инструмент обязан донести его текст до модели неизменным — по нему модель
    // и понимает, что дозаполнить.
    const gateway = createFakeGateway({
      cards: [{ ...FULL_CARD, caption: null, metaDescription: null }],
    });
    gateway.updateCard = () =>
      Promise.reject(
        new Error(
          'Перевод в review невозможен: не заполнено — meta description, подпись или текст ' +
            'поздравления.',
        ),
      );

    await expect(tool('send_to_review').run({ gateway }, { id: '7', kind: 'card' })).rejects.toThrow(
      /meta description/,
    );
    expect(gateway.rows.cards[0]?.status).toBe('draft');
  });

  it('из published в review не переводит', async () => {
    const gateway = createFakeGateway({ cards: [{ ...FULL_CARD, status: 'published' }] });
    await expect(tool('send_to_review').run({ gateway }, { id: '7', kind: 'card' })).rejects.toThrow(
      /только draft/,
    );
  });

  it('повторный вызов на записи, уже переведённой в review, отказывает', async () => {
    const gateway = createFakeGateway({ cards: [{ ...FULL_CARD, status: 'review' }] });
    await expect(tool('send_to_review').run({ gateway }, { id: '7', kind: 'card' })).rejects.toThrow(
      /только draft/,
    );
  });

  it('работает и для подборки, с её собственным списком требований', async () => {
    const gateway = createFakeGateway({
      collections: [
        {
          description: 'Описание',
          id: 3,
          intro: { root: { children: [{ children: [{ text: 'Вводный текст' }] }] } },
          metaDescription: 'Описание для поиска',
          path: '/otkrytki/prazdniki/8-marta',
          related: [4],
          responsibleEditor: 1,
          status: 'draft',
          title: '8 марта',
        },
      ],
    });
    const result = (await tool('send_to_review').run(
      { gateway },
      { id: '3', kind: 'collection' },
    )) as WriteOutcome;
    expect(result.status).toBe('review');
  });

  it('не пытается судить о полноте сам: отправляет статус и доверяет хуку', async () => {
    // У подборки без перелинковки переход обязан не состояться — но решает это хук
    // коллекции, а не инструмент. Инструмент проверяется на том, что он ОТПРАВИЛ
    // ровно смену статуса и ничего больше: ни robots, ни даты публикации.
    const gateway = createFakeGateway({
      collections: [
        {
          description: 'Описание',
          id: 3,
          metaDescription: 'Описание для поиска',
          path: '/otkrytki/prazdniki/8-marta',
          status: 'draft',
          title: '8 марта',
        },
      ],
    });
    await tool('send_to_review').run({ gateway }, { id: '3', kind: 'collection' });
    expect(gateway.calls.updateCollection[0]?.data).toEqual({ status: 'review' });
  });

  it('ответ прямо говорит, что запись всё ещё noindex и вне sitemap', async () => {
    const gateway = createFakeGateway({ cards: [{ ...FULL_CARD }] });
    const result = (await tool('send_to_review').run({ gateway }, { id: '7', kind: 'card' })) as {
      note: string;
    };
    expect(result.note).toMatch(/noindex и вне sitemap/);
  });

  it('статуса published в схеме нет', () => {
    expect(tool('send_to_review').schema.kind).toMatchObject({ enum: ['card', 'collection'] });
    expect(tool('send_to_review').schema).not.toHaveProperty('status');
  });
});
