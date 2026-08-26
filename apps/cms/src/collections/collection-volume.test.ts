/**
 * Наполненность подборки: две границы (Ч-06, п. 5.1) — чистые правила.
 *
 * Здесь проверяются сами правила: где стоит какая граница, область подсчёта по
 * видам узла, текст отказа и разбор параметра окружения. Проводка (что «совсем
 * пусто» закрывает именно `published`, а порог — именно `index,follow`, и что
 * считаются ОПУБЛИКОВАННЫЕ записи) проверяется на стенде хуков —
 * `content-hooks.test.ts`.
 *
 * Главное утверждение этого файла — что границы НЕ ПЕРЕПУТАНЫ: порог на
 * публикации запрещал бы человеку держать небольшую подборку открытой для людей
 * и закрытой для поиска, а «пусто» только на индексации оставляло бы 200 с
 * пустой сеткой и битые ссылки на него.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MIN_PUBLISHED_CARDS,
  MIN_PUBLISHED_CARDS_ENV_KEY,
  VOLUME_SCOPE,
  assertEnoughCardsForIndex,
  assertNotEmptyForPublish,
  resolveMinPublishedCards,
} from './collection-volume';
import { ContentRuleError, type ContentRuleCode } from './status-model';

function expectRefusal(rule: ContentRuleCode, run: () => void): ContentRuleError {
  try {
    run();
  } catch (error) {
    if (error instanceof ContentRuleError) {
      expect(error.rule).toBe(rule);
      return error;
    }
    throw error;
  }
  throw new Error('Ожидался отказ правила, но его не было');
}

describe('порог как параметр (решение Ч-06)', () => {
  it('утверждённое значение — 20', () => {
    expect(DEFAULT_MIN_PUBLISHED_CARDS).toBe(20);
    expect(resolveMinPublishedCards({})).toBe(20);
    expect(resolveMinPublishedCards({ [MIN_PUBLISHED_CARDS_ENV_KEY]: '   ' })).toBe(20);
  });

  it('значение из окружения переопределяет дефолт', () => {
    expect(resolveMinPublishedCards({ [MIN_PUBLISHED_CARDS_ENV_KEY]: '30' })).toBe(30);
    expect(resolveMinPublishedCards({ [MIN_PUBLISHED_CARDS_ENV_KEY]: ' 2 ' })).toBe(2);
  });

  it('мусорное значение — ошибка, а не молчаливый возврат к дефолту', () => {
    expect(() => resolveMinPublishedCards({ [MIN_PUBLISHED_CARDS_ENV_KEY]: 'двадцать' })).toThrow(
      MIN_PUBLISHED_CARDS_ENV_KEY,
    );
    expect(() => resolveMinPublishedCards({ [MIN_PUBLISHED_CARDS_ENV_KEY]: '4.5' })).toThrow();
    expect(() => resolveMinPublishedCards({ [MIN_PUBLISHED_CARDS_ENV_KEY]: '-1' })).toThrow();
  });

  it('нулевой порог запрещён: он отменил бы условие п. 5.1', () => {
    expect(() => resolveMinPublishedCards({ [MIN_PUBLISHED_CARDS_ENV_KEY]: '0' })).toThrow(
      'Ноль недопустим',
    );
  });
});

describe('первая граница: пустой узел не публикуется', () => {
  it('одна опубликованная открытка или один опубликованный ребёнок — уже не пусто', () => {
    expect(() =>
      assertNotEmptyForPublish({
        path: '/podborki/prazdniki/8-marta',
        publishedCards: 1,
        publishedChildren: 0,
      }),
    ).not.toThrow();
    expect(() =>
      assertNotEmptyForPublish({
        path: '/podborki/prazdniki',
        publishedCards: 0,
        publishedChildren: 1,
      }),
    ).not.toThrow();
  });

  it('ни открыток, ни детей — отказ, и он объясняет 404 и битую ссылку', () => {
    const error = expectRefusal('empty-for-publish', () =>
      assertNotEmptyForPublish({
        path: '/podborki/prazdniki/8-marta',
        publishedCards: 0,
        publishedChildren: 0,
      }),
    );
    expect(error.message).toContain('/podborki/prazdniki/8-marta');
    expect(error.message).toContain('404');
    expect(error.message).toContain('битую внутреннюю ссылку');
  });

  it('пять открыток публикации не мешают: порог — не условие публикации', () => {
    // Ключевое разграничение: опубликованная страница с небольшим содержанием в
    // noindex,follow законна. Если однажды порог переедет на публикацию, упадёт
    // этот тест.
    expect(() =>
      assertNotEmptyForPublish({
        path: '/podborki/prazdniki/8-marta',
        publishedCards: 5,
        publishedChildren: 0,
      }),
    ).not.toThrow();
  });
});

describe('вторая граница: порог п. 5.1 на переходе в index,follow', () => {
  it('на пороге и выше индексация не блокируется', () => {
    for (const publishedCards of [20, 41]) {
      expect(() =>
        assertEnoughCardsForIndex({
          nodeKind: 'occasion',
          path: '/podborki/prazdniki/8-marta',
          publishedCards,
          threshold: 20,
        }),
      ).not.toThrow();
    }
  });

  it('ниже порога — жёсткий отказ, называющий фактическое число и порог', () => {
    const error = expectRefusal('thin-content-for-index', () =>
      assertEnoughCardsForIndex({
        nodeKind: 'occasion',
        path: '/podborki/prazdniki/8-marta',
        publishedCards: 7,
        threshold: 20,
      }),
    );
    expect(error.message).toContain('7');
    expect(error.message).toContain('20');
    expect(error.message).toContain('index,follow');
    expect(error.message).toContain('Ч-06');
    expect(error.message).toContain(MIN_PUBLISHED_CARDS_ENV_KEY);
    // Отказ обязан сказать, что публикация при этом законна: иначе редактор
    // прочтёт его как «страницу нельзя показывать вовсе».
    expect(error.message).toContain('noindex,follow');
  });

  it('повод и уточнение считают своё содержание, группа — поддерево', () => {
    expect(VOLUME_SCOPE).toEqual({ group: 'subtree', occasion: 'own', recipient: 'own' });
  });

  it('у группирующего узла отказ объясняет, что считалось поддерево', () => {
    const error = expectRefusal('thin-content-for-index', () =>
      assertEnoughCardsForIndex({
        nodeKind: 'group',
        path: '/podborki/prazdniki',
        publishedCards: 3,
        threshold: 20,
      }),
    );
    expect(error.message).toContain('поддереве');
  });
});
