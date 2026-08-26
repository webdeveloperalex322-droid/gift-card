/**
 * Содержимое страниц карточки и подборки из записей CMS (задачи Э3-05, Э3-06).
 *
 * Здесь проверяется то, что относится к ЗАПИСИ и к соответствию «видимое =
 * разметка»; правила самой разметки проверяются без CMS
 * (`tests/unit/web-card-page.test.ts`, `tests/unit/web-collection-page.test.ts`):
 *
 *   - `ItemList` собран из ТОГО ЖЕ массива плиток, который получает сетка: те же
 *     элементы, тот же порядок, столько же;
 *   - `ImageObject.contentUrl`, кнопка «Скачать» и `<img src>` описывают ОДИН
 *     файл — самую широкую производную JPEG;
 *   - при незаполненном глобале лицензионной части в разметке нет вовсе (Ч-10), а
 *     указание на генерацию ИИ выводится видимым текстом, а не свойством;
 *   - карточка без производных и подборка без содержимого дают `null` — то есть
 *     маршрут ответит 404, а не 200 со слабой страницей (ТЗ §5.3);
 *   - атрибуты карточки идут в порядке, заданном редактором, и ссылок на записи
 *     без пути среди них нет.
 *
 * Файл лежит рядом с исходниками по той же причине, что `./card-image.test.ts`:
 * модуль импортирует сгенерированные типы Payload, а composite-проект
 * `apps/web/tsconfig.node.json` файл `.ts` чужого пакета принять не может.
 *
 * Хост в фикстуре синтетический: значения по умолчанию у `SITE_URL` нет.
 */
import type { Card, Collection, SiteSetting } from '@otkritka/cms/types';
import { describe, expect, it } from 'vitest';

import {
  cardAttributeLinks,
  cardPageContent,
  cardTiles,
  catalogSectionItems,
  catalogSections,
  collectionLinks,
  collectionPageContent,
} from './page-data.js';

const ENV = { SITE_URL: 'https://stranicy.test' } as const;

const VARIANTS = [
  { key: 'cards/a1b2c3d4/otkrytka-mame-320.avif', format: 'avif' as const, width: 320, height: 400 },
  { key: 'cards/a1b2c3d4/otkrytka-mame-640.avif', format: 'avif' as const, width: 640, height: 800 },
  { key: 'cards/a1b2c3d4/otkrytka-mame-320.jpg', format: 'jpeg' as const, width: 320, height: 400 },
  { key: 'cards/a1b2c3d4/otkrytka-mame-640.jpg', format: 'jpeg' as const, width: 640, height: 800 },
];

/**
 * Карточка в объёме, который читает модуль: обязательные поля схемы плюс те, что
 * читает `page-data`. Перечислять здесь все поля схемы — шум, который начнёт
 * требовать правки при каждом новом поле; необязательные опущены намеренно.
 */
function card(overrides: Partial<Card> = {}): Card {
  return {
    id: 1,
    alt: 'Букет розовых тюльпанов и надпись «С 8 Марта, мама»',
    caption: 'С 8 Марта, мама!',
    createdAt: '2026-01-01T00:00:00.000Z',
    derivative: { variants: VARIANTS },
    description: 'Открытка с тюльпанами для мамы.',
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

const EMPTY_SETTINGS = { id: 1, createdAt: '', updatedAt: '' } as SiteSetting;

const FULL_SETTINGS = {
  ...EMPTY_SETTINGS,
  imageLicense: {
    acquireLicensePage: '/usloviya',
    aiDisclosure: 'Изображение создано нейросетью и проверено редактором.',
    copyrightNotice: '© Проект «Открытки»',
    creator: 'Проект «Открытки»',
    creditText: 'Проект «Открытки»',
    license: '/usloviya',
  },
} as SiteSetting;

function cardContent(
  overrides: {
    readonly card?: Card;
    readonly collections?: readonly Collection[];
    readonly settings?: SiteSetting;
    readonly similar?: readonly Card[];
  } = {},
): NonNullable<ReturnType<typeof cardPageContent>> {
  const content = cardPageContent({
    card: overrides.card ?? card(),
    collections: overrides.collections ?? [],
    env: ENV,
    settings: overrides.settings ?? EMPTY_SETTINGS,
    similar: overrides.similar ?? [],
  });
  if (content === null) {
    throw new Error('Ожидалось содержимое страницы, а получен null.');
  }
  return content;
}

describe('страница карточки: один файл на три места', () => {
  it('кнопка «Скачать» и contentUrl указывают на самую широкую производную JPEG', () => {
    const content = cardContent();
    const [, image] = content.jsonLd['@graph'];

    expect(content.downloadPath).toBe('/media/cards/a1b2c3d4/otkrytka-mame-640.jpg');
    expect(content.downloadWidth).toBe(640);
    expect(content.downloadHeight).toBe(800);
    expect(image.contentUrl).toBe(`${ENV.SITE_URL}${content.downloadPath}`);
    expect(image.width).toBe(content.downloadWidth);
    expect(image.height).toBe(content.downloadHeight);
  });

  it('canonical страницы и url разметки — одно значение', () => {
    const content = cardContent();
    const [page] = content.jsonLd['@graph'];

    expect(content.canonicalPath).toBe('/otkrytki/otkrytka-mame-na-8-marta');
    expect(page.url).toBe(`${ENV.SITE_URL}${content.canonicalPath}`);
  });

  it('переопределение canonical администратором действует', () => {
    const content = cardContent({ card: card({ canonical: '/otkrytki/drugaya-otkrytka' }) });

    expect(content.canonicalPath).toBe('/otkrytki/drugaya-otkrytka');
  });

  it('описание изображения берётся из видимого описания, а при пустом — из alt', () => {
    expect(cardContent().jsonLd['@graph'][1].description).toBe('Открытка с тюльпанами для мамы.');
    expect(cardContent({ card: card({ description: null }) }).jsonLd['@graph'][1].description).toBe(
      'Букет розовых тюльпанов и надпись «С 8 Марта, мама»',
    );
  });

  it('директива робота приходит из записи, а не выводится из статуса', () => {
    expect(cardContent({ card: card({ robots: 'noindex,nofollow' }) }).robots).toBe(
      'noindex,nofollow',
    );
  });

  it('пустой metaDescription означает отсутствие тега, а не пустой тег', () => {
    const content = cardContent({ card: card({ metaDescription: '   ' }) });

    expect(content.metaDescription).toBeNull();
    expect('description' in content.jsonLd['@graph'][0]).toBe(false);
  });
});

describe('страница карточки: пустое зеркало производных', () => {
  it('без производных содержимого нет — маршрут ответит 404, а не 200 без картинки', () => {
    // Группы `derivative` может не быть вовсе (запись, сохранённая до появления
    // зеркала), поэтому один из случаев — отсутствующий ключ, а не `undefined`
    // значением: при `exactOptionalPropertyTypes` это разные вещи.
    const withoutGroup = { ...card() };
    delete (withoutGroup as { derivative?: unknown }).derivative;

    const empty: readonly Card[] = [
      withoutGroup,
      card({ derivative: {} }),
      card({ derivative: { variants: null } }),
      card({ derivative: { variants: [] } }),
    ];

    for (const item of empty) {
      expect(
        cardPageContent({
          card: item,
          collections: [],
          env: ENV,
          settings: EMPTY_SETTINGS,
          similar: [],
        }),
      ).toBeNull();
    }
  });

  it('пустое зеркало проверяется РАНЬШЕ alt: сообщение о причине не подменяется', () => {
    expect(
      cardPageContent({
        card: card({ alt: '', derivative: { variants: [] } }),
        collections: [],
        env: ENV,
        settings: EMPTY_SETTINGS,
        similar: [],
      }),
    ).toBeNull();
  });
});

describe('лицензия и указание на ИИ (решение Ч-10)', () => {
  it('незаполненный глобал: лицензионной части в разметке нет и подписи нет', () => {
    const content = cardContent({ settings: EMPTY_SETTINGS });
    const [, image] = content.jsonLd['@graph'];

    expect(content.aiDisclosure).toBeNull();
    for (const property of ['creator', 'creditText', 'copyrightNotice', 'license', 'acquireLicensePage']) {
      expect(property in image).toBe(false);
    }
  });

  it('заполненный глобал: лицензия в разметке, указание на ИИ — видимым текстом', () => {
    const content = cardContent({ settings: FULL_SETTINGS });
    const [, image] = content.jsonLd['@graph'];

    expect(image.license).toBe(`${ENV.SITE_URL}/usloviya`);
    expect(image.acquireLicensePage).toBe(`${ENV.SITE_URL}/usloviya`);
    expect(content.aiDisclosure).toBe('Изображение создано нейросетью и проверено редактором.');
    // Свойства с таким смыслом в schema.org нет: указание живёт на экране.
    expect(JSON.stringify(content.jsonLd)).not.toContain('нейросет');
  });

  it('частично заполненная лицензия не выводится вовсе', () => {
    const partial = {
      ...EMPTY_SETTINGS,
      imageLicense: { creator: 'Проект «Открытки»', license: '/usloviya' },
    } as SiteSetting;
    const [, image] = cardContent({ settings: partial }).jsonLd['@graph'];

    expect('creator' in image).toBe(false);
    expect('license' in image).toBe(false);
  });
});

describe('атрибуты карточки', () => {
  it('идут в порядке редактора и подписаны видом узла', () => {
    const links = cardAttributeLinks([
      collection({ id: 10, nodeKind: 'occasion', path: '/podborki/prazdniki/8-marta' }),
      collection({
        id: 11,
        nodeKind: 'recipient',
        path: '/podborki/prazdniki/8-marta/mame',
        title: 'Открытки маме на 8 Марта',
      }),
      collection({ id: 12, nodeKind: 'group', path: '/podborki/prazdniki', title: 'Праздники' }),
    ]);

    expect(links.map((link) => link.kindLabel)).toEqual(['Повод', 'Адресат', 'Раздел']);
    expect(links.map((link) => link.path)).toEqual([
      '/podborki/prazdniki/8-marta',
      '/podborki/prazdniki/8-marta/mame',
      '/podborki/prazdniki',
    ]);
  });

  it('узел без сохранённого пути выпадает: ссылки без адреса не бывает', () => {
    expect(cardAttributeLinks([collection({ path: null }), collection({ path: '  ' })])).toEqual([]);
  });

  it('текст ссылки — H1 узла, а при пустом H1 — title', () => {
    const [withH1, withoutH1] = cardAttributeLinks([
      collection({ id: 10, h1: 'Открытки к 8 Марта' }),
      collection({ id: 11, h1: null, path: '/podborki/prazdniki/9-maya', title: 'Открытки к 9 Мая' }),
    ]);

    expect(withH1?.name).toBe('Открытки к 8 Марта');
    expect(withoutH1?.name).toBe('Открытки к 9 Мая');
  });
});

describe('плитки сетки', () => {
  it('у плитки есть адрес, видимое имя и запись для изображения', () => {
    const [tile] = cardTiles([card()]);

    expect(tile?.path).toBe('/otkrytki/otkrytka-mame-na-8-marta');
    expect(tile?.name).toBe('Открытка маме на 8 Марта с тюльпанами');
    expect(tile?.image.derivative?.variants).toEqual(VARIANTS);
  });

  it('порядок плиток не меняется: он задан запросом', () => {
    const tiles = cardTiles([
      card({ id: 1, slug: 'pervaya', title: 'Первая' }),
      card({ id: 2, slug: 'vtoraya', title: 'Вторая' }),
    ]);

    expect(tiles.map((tile) => tile.path)).toEqual(['/otkrytki/pervaya', '/otkrytki/vtoraya']);
  });
});

function collectionContent(
  overrides: {
    readonly node?: Collection;
    readonly cards?: readonly Card[];
    readonly children?: readonly Collection[];
    readonly parent?: Collection | null;
    readonly related?: readonly Collection[];
    readonly page?: number;
    readonly pageCount?: number;
  } = {},
): NonNullable<ReturnType<typeof collectionPageContent>> {
  const content = collectionPageContent({
    cards: overrides.cards ?? [card()],
    children: overrides.children ?? [],
    env: ENV,
    node: overrides.node ?? collection(),
    page: overrides.page ?? 1,
    pageCount: overrides.pageCount ?? 1,
    parent: overrides.parent ?? null,
    related: overrides.related ?? [],
  });
  if (content === null) {
    throw new Error('Ожидалось содержимое страницы, а получен null.');
  }
  return content;
}

describe('страница подборки: ItemList = видимая сетка', () => {
  it('элементы разметки собраны из тех же плиток, что рендерит сетка', () => {
    const content = collectionContent({
      cards: [
        card({ id: 1, slug: 'pervaya', title: 'Первая открытка' }),
        card({ id: 2, slug: 'vtoraya', title: 'Вторая открытка' }),
        card({ id: 3, slug: 'tretya', title: 'Третья открытка' }),
      ],
    });
    const list = content.jsonLd.mainEntity;

    expect(list.numberOfItems).toBe(content.tiles.length);
    expect(list.itemListElement.map((element) => element.name)).toEqual(
      content.tiles.map((tile) => tile.name),
    );
    expect(list.itemListElement.map((element) => element.url)).toEqual(
      content.tiles.map((tile) => `${ENV.SITE_URL}${tile.path}`),
    );
  });

  it('у узла без своих открыток список — дочерние узлы', () => {
    // У группирующего узла таксономии содержанием и являются дети; ItemList из
    // них описывает то, что посетитель видит.
    const content = collectionContent({
      cards: [],
      children: [
        collection({ id: 20, path: '/podborki/prazdniki/8-marta', title: 'Открытки на 8 Марта' }),
        collection({ id: 21, path: '/podborki/prazdniki/9-maya', title: 'Открытки на 9 Мая' }),
      ],
      node: collection({ id: 19, nodeKind: 'group', path: '/podborki/prazdniki', title: 'Праздники' }),
    });

    expect(content.tiles).toEqual([]);
    expect(content.jsonLd.mainEntity.itemListElement.map((element) => element.name)).toEqual([
      'Открытки на 8 Марта',
      'Открытки на 9 Мая',
    ]);
  });

  it('ни открыток, ни детей — содержимого нет: маршрут ответит 404', () => {
    expect(
      collectionPageContent({
        cards: [],
        children: [],
        env: ENV,
        node: collection(),
        page: 1,
        pageCount: 0,
        parent: null,
        related: [],
      }),
    ).toBeNull();
  });
});

describe('страница подборки: перелинковка и дата', () => {
  it('вверх на родителя, вбок на смежные, вниз на детей', () => {
    const content = collectionContent({
      children: [collection({ id: 30, path: '/podborki/prazdniki/8-marta/mame', title: 'Маме' })],
      parent: collection({ id: 31, nodeKind: 'group', path: '/podborki/prazdniki', title: 'Праздники' }),
      related: [
        collection({ id: 32, path: '/podborki/prazdniki/14-fevralya', title: 'К 14 февраля' }),
        collection({ id: 33, path: '/podborki/prazdniki/9-maya', title: 'К 9 Мая' }),
      ],
    });

    expect(content.parent).toEqual({ name: 'Праздники', path: '/podborki/prazdniki' });
    expect(content.related.map((link) => link.path)).toEqual([
      '/podborki/prazdniki/14-fevralya',
      '/podborki/prazdniki/9-maya',
    ]);
    expect(content.children.map((link) => link.name)).toEqual(['Маме']);
  });

  it('неопубликованный родитель приходит как null и ссылки не даёт', () => {
    expect(collectionContent({ parent: null }).parent).toBeNull();
  });

  it('родитель, указанный ещё и в related, не даёт вторую ссылку на тот же адрес', () => {
    // Найдено живой проверкой на собранном сервере: редактор законно указывает
    // родителя в связи `related`, и в блоке «Смотрите также» появлялись ДВЕ
    // одинаковые ссылки. Повтор пути запрещён по той же причине, что в крошках:
    // это два элемента навигации, между которыми нечего выбирать.
    const parent = collection({ id: 41, nodeKind: 'group', path: '/podborki/prazdniki', title: 'Праздники' });
    const content = collectionContent({ parent, related: [parent, parent] });

    expect(content.parent?.path).toBe('/podborki/prazdniki');
    expect(content.related).toEqual([]);
  });

  it('собственный адрес страницы в блок «Смотрите также» не попадает', () => {
    const node = collection({ id: 42, path: '/podborki/prazdniki/8-marta' });
    const content = collectionContent({ node, related: [node] });

    expect(content.related).toEqual([]);
  });

  it('узел без пути выпадает из любого блока перелинковки', () => {
    expect(collectionLinks([collection({ path: null }), null])).toEqual([]);
  });

  it('дата содержательного обновления попадает и на страницу, и в dateModified', () => {
    const content = collectionContent({
      node: collection({ updatedContentAt: '2026-02-14T10:00:00.000Z' }),
    });

    expect(content.updatedContentAt).toBe('2026-02-14T10:00:00.000Z');
    expect(content.jsonLd.dateModified).toBe('2026-02-14T10:00:00.000Z');
  });

  it('без даты содержательного обновления нет ни текста, ни dateModified', () => {
    const content = collectionContent({ node: collection({ updatedContentAt: null }) });

    expect(content.updatedContentAt).toBeNull();
    expect('dateModified' in content.jsonLd).toBe(false);
  });

  it('подборка без сохранённого пути — отказ, а не страница по выдуманному адресу', () => {
    expect(() => collectionContent({ node: collection({ path: null }) })).toThrow(/пути/);
  });
});

describe('страница подборки: пагинация сегментом пути (задача Э3-07)', () => {
  const NODE = collection({
    id: 51,
    metaDescription: 'Открытки к 8 Марта: маме, бабушке, коллеге.',
    path: '/podborki/prazdniki/8-marta',
    robots: 'index,follow',
    title: 'Открытки на 8 Марта',
  });

  it('первая страница живёт по базовому URL и сохраняет директиву записи', () => {
    const content = collectionContent({ node: NODE, page: 1, pageCount: 3 });

    expect(content.canonicalPath).toBe('/podborki/prazdniki/8-marta');
    expect(content.robots).toBe('index,follow');
    expect(content.title).toBe('Открытки на 8 Марта');
    expect(content.metaDescription).toBe('Открытки к 8 Марта: маме, бабушке, коллеге.');
    expect(content.pagination?.previousPath).toBeNull();
    expect(content.pagination?.nextPath).toBe('/podborki/prazdniki/8-marta/page/2');
  });

  it('на базовом URL нет ни одной ссылки на /page/1', () => {
    const content = collectionContent({ node: NODE, page: 1, pageCount: 4 });

    expect(JSON.stringify(content.pagination)).not.toContain('/page/1');
  });

  it('страница 2: self-canonical на САМУ СЕБЯ, а не на первую страницу', () => {
    const content = collectionContent({ node: NODE, page: 2, pageCount: 3 });

    expect(content.canonicalPath).toBe('/podborki/prazdniki/8-marta/page/2');
    expect(content.jsonLd.url).toBe(`${ENV.SITE_URL}/podborki/prazdniki/8-marta/page/2`);
  });

  it('страница 2 отдаёт noindex,follow даже у записи, открытой человеком в индекс', () => {
    // Решение Ч-01b: ссылки обходятся, страницы пагинации в индекс не идут.
    expect(collectionContent({ node: NODE, page: 2, pageCount: 3 }).robots).toBe('noindex,follow');
  });

  it('на страницах 2+ title и H1 не повторяют первую страницу, а описания нет вовсе', () => {
    const content = collectionContent({ node: NODE, page: 3, pageCount: 3 });

    expect(content.title).toBe('Открытки на 8 Марта — страница 3');
    expect(content.heading).toBe('Открытки на 8 Марта — страница 3');
    expect(content.metaDescription).toBeNull();
    expect('description' in content.jsonLd).toBe(false);
  });

  it('вводный текст принадлежит посадочной странице и на страницах 2+ не повторяется', () => {
    expect(collectionContent({ node: NODE, page: 2, pageCount: 3 }).intro).toBeNull();
  });

  it('«предыдущая» со второй страницы ведёт на базовый URL списка', () => {
    const content = collectionContent({ node: NODE, page: 2, pageCount: 3 });

    expect(content.pagination?.previousPath).toBe('/podborki/prazdniki/8-marta');
  });

  it('одна страница — блока пагинации нет вовсе', () => {
    expect(collectionContent({ node: NODE, page: 1, pageCount: 1 }).pagination).toBeNull();
  });

  it('у группирующего узла без открыток блока пагинации нет', () => {
    const content = collectionContent({
      cards: [],
      children: [collection({ id: 52, path: '/podborki/prazdniki/8-marta', title: '8 Марта' })],
      node: collection({
        id: 53,
        nodeKind: 'group',
        path: '/podborki/prazdniki',
        title: 'Праздники',
      }),
      page: 1,
      pageCount: 0,
    });

    expect(content.pagination).toBeNull();
  });

  it('ItemList страницы 2 описывает открытки ИМЕННО этой страницы', () => {
    const content = collectionContent({
      cards: [card({ id: 61, slug: 'dvadcat-pyataya', title: 'Двадцать пятая' })],
      node: NODE,
      page: 2,
      pageCount: 2,
    });

    expect(content.jsonLd.mainEntity.itemListElement.map((element) => element.url)).toEqual([
      `${ENV.SITE_URL}/otkrytki/dvadcat-pyataya`,
    ]);
  });
});

describe('каталог подборок: разделы верхнего уровня и их дети (задача Э3-08)', () => {
  const PRAZDNIKI = collection({
    id: 71,
    nodeKind: 'group',
    path: '/podborki/prazdniki',
    title: 'Праздники',
  });
  const ADRESATY = collection({
    id: 72,
    nodeKind: 'group',
    path: '/podborki/adresaty',
    title: 'Адресаты',
  });
  const MARTA = collection({ id: 73, path: '/podborki/prazdniki/8-marta', title: '8 Марта' });

  it('раздел собирается из узла и его прямых детей, порядок сохраняется', () => {
    const sections = catalogSections([
      { children: [MARTA], node: PRAZDNIKI },
      { children: [], node: ADRESATY },
    ]);

    expect(sections.map((section) => section.node.path)).toEqual([
      '/podborki/prazdniki',
      '/podborki/adresaty',
    ]);
    expect(sections[0]?.children.map((child) => child.name)).toEqual(['8 Марта']);
  });

  it('узел без сохранённого пути выпадает вместе со своими детьми', () => {
    // Ссылки на узел без пути нет, а его дети в плоском виде превратили бы карту
    // разделов в перечень без структуры.
    const sections = catalogSections([
      { children: [MARTA], node: collection({ id: 74, path: null, title: 'Без пути' }) },
    ]);

    expect(sections).toEqual([]);
  });

  it('ItemList каталога — те же ссылки в том же порядке, что видны на странице', () => {
    const sections = catalogSections([
      { children: [MARTA], node: PRAZDNIKI },
      { children: [], node: ADRESATY },
    ]);

    expect(catalogSectionItems(sections).map((item) => item.path)).toEqual([
      '/podborki/prazdniki',
      '/podborki/prazdniki/8-marta',
      '/podborki/adresaty',
    ]);
  });

  it('пустой каталог даёт пустой список: маршрут ответит 404, а не 200 с пустой страницей', () => {
    expect(catalogSectionItems(catalogSections([]))).toEqual([]);
  });
});
