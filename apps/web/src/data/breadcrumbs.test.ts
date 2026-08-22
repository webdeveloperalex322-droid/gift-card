/**
 * Крошки из записей CMS (задача Э3-03): адаптеры «запись → звено» и обход
 * цепочки родителей.
 *
 * Правило самой цепочки (главная первой, текущая без ссылки, обрыв выпадает,
 * JSON-LD один к одному с видимым) проверяется отдельно и без CMS —
 * `tests/unit/web-breadcrumbs.test.ts`. Здесь проверяется то, что относится к
 * ЗАПИСЯМ:
 *
 *   - текст звена берётся из H1, а при пустом H1 — из title (ТЗ §8.1);
 *   - адрес звена подборки берётся из СОХРАНЁННОГО поля `path`, а не считается
 *     заново из цепочки родителей;
 *   - цепочка карточки идёт по ОСНОВНОЙ подборке — первой в связи `collections`
 *     (ТЗ §5.4), порядок задаёт редактор и он не переупорядочивается;
 *   - обход вверх останавливается на первом недоступном звене и не делает лишних
 *     запросов;
 *   - замкнутая цепочка родителей даёт отказ, а не бесконечный обход.
 *
 * ## Почему файл лежит рядом с исходниками, а не в `tests/unit/`
 *
 * Та же причина, что у `./data-access.test.ts`: модуль импортирует
 * СГЕНЕРИРОВАННЫЕ типы Payload (`@otkritka/cms/types`) — это `.ts` из другого
 * пакета, и в composite-проект `apps/web/tsconfig.node.json` такой файл войти не
 * может. Тест из `tests/unit/` обязан импортировать модуль, входящий в один из
 * проектов, на которые ссылаются тесты, иначе `tsc -b` отказывает (TS6307).
 *
 * ## Про фикстуры
 *
 * Записи описаны `Pick`-типами модуля, поэтому фикстура содержит только те поля,
 * которые участвуют в крошках. Полный объект `Collection` здесь был бы шумом и —
 * хуже — начал бы требовать правки при каждом новом поле схемы.
 *
 * Чтение подборок — подставная функция, считающая обращения. Так проверяется не
 * только результат, но и цена: количество запросов на страницу.
 */
import type { Card } from '@otkritka/cms/types';
import { describe, expect, it } from 'vitest';

import {
  cardBreadcrumbs,
  cardCrumb,
  type CardCrumbSource,
  type CollectionCrumbNode,
  type CollectionReader,
  collectionBreadcrumbs,
  collectionCrumb,
  loadAncestors,
  mainCollectionId,
} from './breadcrumbs.js';
import type { RecordId } from './queries.js';

/** Ветвь таксономии: группа → повод → адресат. Больше уровней CMS не допускает. */
const GROUP: CollectionCrumbNode = {
  id: 1,
  parent: null,
  title: 'Праздники — открытки к праздникам',
  h1: 'Праздники',
  path: '/podborki/prazdniki',
};

const OCCASION: CollectionCrumbNode = {
  id: 2,
  parent: 1,
  title: 'Открытки на 8 марта',
  h1: '8 марта',
  path: '/podborki/prazdniki/8-marta',
};

const RECIPIENT: CollectionCrumbNode = {
  id: 3,
  parent: 2,
  title: 'Открытки маме на 8 марта',
  h1: 'Маме на 8 марта',
  path: '/podborki/prazdniki/8-marta/mame',
};

/** Чтение подборок по фиксированному набору записей. Считает обращения. */
function readerOf(...nodes: readonly CollectionCrumbNode[]): CollectionReader & {
  readonly calls: RecordId[];
} {
  const calls: RecordId[] = [];
  const reader = (id: RecordId): Promise<CollectionCrumbNode | null> => {
    calls.push(id);
    return Promise.resolve(nodes.find((node) => node.id === id) ?? null);
  };
  return Object.assign(reader, { calls });
}

describe('звено из записи', () => {
  it('текст берётся из H1', () => {
    expect(collectionCrumb(OCCASION)?.label).toBe('8 марта');
  });

  it('при пустом H1 текст берётся из title (ТЗ §8.1)', () => {
    expect(collectionCrumb({ ...OCCASION, h1: '   ' })?.label).toBe('Открытки на 8 марта');
    expect(collectionCrumb({ ...OCCASION, h1: null })?.label).toBe('Открытки на 8 марта');
  });

  it('адрес берётся из сохранённого `path`, а не собирается заново', () => {
    // Значение расходится со slug записи намеренно: авторитетен именно `path`,
    // посчитанный CMS. Пересчёт здесь означал бы второй способ получить адрес.
    expect(collectionCrumb({ ...OCCASION, path: '/podborki/prazdniki/vosmoe-marta' })?.path).toBe(
      '/podborki/prazdniki/vosmoe-marta',
    );
  });

  it('запись без сохранённого пути звеном не становится', () => {
    expect(collectionCrumb({ ...OCCASION, path: null })).toBeNull();
    expect(collectionCrumb({ ...OCCASION, path: '  ' })).toBeNull();
  });

  it('у карточки адрес — /otkrytki/<slug>', () => {
    expect(cardCrumb({ title: 'Открытка маме', h1: null, slug: 'mame-tyulpany' })).toEqual({
      label: 'Открытка маме',
      path: '/otkrytki/mame-tyulpany',
    });
  });
});

describe('основная подборка карточки', () => {
  it('это ПЕРВАЯ подборка в связи — порядок редактора не переупорядочивается', () => {
    expect(mainCollectionId({ collections: [7, 3, 5] })).toBe(7);
  });

  it('разбирается и форма «объект с id» (запись прочитана с depth > 0)', () => {
    // Приведение типа — сокращение фикстуры, а не обход типизации: полный
    // `Collection` в тесте про ПОРЯДОК подборок ничего не проверяет, зато
    // требовал бы правки при каждом новом поле схемы.
    const populated = [{ id: 42 }, { id: 3 }] as unknown as NonNullable<Card['collections']>;

    expect(mainCollectionId({ collections: populated })).toBe(42);
  });

  it('пусто, если подборок нет', () => {
    expect(mainCollectionId({ collections: [] })).toBeNull();
    expect(mainCollectionId({ collections: null })).toBeNull();
  });
});

describe('обход цепочки родителей', () => {
  it('отдаёт предков от корня к ближайшему', async () => {
    const read = readerOf(GROUP, OCCASION, RECIPIENT);

    await expect(loadAncestors(RECIPIENT, read)).resolves.toEqual([
      { label: 'Праздники', path: '/podborki/prazdniki' },
      { label: '8 марта', path: '/podborki/prazdniki/8-marta' },
    ]);
    expect(read.calls).toEqual([2, 1]);
  });

  it('у узла верхнего уровня предков нет и запросов не делается', async () => {
    const read = readerOf(GROUP);

    await expect(loadAncestors(GROUP, read)).resolves.toEqual([]);
    expect(read.calls).toEqual([]);
  });

  it('останавливается на неопубликованном родителе и ставит разрыв', async () => {
    // GROUP из набора исключён — это и есть «опубликованный узел под черновиком».
    const read = readerOf(OCCASION, RECIPIENT);

    await expect(loadAncestors(RECIPIENT, read)).resolves.toEqual([
      null,
      { label: '8 марта', path: '/podborki/prazdniki/8-marta' },
    ]);
    // Двух запросов достаточно: выше недоступного звена идентификаторов нет.
    expect(read.calls).toEqual([2, 1]);
  });

  it('родитель без сохранённого пути тоже даёт разрыв, а не пятисотку', async () => {
    const read = readerOf({ ...GROUP, path: null }, OCCASION);

    await expect(loadAncestors(OCCASION, read)).resolves.toEqual([null]);
  });

  it('замкнутая цепочка родителей отклоняется, а не зацикливается', async () => {
    const read = readerOf({ ...GROUP, parent: 2 }, { ...OCCASION, parent: 1 });

    await expect(loadAncestors(OCCASION, read)).rejects.toThrow(/замкнут/iu);
  });

  it('узел, объявивший родителем самого себя, отклоняется', async () => {
    const read = readerOf({ ...OCCASION, parent: 2 });

    await expect(loadAncestors({ id: 2, parent: 2 }, read)).rejects.toThrow(/замкнут/iu);
  });
});

describe('крошки страницы подборки', () => {
  it('главная → предки → сама подборка, последняя без ссылки', async () => {
    const trail = await collectionBreadcrumbs(RECIPIENT, readerOf(GROUP, OCCASION, RECIPIENT));

    expect(trail.map((item) => [item.path, item.linked])).toEqual([
      ['/', true],
      ['/podborki/prazdniki', true],
      ['/podborki/prazdniki/8-marta', true],
      ['/podborki/prazdniki/8-marta/mame', false],
    ]);
  });

  it('контейнер /podborki звеном не становится', async () => {
    const trail = await collectionBreadcrumbs(GROUP, readerOf(GROUP));

    expect(trail.map((item) => item.path)).toEqual(['/', '/podborki/prazdniki']);
  });

  it('при обрыве остаются главная, доступные предки и сама подборка', async () => {
    const trail = await collectionBreadcrumbs(RECIPIENT, readerOf(OCCASION, RECIPIENT));

    expect(trail.map((item) => item.path)).toEqual([
      '/',
      '/podborki/prazdniki/8-marta',
      '/podborki/prazdniki/8-marta/mame',
    ]);
  });

  it('подборка без сохранённого пути отклоняется: у последнего звена адрес обязателен', async () => {
    await expect(
      collectionBreadcrumbs({ ...RECIPIENT, path: null }, readerOf(GROUP, OCCASION)),
    ).rejects.toThrow(/пути/iu);
  });
});

describe('крошки страницы карточки', () => {
  const CARD: CardCrumbSource & Pick<Card, 'collections'> = {
    title: 'Открытка маме на 8 марта с тюльпанами',
    h1: null,
    slug: 'mame-tyulpany',
    collections: [3, 1],
  };

  it('идут по основной подборке и включают её саму (ТЗ §5.4)', async () => {
    const trail = await cardBreadcrumbs(CARD, readerOf(GROUP, OCCASION, RECIPIENT));

    expect(trail.map((item) => [item.label, item.path, item.linked])).toEqual([
      ['Главная', '/', true],
      ['Праздники', '/podborki/prazdniki', true],
      ['8 марта', '/podborki/prazdniki/8-marta', true],
      ['Маме на 8 марта', '/podborki/prazdniki/8-marta/mame', true],
      ['Открытка маме на 8 марта с тюльпанами', '/otkrytki/mame-tyulpany', false],
    ]);
  });

  it('вторая подборка в связи на крошки не влияет', async () => {
    const first = await cardBreadcrumbs(CARD, readerOf(GROUP, OCCASION, RECIPIENT));
    const swapped = await cardBreadcrumbs(
      { ...CARD, collections: [3] },
      readerOf(GROUP, OCCASION, RECIPIENT),
    );

    expect(swapped).toEqual(first);
  });

  it('при недоступной основной подборке остаются главная и карточка', async () => {
    const read = readerOf(GROUP, OCCASION);
    const trail = await cardBreadcrumbs(CARD, read);

    expect(trail.map((item) => [item.path, item.linked])).toEqual([
      ['/', true],
      ['/otkrytki/mame-tyulpany', false],
    ]);
    // Ровно один запрос: не найдя основную подборку, выше идти некуда.
    expect(read.calls).toEqual([3]);
  });

  it('карточка без подборок запросов не делает и крошки всё равно получает', async () => {
    const read = readerOf(GROUP, OCCASION, RECIPIENT);
    const trail = await cardBreadcrumbs({ ...CARD, collections: null }, read);

    expect(trail.map((item) => item.path)).toEqual(['/', '/otkrytki/mame-tyulpany']);
    expect(read.calls).toEqual([]);
  });
});
