import type { PayloadRequest } from 'payload';
import { describe, expect, it } from 'vitest';

import {
  attachCollectionsInBulk,
  bulkUpdateContextKey,
  isBulkUpdate,
  markBulkUpdate,
  mergeCardCollections,
  readRelationIdList,
} from './card-collections';

describe('чтение связи «карточка → подборки»', () => {
  it('принимает и идентификаторы, и развёрнутые документы, сохраняя порядок', () => {
    expect(readRelationIdList([3, '7', { id: 11 }])).toEqual([3, '7', 11]);
  });

  it('одиночное значение читается как список из одного', () => {
    expect(readRelationIdList(4)).toEqual([4]);
    expect(readRelationIdList({ id: '4' })).toEqual(['4']);
  });

  it('пустое и непонятное значение дают пустой список, а не бросают', () => {
    expect(readRelationIdList(null)).toEqual([]);
    expect(readRelationIdList(undefined)).toEqual([]);
    expect(readRelationIdList([])).toEqual([]);
    expect(readRelationIdList([{ noId: 1 }, true])).toEqual([]);
  });
});

/**
 * Главное свойство массовой привязки: она ДОБАВЛЯЕТ.
 *
 * Первая подборка в связи — основная: из неё строятся хлебные крошки карточки
 * (описание поля `collections` в `cards.ts`). Замена списка одной операцией на
 * выборку карточек переставила бы основную подборку у всех, кому её уже выбрали
 * осмысленно, — и сделала бы это молча, потому что ни одно правило проекта на
 * порядок связи не смотрит.
 */
describe('слияние подборок при массовой привязке', () => {
  it('добавляет в конец, не трогая порядок уже выбранных', () => {
    expect(mergeCardCollections({ existing: [5, 9], incoming: [12] })).toEqual([5, 9, 12]);
  });

  it('первая подборка остаётся первой, даже если её же прислали в привязке', () => {
    expect(mergeCardCollections({ existing: [5, 9], incoming: [9, 5] })).toEqual([5, 9]);
  });

  it('у карточки без подборок привязанная становится первой — другой основной нет', () => {
    expect(mergeCardCollections({ existing: [], incoming: [12] })).toEqual([12]);
  });

  it('повторы внутри самой привязки не дублируются', () => {
    expect(mergeCardCollections({ existing: [], incoming: [12, '12', { id: 12 }, 13] })).toEqual([
      12, 13,
    ]);
  });

  it('идентификатор числом и строкой — одна и та же подборка', () => {
    expect(mergeCardCollections({ existing: ['5'], incoming: [5] })).toEqual(['5']);
  });

  it('развёрнутые документы в текущем значении не разворачивают связь обратно в документы', () => {
    // На глубине по умолчанию Payload отдаёт в связи весь документ. Записывать
    // его обратно нельзя: в поле связи идёт идентификатор.
    expect(mergeCardCollections({ existing: [{ id: 5, title: 'Восьмое марта' }], incoming: [7] })).toEqual([
      5, 7,
    ]);
  });

  it('пустая привязка ничего не меняет', () => {
    expect(mergeCardCollections({ existing: [5], incoming: [] })).toEqual([5]);
  });
});

describe('ключ признака пакетной операции', () => {
  it('свой у каждой коллекции: пакет по карточкам не выдаёт себя за пакет по подборкам', () => {
    expect(bulkUpdateContextKey('cards')).not.toBe(bulkUpdateContextKey('collections'));
  });

  it('признак ставится и читается только для своей коллекции', () => {
    const req = { context: {} } as unknown as PayloadRequest;
    expect(isBulkUpdate(req, 'cards')).toBe(false);
    markBulkUpdate(req, 'collections');
    expect(isBulkUpdate(req, 'cards')).toBe(false);
    markBulkUpdate(req, 'cards');
    expect(isBulkUpdate(req, 'cards')).toBe(true);
  });
});

describe('хук привязки: пакет добавляет, одиночная правка заменяет', () => {
  const hook = attachCollectionsInBulk();

  const run = (args: {
    readonly bulk: boolean;
    readonly incoming: Record<string, unknown>;
    readonly stored: Record<string, unknown>;
  }): unknown => {
    const req = { context: {} } as unknown as PayloadRequest;
    if (args.bulk) {
      markBulkUpdate(req, 'cards');
    }
    return hook({
      collection: null,
      context: {},
      // Стенд повторяет Payload буквально: в beforeValidate приходят СЛИТЫЕ
      // данные, а прежнее состояние — отдельно, в originalDoc.
      data: { ...args.stored, ...args.incoming },
      operation: 'update',
      originalDoc: args.stored,
      req,
    } as unknown as Parameters<typeof hook>[0]);
  };

  it('в пакете подборка добавляется к уже выбранным', () => {
    expect(
      run({ bulk: true, incoming: { collections: [12] }, stored: { collections: [5, 9] } }),
    ).toMatchObject({ collections: [5, 9, 12] });
  });

  it('в пакете карточка без подборок получает привязанную', () => {
    expect(
      run({ bulk: true, incoming: { collections: [12] }, stored: { collections: [] } }),
    ).toMatchObject({ collections: [12] });
  });

  it('вне пакета список заменяется: в форме редактор видит связь целиком', () => {
    expect(
      run({ bulk: false, incoming: { collections: [12] }, stored: { collections: [5, 9] } }),
    ).toMatchObject({ collections: [12] });
  });

  it('пакет, не касающийся связи, её не трогает', () => {
    expect(
      run({ bulk: true, incoming: { status: 'review' }, stored: { collections: [5] } }),
    ).toMatchObject({ collections: [5], status: 'review' });
  });
});
