/**
 * Разметка страницы подборки: `CollectionPage` + `ItemList` (задача Э3-06).
 *
 * Норма: ТЗ §5.3 («JSON-LD: `CollectionPage` + `ItemList` + `BreadcrumbList`»),
 * `CLAUDE.md` — раздел «Структурированные данные» («разметка соответствует
 * видимому содержимому»).
 *
 * `BreadcrumbList` печатает компонент `../components/Breadcrumbs.astro` из той же
 * цепочки, что показывает на экране; здесь его нет намеренно (см. `./card-page.ts`).
 *
 * ## Главное требование к этому модулю: `ItemList` = видимый список
 *
 * Соответствие держится НА ВХОДЕ, а не на дисциплине шаблона: функция принимает
 * уже собранный список элементов — ровно тот массив, который шаблон отдаёт
 * компоненту сетки. Ни одного элемента она не добавляет и ни одного не
 * пропускает, порядок сохраняет, а `numberOfItems` считает по самому массиву.
 * Собрать «ещё один список для разметки» здесь нельзя: другого входа у функции
 * нет.
 *
 * Что считается видимым списком страницы (правило слоя данных, см.
 * `../data/page-data.ts`): сетка открыток, а если у узла своих открыток нет —
 * список дочерних узлов. У группирующего узла таксономии (`/podborki/prazdniki`)
 * содержанием и являются дочерние узлы, и `ItemList` из них — это описание того,
 * что посетитель видит. Страница, у которой нет ни того, ни другого, не
 * существует: маршрут отвечает 404 (ТЗ §5.3), поэтому пустой список сюда не
 * доходит и отклоняется.
 *
 * Модуль ЧИСТЫЙ: входит в composite-проект `../../tsconfig.node.json`,
 * проверяется юнит-тестом `tests/unit/web-collection-page.test.ts`.
 */

import type { SharedEnv } from '@otkritka/shared';

import { canonicalUrlFor } from '../routing/canonical.js';
import type { JsonLdDocument } from './json-ld.js';

/** Элемент видимого списка: текст ссылки и её путь от корня сайта. */
export interface ListItemFacts {
  readonly name: string;
  readonly path: string;
}

export interface CollectionPageJsonLdInput {
  /** Канонический путь страницы подборки — сохранённое поле `path` записи. */
  readonly canonicalPath: string;
  /** Видимый H1. */
  readonly heading: string;
  /**
   * Значение `<meta name="description">`. Пусто — свойства `description` нет.
   *
   * Явное `| undefined` — при `exactOptionalPropertyTypes` поле записи, которого
   * может не быть вовсе, обязано быть выразимо здесь: иначе слой данных
   * нормализовал бы его сам и завёл вторую трактовку «заполнено ли».
   */
  readonly description?: string | null | undefined;
  /**
   * Дата содержательного обновления (`updatedContentAt`) в формате ISO.
   *
   * Попадает в разметку ТОЛЬКО когда та же дата показана на странице (ТЗ §5.3):
   * дата в разметке без даты на экране — утверждение, которому нечего
   * соответствовать. Пусто — свойства `dateModified` нет.
   */
  readonly dateModified?: string | null | undefined;
  /** Видимый список страницы, в том же порядке. */
  readonly items: readonly ListItemFacts[];
}

export interface ItemListElementJsonLd {
  readonly '@type': 'ListItem';
  readonly position: number;
  readonly name: string;
  /** Абсолютный адрес элемента. Собран из `SITE_URL` единственным хелпером. */
  readonly url: string;
}

export interface ItemListJsonLd {
  readonly '@type': 'ItemList';
  readonly numberOfItems: number;
  readonly itemListElement: readonly ItemListElementJsonLd[];
}

export interface CollectionPageJsonLd extends JsonLdDocument {
  readonly '@type': 'CollectionPage';
  readonly url: string;
  readonly name: string;
  readonly description?: string;
  readonly dateModified?: string;
  readonly mainEntity: ItemListJsonLd;
}

function filled(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Разметка страницы подборки.
 *
 * @param env срез окружения — аргумент, а не чтение `process.env` внутри.
 * @throws Error если `SITE_URL` не задан или некорректен, если путь задан
 *   абсолютным адресом, если заголовок пуст, если список пуст либо если у
 *   элемента списка пустое имя. Пустое имя элемента — это ссылка, у которой
 *   нечего прочитать, и `ListItem` без обязательного `name`.
 */
export function collectionPageJsonLd(
  input: CollectionPageJsonLdInput,
  env?: SharedEnv,
): CollectionPageJsonLd {
  const heading = input.heading.trim();
  if (heading === '') {
    throw new Error(
      'У страницы подборки пустой заголовок, поэтому `CollectionPage.name` вывести нечем. ' +
        'Заполните H1 или title записи: подставлять путь или слово-заглушку нельзя.',
    );
  }
  if (input.items.length === 0) {
    throw new Error(
      'Список подборки пуст, а `ItemList` без элементов описывал бы страницу, на которой ' +
        'ничего нет. Пустая подборка не отдаёт 200 как посадочная (ТЗ §5.3) — маршрут обязан ' +
        'ответить 404 раньше, чем дело дойдёт до разметки.',
    );
  }

  const description = filled(input.description);
  const dateModified = filled(input.dateModified);

  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    url: canonicalUrlFor(input.canonicalPath, env),
    name: heading,
    ...(description === undefined ? {} : { description }),
    ...(dateModified === undefined ? {} : { dateModified }),
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: input.items.length,
      itemListElement: input.items.map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: requireItemName(item),
        url: canonicalUrlFor(item.path, env),
      })),
    },
  };
}

function requireItemName(item: ListItemFacts): string {
  const name = item.name.trim();
  if (name === '') {
    throw new Error(
      `У элемента списка «${item.path}» пустое имя. Это ссылка, у которой нечего прочитать, ` +
        'и элемент ItemList без обязательного `name`. Заполните заголовок записи.',
    );
  }
  return name;
}
