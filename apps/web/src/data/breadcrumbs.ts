/**
 * Крошки из записей CMS: адаптеры «запись → звено» и обход цепочки родителей
 * (задача Э3-03).
 *
 * Разделение с `../seo/breadcrumbs.ts` — по зависимостям, а не по вкусу. Там
 * живёт ПРАВИЛО цепочки (главная первой, текущая без ссылки, разрыв выпадает,
 * разметка один к одному с видимым) — чистые функции без CMS. Здесь живёт
 * ЧТЕНИЕ: какие поля записи становятся текстом и адресом звена и сколько
 * запросов нужно, чтобы получить предков. Модуль импортирует сгенерированные
 * типы Payload, поэтому в composite-проект `../../tsconfig.node.json` войти не
 * может, и его тест лежит рядом (`./breadcrumbs.test.ts`) — так же и по той же
 * причине, что `./data-access.test.ts`.
 *
 * ## Откуда берётся адрес звена
 *
 * У подборки — из сохранённого поля `path` (его считает и хранит CMS с
 * уникальным индексом БД). Пересчёта пути из цепочки родителей здесь нет: второй
 * способ вычислить адрес означал бы, что крошки, canonical и sitemap могут
 * разойтись. У карточки — `buildCardPath` из `@otkritka/cms/seo/paths`, то есть
 * единственная функция сборки пути карточки в проекте (её же оборачивает
 * `cardPath` в `./content.ts`; здесь берётся сама функция, потому что
 * `./content.ts` на загрузке тянет конфиг Payload, а этому модулю он не нужен).
 *
 * ## Почему чтение подборки передаётся аргументом
 *
 * Обход родителей — это последовательность запросов, и проверять его порядок,
 * остановку на разрыве и отсутствие лишних запросов надо БЕЗ поднятой базы.
 * Живое чтение (`findCollectionById`, права анонима) привязывается в барьере
 * слоя — `./index.ts`, функции `cardBreadcrumbTrail` и
 * `collectionBreadcrumbTrail`. Шаблоны зовут их, а не эти функции напрямую.
 *
 * ## Сколько это запросов
 *
 * Глубина таксономии ограничена видом узла (`group` → `occasion` →
 * `recipient`, матрица в `apps/cms/src/collections/collection-path.ts`), поэтому
 * у подборки предков не больше двух, у карточки — не больше трёх звеньев вместе
 * с основной подборкой. Обход останавливается на первом недоступном звене,
 * поэтому запросов не больше, чем звеньев.
 */

import type { Card, Collection } from '@otkritka/cms/types';
import { buildCardPath } from '@otkritka/cms/seo/paths';

import { paginationCrumbLabel, paginationPathFor } from '../routing/pagination.js';
import {
  type BreadcrumbLink,
  type BreadcrumbNode,
  type BreadcrumbTrail,
  buildBreadcrumbTrail,
} from '../seo/breadcrumbs.js';
import { recordHeading } from '../seo/headings.js';
import type { RecordId } from './queries.js';
import { relationId, relationIds } from './relations.js';

/**
 * Поля подборки, из которых получается звено. `Pick` от сгенерированного типа, а
 * не своя копия структуры: новое поле в схеме не должно требовать правки здесь,
 * а исчезнувшее обязано ломать сборку.
 */
export type CollectionCrumbSource = Pick<Collection, 'title' | 'h1' | 'path'>;

/** Плюс то, что нужно для обхода вверх. */
export type CollectionCrumbNode = CollectionCrumbSource & Pick<Collection, 'id' | 'parent'>;

export type CardCrumbSource = Pick<Card, 'title' | 'h1' | 'slug'>;

/**
 * Чтение подборки по идентификатору: `null` — записи нет либо она не
 * опубликована. Публичному рендеру эти случаи различать нечем и незачем.
 */
export type CollectionReader = (id: RecordId) => Promise<CollectionCrumbNode | null>;

/**
 * Видимый текст звена — заголовок записи (H1, при пустом H1 — title).
 *
 * Правило «пустой H1 совпадает с title» (ТЗ §8.1) с задачи Э3-05 живёт в
 * единственной функции проекта — `recordHeading` из `../seo/headings.ts`.
 * Локальная копия была здесь до неё, и именно она делала выразимым расхождение:
 * крошка ведёт на страницу, и её текст обязан совпадать с H1, который посетитель
 * там увидит, а два места трактовки одного правила расходятся молча.
 */
const crumbLabel = recordHeading;

/**
 * Звено для подборки или `null`, если у записи нет сохранённого пути.
 *
 * Почему `null`, а не исключение. Публично у звена без адреса нет страницы —
 * ровно как у неопубликованного узла, и последствие то же: ссылки не будет.
 * Исключение здесь дало бы 500 на странице, которая в остальном исправна.
 * Ветка защитная: CMS отказывается сохранять узел под родителем без пути
 * (`apps/cms/src/collections/collection-path.ts`), а у самой записи путь
 * обязателен вместе с уникальным индексом.
 */
export function collectionCrumb(node: CollectionCrumbSource): BreadcrumbNode | null {
  const path = node.path?.trim() ?? '';
  return path === '' ? null : { label: crumbLabel(node), path };
}

/** Звено для карточки. Адрес — `/otkrytki/<slug>`, единственный URL записи. */
export function cardCrumb(card: CardCrumbSource): BreadcrumbNode {
  return { label: crumbLabel(card), path: buildCardPath(card.slug) };
}

/**
 * Идентификатор ОСНОВНОЙ подборки карточки — первой в связи `collections`.
 *
 * «Первая — основная» — контракт коллекции `cards` (описание поля в
 * `apps/cms/src/collections/cards.ts`), и порядок задаёт редактор. Поэтому
 * сортировки здесь нет: любая сортировка отменила бы его решение и меняла бы
 * крошки при переименовании подборки.
 */
export function mainCollectionId(card: Pick<Card, 'collections'>): RecordId | null {
  return relationIds(card.collections).at(0) ?? null;
}

/**
 * Предки узла, от корня к ближайшему. `null` в начале списка — разрыв цепочки.
 *
 * Обход идёт вверх и останавливается на первом недоступном звене: выше него
 * ничего не известно даже теоретически — идентификатор следующего родителя
 * лежит в записи, которую публичный рендер не читает. Поэтому разрыв всегда
 * один и всегда в начале.
 *
 * @throws Error если цепочка родителей замкнута. Такого состояния CMS не
 *   допускает (замыкание проверяется при сохранении), но бесконечный обход хуже
 *   отказа: он не заканчивается, а отказ виден в логе и указывает на запись.
 */
export async function loadAncestors(
  node: Pick<CollectionCrumbNode, 'id' | 'parent'>,
  readCollection: CollectionReader,
): Promise<readonly BreadcrumbLink[]> {
  const chain: BreadcrumbLink[] = [];
  const visited = new Set<string>([String(node.id)]);
  let parentId = relationId(node.parent);

  while (parentId !== null) {
    if (visited.has(String(parentId))) {
      throw new Error(
        `Цепочка родителей подборки замкнута на записи ${String(parentId)}: обход крошек не ` +
          'может закончиться. Это дефект данных — исправляется в CMS, где замыкание при ' +
          'сохранении запрещено.',
      );
    }
    visited.add(String(parentId));

    const parent = await readCollection(parentId);
    const crumb = parent === null ? null : collectionCrumb(parent);
    if (parent === null || crumb === null) {
      chain.unshift(null);
      break;
    }
    chain.unshift(crumb);
    parentId = relationId(parent.parent);
  }

  return chain;
}

/**
 * Крошки страницы подборки: главная → доступные предки → сама подборка.
 *
 * Контейнер `/podborki` в цепочку не входит — обоснование в шапке
 * `../seo/breadcrumbs.ts`.
 *
 * @throws Error если у записи нет сохранённого пути. Для ТЕКУЩЕЙ страницы это
 *   не защитная ветка, а противоречие: страницу нашли по её пути, значит путь
 *   есть, и его отсутствие означает, что запись пришла не из
 *   `findCollectionByPath`.
 */
export async function collectionBreadcrumbs(
  node: CollectionCrumbNode,
  readCollection: CollectionReader,
  page = 1,
): Promise<BreadcrumbTrail> {
  const current = collectionCrumb(node);
  if (current === null) {
    throw new Error(
      `У подборки ${String(node.id)} нет сохранённого пути, поэтому крошки для неё собрать ` +
        'нельзя: у последнего звена обязан быть адрес — он же self-canonical страницы. ' +
        'Путь считает и хранит CMS; пустое значение здесь означает, что запись получена ' +
        'не поиском по пути.',
    );
  }

  const ancestors = await loadAncestors(node, readCollection);
  if (page === 1) {
    return buildBreadcrumbTrail({ ancestors, current });
  }

  // На странице пагинации сам список становится ССЫЛКОЙ, а текущим звеном —
  // номер страницы. Так у второй страницы есть путь назад к списку, и ведёт он на
  // БАЗОВЫЙ URL: `/page/1` не существует, и появиться в крошках он не может —
  // адрес звена считает `paginationPathFor`, а он на номере 1 отдаёт базовый путь.
  return buildBreadcrumbTrail({
    ancestors: [...ancestors, current],
    current: {
      label: paginationCrumbLabel(page),
      path: paginationPathFor(current.path, page),
    },
  });
}

/**
 * Крошки страницы карточки: главная → цепочка ОСНОВНОЙ подборки → карточка
 * (ТЗ §5.4).
 *
 * Основная подборка входит в цепочку сама и приносит своих предков. Если её нет
 * или она недоступна публично, остаются главная и карточка: выдуманного звена не
 * подставляется, ссылка на страницу без 200 не выводится.
 */
export async function cardBreadcrumbs(
  card: CardCrumbSource & Pick<Card, 'collections'>,
  readCollection: CollectionReader,
): Promise<BreadcrumbTrail> {
  const current = cardCrumb(card);
  const mainId = mainCollectionId(card);
  if (mainId === null) {
    return buildBreadcrumbTrail({ ancestors: [], current });
  }

  const main = await readCollection(mainId);
  const mainCrumb = main === null ? null : collectionCrumb(main);
  if (main === null || mainCrumb === null) {
    return buildBreadcrumbTrail({ ancestors: [null], current });
  }

  return buildBreadcrumbTrail({
    ancestors: [...(await loadAncestors(main, readCollection)), mainCrumb],
    current,
  });
}
