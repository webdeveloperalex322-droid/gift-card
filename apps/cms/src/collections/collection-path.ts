/**
 * Сборка итогового пути подборки (задача Э1-05): чистое ядро правил, без
 * Payload и без базы.
 *
 * Почему отдельный модуль, а не тело хука: путь подборки — это её URL, то есть
 * самая дорогая часть проекта («изменение существующего URL без одиночного 301 —
 * критическая ошибка», «смена пути родителя переписывает пути всех дочерних
 * подборок»). Правило, записанное внутри хука, проверяется только поднятой
 * базой; вынесенное в чистую функцию — обычным юнит-тестом на каждый случай,
 * включая негативные.
 *
 * ФОРМА ПУТЕЙ — решение человека от 2026-08-22 (Ч-04-9, отменяет прежнюю
 * запись):
 *
 *   /podborki                        каталог подборок
 *   /podborki/prazdniki              группирующий узел
 *   /podborki/prazdniki/8-marta      праздничная посадочная
 *   /podborki/prazdniki/8-marta/mame пара «праздник × адресат»
 *   /podborki/adresaty/mame          адресат без праздника
 *
 * Карточки живут в другом пространстве имён (`/otkrytki/<slug>`), поэтому
 * коллизия «карточка против группирующего узла» невозможна структурно, и
 * проверять её по двум коллекциям не нужно.
 *
 * Что гарантирует планировщик:
 *   1. каждый сегмент пути проходит `isValidSlug` из `@otkritka/shared` — своих
 *      правил slug и своей транслитерации здесь нет;
 *   2. итоговый путь проходит реестр зарезервированных маршрутов
 *      (`assertPathNotReserved`) — включая запрет сегмента `page` на любой
 *      позиции и путь админки, вычисленный из `PAYLOAD_ADMIN_PATH`;
 *   3. порядок сегментов только «повод → уточнение» (решение Ч-04-7): пара
 *      живёт под праздником, а праздник под адресатом не создаётся НИКОГДА.
 *      Правило закодировано матрицей {@link ALLOWED_PARENT_KINDS}, а не
 *      комментарием: сочетания «родитель → ребёнок», которого в матрице нет,
 *      собрать невозможно;
 *   4. узел не может стать собственным потомком.
 *
 * Чего планировщик НЕ делает и не может: не знает о других записях, поэтому НЕ
 * проверяет уникальность итогового пути. Уникальность обеспечивает уникальный
 * индекс БД на сохранённом поле `path` (решение Ч-04-9): запрос «нет ли такого
 * пути» перед записью прошли бы оба из двух одновременных сохранений через API,
 * и в базе оказались бы две подборки с одним URL.
 */
import {
  type SharedEnv,
  assertPathNotReserved,
  canonicalizePath,
  currentEnv,
  isValidSlug,
  pathSegments,
} from '@otkritka/shared';

import { COLLECTION_PATH_PREFIX } from '../seo/paths';

/**
 * Вид узла таксономии. Набор ЗАКРЫТЫЙ, и это часть защиты URL:
 *
 *   - `group` — группирующий узел («Праздники», «Адресаты»). Живёт прямо под
 *     `/podborki` и ни во что не вкладывается;
 *   - `occasion` — повод: праздничная посадочная. Живёт под группирующим узлом;
 *   - `recipient` — уточнение (адресат). Живёт либо под своим группирующим
 *     узлом (адресат без праздника), либо под поводом (пара «праздник ×
 *     адресат»).
 *
 * Вида под СТИЛЬ и НАСТРОЕНИЕ здесь нет намеренно (решение Ч-04-3): стили и
 * настроения остаются неиндексируемым фильтром без собственных URL. Отсутствие
 * вида означает отсутствие пути: URL появляется только у узла этой коллекции,
 * поэтому «стиль» нельзя завести подборкой даже случайно.
 */
export const COLLECTION_NODE_KINDS = ['group', 'occasion', 'recipient'] as const;

export type CollectionNodeKind = (typeof COLLECTION_NODE_KINDS)[number];

/**
 * Допустимые родители для каждого вида узла. `null` означает корень контейнера
 * подборок (`/podborki`).
 *
 * Это и есть машинная запись решения Ч-04-7 «порядок только повод → уточнение».
 * Обратный порядок отсутствует как сочетание: у `occasion` в списке родителей
 * нет `recipient`, поэтому `/podborki/adresaty/mame/8-marta` не собирается ни
 * через админку, ни через REST, ни через GraphQL.
 *
 * Матрица ациклична (`group` упирается в корень), поэтому она же ограничивает
 * глубину: максимум — три сегмента после `/podborki`. Отдельного правила «не
 * глубже N» нет намеренно: два правила об одном и том же со временем разошлись
 * бы.
 */
export const ALLOWED_PARENT_KINDS: Record<
  CollectionNodeKind,
  readonly (CollectionNodeKind | null)[]
> = {
  group: [null],
  occasion: ['group'],
  recipient: ['group', 'occasion'],
};

/** Подписи видов узла: используются и в админке, и в текстах отказов. */
export const COLLECTION_NODE_KIND_LABELS: Record<CollectionNodeKind, string> = {
  group: 'Группирующий узел (например, «Праздники», «Адресаты»)',
  occasion: 'Повод: праздничная посадочная',
  recipient: 'Уточнение: адресат',
};

export type CollectionNodeRule =
  | 'forbidden-parent'
  | 'invalid-slug'
  | 'parent-cycle'
  | 'parent-outside-container'
  | 'reserved-path'
  | 'unknown-kind';

/**
 * Отказ правила иерархии. Отдельный класс с машинным признаком `rule`: тест
 * обязан проверять, что отказ произошёл по ТОЙ причине, иначе зелёный
 * негативный тест может держаться на опечатке в slug.
 */
export class CollectionNodeError extends Error {
  readonly rule: CollectionNodeRule;

  constructor(rule: CollectionNodeRule, message: string) {
    super(message);
    this.name = 'CollectionNodeError';
    this.rule = rule;
  }
}

function fail(rule: CollectionNodeRule, message: string): never {
  throw new CollectionNodeError(rule, message);
}

/**
 * Родитель в том виде, в каком он приходит из базы.
 *
 * Типы полей — `unknown`: значения читаются из записи, форму которой гарантирует
 * не тип, а та же самая проверка. Сохранённый `path` родителя здесь
 * авторитетен — именно поэтому цепочку родителей не надо обходить целиком.
 */
export interface CollectionNodeParent {
  readonly id: number | string;
  readonly nodeKind: unknown;
  readonly path: unknown;
}

/** Проверяемая запись. Приходит из REST/GraphQL, поэтому типы не гарантированы. */
export interface CollectionNodeCandidate {
  readonly id?: number | string | null;
  readonly slug?: unknown;
  readonly nodeKind?: unknown;
  /** `null` или `undefined` — узел верхнего уровня. */
  readonly parent?: CollectionNodeParent | null | undefined;
  /** Сохранённый путь записи ДО правки: нужен для обнаружения цикла. */
  readonly currentPath?: string | null;
}

export interface CollectionNodePlan {
  /** Итоговый путь записи в канонической форме. Хранится в поле `path`. */
  readonly path: string;
  /** Путь родителя или `null` для узла верхнего уровня. */
  readonly parentPath: string | null;
  readonly nodeKind: CollectionNodeKind;
  readonly slug: string;
  /** Число сегментов после `/podborki`: 1 — группа, 3 — пара. */
  readonly depth: number;
}

/** Входит ли значение в закрытый набор видов узла. */
export function isCollectionNodeKind(value: unknown): value is CollectionNodeKind {
  return (
    typeof value === 'string' && (COLLECTION_NODE_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Лежит ли `path` строго ПОД `ancestorPath`.
 *
 * Сравнение по границе сегмента, а не по подстроке: `/podborki/prazdniki-2026`
 * начинается с `/podborki/prazdniki`, но потомком его не является, и трактовка
 * «по подстроке» переписала бы путь чужой ветке при переносе родителя.
 */
export function isDescendantPath(ancestorPath: string, path: string): boolean {
  return path.startsWith(`${ancestorPath}/`);
}

/**
 * Собирает итоговый путь узла и проверяет все правила иерархии.
 *
 * @throws CollectionNodeError с машинным признаком причины.
 */
export function planCollectionNode(input: {
  readonly candidate: CollectionNodeCandidate;
  readonly env?: SharedEnv;
}): CollectionNodePlan {
  const { candidate } = input;
  const env = input.env ?? currentEnv();

  const slug = typeof candidate.slug === 'string' ? candidate.slug.trim() : '';
  if (slug === '' || !isValidSlug(slug)) {
    fail(
      'invalid-slug',
      `Slug подборки «${describe(candidate.slug)}» не проходит правила URL проекта. ` +
        'Ожидается один сегмент: строчные латинские буквы, цифры и дефисы между ' +
        'словами, не длиннее 80 символов и не только из цифр. Итоговый путь ' +
        'собирается из slug родителей и этого сегмента, поэтому исправлять его надо ' +
        'сейчас: после первой публикации URL неизменяем.',
    );
  }

  if (!isCollectionNodeKind(candidate.nodeKind)) {
    fail(
      'unknown-kind',
      `Вид узла «${describe(candidate.nodeKind)}» неизвестен. Допустимы: ` +
        `${COLLECTION_NODE_KINDS.join(' / ')}. Набор закрытый: от вида зависит, куда ` +
        'узел можно вложить, и неизвестное значение означало бы путь, собранный без ' +
        'правил. Стиль и настроение подборками не создаются вовсе (решение Ч-04-3): ' +
        'это неиндексируемый фильтр без собственных URL.',
    );
  }

  const nodeKind = candidate.nodeKind;
  const parent = candidate.parent ?? null;
  const parentPath = parent === null ? null : readParentPath(parent);

  // Замыкание проверяется РАНЬШЕ матрицы вложенности: «сам себе родитель» — это
  // более грубая ошибка, чем неподходящий вид узла, и сообщение о ней полезнее.
  // Проверка защитная и в согласованном дереве недостижима (матрица видов не
  // допускает повторения вида по цепочке — это закреплено тестом), но остаётся:
  // она страхует правку данных в обход хуков и будущее расширение матрицы.
  if (parentPath !== null) {
    if (candidate.id !== undefined && candidate.id !== null && parent?.id === candidate.id) {
      fail(
        'parent-cycle',
        'Подборка не может быть родителем самой себе: путь собирался бы из себя же.',
      );
    }
    const currentPath = typeof candidate.currentPath === 'string' ? candidate.currentPath : null;
    if (
      currentPath !== null &&
      (parentPath === currentPath || isDescendantPath(currentPath, parentPath))
    ) {
      fail(
        'parent-cycle',
        `Родитель «${parentPath}» лежит внутри самой подборки «${currentPath}». ` +
          'Такое поддерево недостижимо от корня, а его путь нельзя собрать: ' +
          'склейка была бы бесконечной.',
      );
    }
  }

  const parentKind = parent === null ? null : readParentKind(parent);
  const allowedParents = ALLOWED_PARENT_KINDS[nodeKind];

  if (!allowedParents.includes(parentKind)) {
    fail('forbidden-parent', describeForbiddenParent(nodeKind, parentKind, allowedParents));
  }

  const base = parentPath ?? COLLECTION_PATH_PREFIX;
  const path = canonicalizePath(`${base}/${slug}`);

  try {
    assertPathNotReserved(path, env);
  } catch (error) {
    // Реестр отказывает и тогда, когда путь админки неизвестен: без него нельзя
    // сказать, свободен ли путь записи. «Не смогли проверить» обязано означать
    // отказ — иначе запись прошла бы вообще без проверки и могла занять адрес
    // админки.
    fail('reserved-path', error instanceof Error ? error.message : String(error));
  }

  return {
    depth: pathSegments(path).length - pathSegments(COLLECTION_PATH_PREFIX).length,
    nodeKind,
    parentPath,
    path,
    slug,
  };
}

function readParentKind(parent: CollectionNodeParent): CollectionNodeKind {
  if (!isCollectionNodeKind(parent.nodeKind)) {
    fail(
      'forbidden-parent',
      `У выбранной родительской подборки (id ${String(parent.id)}) вид узла ` +
        `«${describe(parent.nodeKind)}» неизвестен, поэтому проверить допустимость ` +
        'вложения нельзя.',
    );
  }
  return parent.nodeKind;
}

function readParentPath(parent: CollectionNodeParent): string {
  if (typeof parent.path !== 'string' || parent.path.trim() === '') {
    fail(
      'parent-outside-container',
      `У выбранной родительской подборки (id ${String(parent.id)}) нет сохранённого ` +
        'пути. Пустой путь родителя нельзя трактовать как корень: узел молча ' +
        'переехал бы на уровень выше и занял чужой URL.',
    );
  }

  const parentPath = canonicalizePath(parent.path.trim());

  if (parentPath !== COLLECTION_PATH_PREFIX && !isDescendantPath(COLLECTION_PATH_PREFIX, parentPath)) {
    fail(
      'parent-outside-container',
      `Путь родителя «${parentPath}» лежит вне контейнера подборок ` +
        `«${COLLECTION_PATH_PREFIX}». Подборки живут только под ним: карточки — это ` +
        'другое пространство имён (/otkrytki), и смешивать их запрещено формой ' +
        'путей от 2026-08-22.',
    );
  }

  return parentPath;
}

function describeForbiddenParent(
  nodeKind: CollectionNodeKind,
  parentKind: CollectionNodeKind | null,
  allowedParents: readonly (CollectionNodeKind | null)[],
): string {
  const allowed = allowedParents
    .map((kind) => (kind === null ? `корень ${COLLECTION_PATH_PREFIX}` : kind))
    .join(' / ');
  const actual = parentKind === null ? `корень ${COLLECTION_PATH_PREFIX}` : parentKind;

  const orderNote =
    nodeKind === 'occasion' && parentKind === 'recipient'
      ? ' Это обратный порядок сегментов: по решению Ч-04-7 порядок только ' +
        '«повод → уточнение», пара живёт под праздником, а праздник под адресатом ' +
        'не создаётся никогда.'
      : '';

  return (
    `Узел вида «${nodeKind}» (${COLLECTION_NODE_KIND_LABELS[nodeKind]}) нельзя ` +
    `разместить под «${actual}». Допустимые родители: ${allowed}.${orderNote}`
  );
}

function describe(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
}
