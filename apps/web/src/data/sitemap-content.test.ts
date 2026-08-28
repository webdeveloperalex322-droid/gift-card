/**
 * Директива робота у шаблона и у карты сайта — одна и та же (задача Э4-04).
 *
 * Этот файл проверяет ровно СВЯЗЬ, а не правила по отдельности: сами правила
 * отбора проверяет `tests/unit/web-sitemap.test.ts` (без CMS), а содержимое
 * страниц — `./page-data.test.ts`. Здесь доказывается то, чего ни один из них не
 * видит: что карта сайта спрашивает директиву ТЕМ ЖЕ кодом, которым её печатает
 * страница.
 *
 * Почему это важнее, чем выглядит. Карта сайта отбирает страницы по директиве.
 * Вторая формула — например, «в карту берём всё опубликованное» — дала бы
 * страницу, закрытую `noindex` в разметке и заявленную в карте сайта: прямой
 * запрет п. 23 ТЗ. Обнаружить расхождение можно только сравнением двух значений,
 * и оно здесь.
 *
 * Файл лежит рядом с исходниками по той же причине, что `./page-data.test.ts`:
 * модуль импортирует сгенерированные типы Payload, а composite-проект
 * `apps/web/tsconfig.node.json` файл `.ts` чужого пакета принять не может.
 */
import type { Card, Collection } from '@otkritka/cms/types';
import { describe, expect, it } from 'vitest';

import {
  cardPageContent,
  cardPageRobots,
  collectionLandingRobots,
  collectionPageContent,
  collectionPageRobots,
} from './page-data.js';
import { decideSitemapUrl } from '../seo/sitemap.js';

const ENV = { SITE_URL: 'https://karta.test' } as const;

const VARIANTS = [
  { key: 'cards/a1b2c3d4/otkrytka-mame-640.avif', format: 'avif' as const, width: 640, height: 800 },
  { key: 'cards/a1b2c3d4/otkrytka-mame-640.jpg', format: 'jpeg' as const, width: 640, height: 800 },
];

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: 1,
    alt: 'Букет розовых тюльпанов и надпись «С 8 Марта, мама»',
    createdAt: '2026-01-01T00:00:00.000Z',
    derivative: { variants: VARIANTS },
    metaDescription: 'Открытка маме на 8 Марта с тюльпанами — скачать бесплатно.',
    robots: 'noindex,follow',
    slug: 'otkrytka-mame-na-8-marta',
    status: 'published',
    title: 'Открытка маме на 8 Марта с тюльпанами',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function collection(overrides: Partial<Collection> = {}): Collection {
  return {
    id: 10,
    createdAt: '2026-01-01T00:00:00.000Z',
    metaDescription: 'Открытки на 8 Марта: подборка для мам, коллег и подруг.',
    nodeKind: 'occasion',
    path: '/podborki/prazdniki/8-marta',
    robots: 'noindex,follow',
    slug: '8-marta',
    status: 'published',
    title: 'Открытки на 8 Марта',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('одна формула директивы на шаблон и на карту сайта', () => {
  it('карточка: значение в разметке совпадает с тем, по которому отбирает карта', () => {
    const record = card();
    const content = cardPageContent({
      card: record,
      collections: [],
      env: ENV,
      settings: { id: 1, createdAt: '', updatedAt: '' },
      similar: [],
    });

    expect(content?.robots).toBe(cardPageRobots(record));
  });

  it('карточка без описания закрыта в обоих ответах сразу', () => {
    // Условие п. 22.1: индексируемая страница без description не бывает.
    // Сочинить описание вместо редактора запрещает п. 23.4, поэтому страница
    // остаётся закрытой — и в разметке, и в карте.
    const record = card({ metaDescription: null, robots: 'index,follow' });

    expect(cardPageRobots(record)).toBe('noindex,follow');
    expect(
      decideSitemapUrl(
        {
          canonicalPath: '/otkrytki/otkrytka-mame-na-8-marta',
          pagePath: '/otkrytki/otkrytka-mame-na-8-marta',
          respondsOk: true,
          robots: cardPageRobots(record),
        },
        ENV,
      ).included,
    ).toBe(false);
  });

  it('подборка: посадочная страница спрашивает ту же формулу, что и шаблон', () => {
    const node = collection();
    const content = collectionPageContent({
      cards: [card()],
      children: [],
      env: ENV,
      node,
      page: 1,
      pageCount: 1,
      parent: null,
      related: [],
    });

    expect(content?.robots).toBe(collectionLandingRobots(node));
  });

  it('страница 2 подборки закрыта, и карта сайта её отвергает по директиве', () => {
    const node = collection({ robots: 'index,follow' });
    const content = collectionPageContent({
      cards: [card()],
      children: [],
      env: ENV,
      node,
      page: 2,
      pageCount: 2,
      parent: null,
      related: [],
    });
    const robots = collectionPageRobots({ metaDescription: null, node, page: 2 });

    expect(content?.robots).toBe(robots);
    expect(
      decideSitemapUrl(
        {
          canonicalPath: '/podborki/prazdniki/8-marta/page/2',
          pagePath: '/podborki/prazdniki/8-marta/page/2',
          respondsOk: true,
          robots,
        },
        ENV,
      ).included,
    ).toBe(false);
  });

  it('открытая человеком подборка входит в карту, а её страница 2 — нет', () => {
    // Единственное место, где в этих проверках появляется `index,follow`, —
    // ЗНАЧЕНИЕ ПОЛЯ ЗАПИСИ в фикстуре: так решение человека и выглядит. Ни одна
    // функция кода директиву не поднимает.
    const node = collection({ robots: 'index,follow' });
    const landing = decideSitemapUrl(
      {
        canonicalPath: '/podborki/prazdniki/8-marta',
        lastmod: '2026-03-01T12:00:00.000Z',
        pagePath: '/podborki/prazdniki/8-marta',
        respondsOk: true,
        robots: collectionLandingRobots(node),
      },
      ENV,
    );

    expect(landing.included).toBe(true);
    expect(landing.included ? landing.url.loc : null).toBe(
      'https://karta.test/podborki/prazdniki/8-marta',
    );
    expect(landing.included ? landing.url.lastmod : null).toBe('2026-03-01T12:00:00.000Z');
  });

  it('пустой узел: директива открыта, но адрес не отвечает 200 — в карту не идёт', () => {
    // Ровно тот случай, ради которого условие «ответ 200» передаётся фактом:
    // по директиве он неотличим от живой страницы (принятый риск Э3-13-A).
    const node = collection({ robots: 'index,follow' });

    expect(
      decideSitemapUrl(
        {
          canonicalPath: '/podborki/prazdniki/8-marta',
          pagePath: '/podborki/prazdniki/8-marta',
          respondsOk: false,
          robots: collectionLandingRobots(node),
        },
        ENV,
      ),
    ).toEqual({ excludedBy: ['not-200'], included: false });
  });
});
