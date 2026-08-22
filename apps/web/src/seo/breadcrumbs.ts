/**
 * Хлебные крошки: цепочка от главной и разметка `BreadcrumbList` (задача Э3-03).
 *
 * Норма: ТЗ §7.6 («на всех страницах глубже главной; отражают иерархию; текущая
 * страница — без ссылки; разметка `BreadcrumbList`»), ТЗ §5.4 («крошки от
 * главной по основной подборке»), `CLAUDE.md` — раздел «Рендеринг» (крошки
 * присутствуют в HTML-ответе сервера, навигация только `<a href>`) и раздел
 * «Структурированные данные» («разметка соответствует видимому содержимому»).
 *
 * Модуль ЧИСТЫЙ: ни запросов, ни чтения `process.env`, ни импортов Astro и
 * Payload. Из-за этого он входит в composite-проект `../../tsconfig.node.json` и
 * проверяется юнит-тестом из `tests/unit/web-breadcrumbs.test.ts`.
 *
 * ## Почему цепочка и разметка собираются ОДНОЙ функцией на одном значении
 *
 * Требование «разметка соответствует видимому содержимому» проверяемо только
 * если у видимой крошки и у элемента `itemListElement` один источник. Поэтому
 * {@link breadcrumbListJsonLd} принимает не «данные страницы», а уже собранную
 * цепочку {@link BreadcrumbTrail} — ту самую, которую печатает компонент
 * `../components/Breadcrumbs.astro`. Второй сборки списка для JSON-LD нет, и
 * появиться она не может: функция другого входа не принимает.
 *
 * ## Чего здесь нет намеренно
 *
 *   - **контейнерных звеньев `/otkrytki` и `/podborki`.** Крошки отражают
 *     иерархию, по которой страница достижима, а не сегменты её URL. У подборки
 *     это цепочка родителей (`/podborki/prazdniki` → `/podborki/prazdniki/8-marta`),
 *     у карточки — её основная подборка (ТЗ §5.4). Добавить в крошки плоский
 *     контейнер значило бы поставить ссылку на страницу каталога, которой на
 *     момент Э3-05/Э3-06 ещё нет (каталоги — задача Э3-08), то есть ссылку на
 *     404. Ссылка на не-200 в крошках запрещена;
 *   - **директив индексации и canonical страницы.** Крошки — навигация и
 *     разметка; `robots` и self-canonical задаёт layout (`BaseLayout.astro`);
 *   - **чтения записей CMS.** Адаптеры «запись → звено» и обход родителей живут
 *     в слое данных (`../data/breadcrumbs.ts`): им нужны сгенерированные типы
 *     Payload, а этому модулю они не нужны вовсе.
 */

import {
  buildAbsoluteUrl,
  canonicalizePath,
  looksLikeAbsoluteUrl,
  type SharedEnv,
} from '@otkritka/shared';

/**
 * Звено цепочки до сборки: видимый текст и путь от корня сайта.
 *
 * Путь, а не абсолютный URL: хост появляется единственным хелпером
 * (`buildAbsoluteUrl` из `@otkritka/shared`) и только в разметке JSON-LD, где
 * абсолютный адрес обязателен. Во `href` идёт путь — так ссылка не зависит от
 * того, каким хостом отвечает сервер.
 */
export interface BreadcrumbNode {
  readonly label: string;
  readonly path: string;
}

/**
 * Звено цепочки в том виде, в каком его отдаёт слой данных: узел либо `null` —
 * РАЗРЫВ.
 *
 * `null` означает «между этими двумя звеньями есть узел, публичной страницы у
 * которого нет». Достижимое состояние: CMS не требует, чтобы родитель был
 * опубликован раньше ребёнка (матрица вложенности в
 * `apps/cms/src/collections/collection-path.ts` смотрит на вид узла, а не на
 * статус), поэтому опубликованный узел может висеть под черновиком.
 *
 * Решение по разрыву — {@link buildBreadcrumbTrail}: звено ВЫПАДАЕТ из цепочки.
 * Две отвергнутые альтернативы: подставить ссылку на неопубликованный путь
 * (ссылка на страницу, отдающую 404) и подставить звено-заглушку без ссылки
 * (выдуманный элемент в разметке, которому нечего соответствовать на экране).
 */
export type BreadcrumbLink = BreadcrumbNode | null;

/** Звено собранной цепочки. Значение готово и к выводу, и к разметке. */
export interface BreadcrumbItem {
  readonly label: string;
  /** Путь звена в канонической форме — без завершающего слеша (решение Ч-21). */
  readonly path: string;
  /**
   * Выводить ссылку? У текущей страницы — нет (ТЗ §7.6). Поле отдельно от
   * `path`, потому что адрес у текущей страницы есть (он же self-canonical) и
   * нужен разметке; отсутствует именно ССЫЛКА.
   */
  readonly linked: boolean;
  /** Позиция в `BreadcrumbList`, начиная с 1. */
  readonly position: number;
}

export type BreadcrumbTrail = readonly BreadcrumbItem[];

/** Главная — первое звено любой цепочки. */
export const HOME_CRUMB: BreadcrumbNode = { label: 'Главная', path: '/' };

export interface BreadcrumbTrailInput {
  /**
   * Звенья между главной и текущей страницей, в порядке ОТ ГЛАВНОЙ. `null` —
   * разрыв (см. {@link BreadcrumbLink}).
   */
  readonly ancestors: readonly BreadcrumbLink[];
  /** Текущая страница. Показывается всегда и всегда без ссылки. */
  readonly current: BreadcrumbNode;
}

/**
 * Канонический путь звена.
 *
 * Абсолютный адрес отклоняется ЗДЕСЬ, а не глубже. Сам по себе
 * `canonicalizePath` его не отклоняет — он схлопнул бы `https://chuzhoy.test/x`
 * в правдоподобный относительный путь `/https:/chuzhoy.test/x`, то есть в
 * рабочий `href` на несуществующую страницу. Абсолютный URL до JSON-LD дошёл бы
 * и там упал (`buildAbsoluteUrl` его отвергает), но упал бы уже пятисоткой на
 * готовой странице и без указания на источник — на конкретное звено крошек.
 */
function crumbPath(path: string): string {
  if (looksLikeAbsoluteUrl(path)) {
    throw new Error(
      `Звено крошек «${path}» задано абсолютным адресом. Ожидается путь от корня сайта: ` +
        'хост попадает в абсолютный URL только из SITE_URL (CLAUDE.md, правила URL), а ' +
        '`href` крошки остаётся относительным — иначе ссылка зависела бы от того, каким ' +
        'хостом ответил сервер.',
    );
  }
  return canonicalizePath(path);
}

function requireLabel(label: string, path: string): string {
  const trimmed = label.trim();
  if (trimmed === '') {
    throw new Error(
      `У звена крошек «${path}» пустой текст. Крошка без текста — это ссылка, у которой ` +
        'нечего прочитать, и элемент BreadcrumbList без обязательного `name`. Заполните ' +
        'заголовок записи (H1 или title): подставлять вместо него путь или слово-заглушку ' +
        'нельзя, разметка обязана соответствовать видимому содержимому.',
    );
  }
  return trimmed;
}

/**
 * Собирает цепочку крошек: главная → доступные предки → текущая страница.
 *
 * Что функция гарантирует вызывающему шаблону:
 *   - первое звено — главная, со ссылкой;
 *   - последнее звено — текущая страница, БЕЗ ссылки, и оно единственное такое;
 *   - позиции идут подряд с 1, дыр нет даже после обрыва цепочки;
 *   - все пути приведены к канонической форме (решение Ч-21) и относительны;
 *   - одного пути дважды в цепочке нет.
 *
 * @throws Error если текущая страница — главная (у главной крошек нет, ТЗ §7.6);
 *   если текст звена пуст; если путь повторяется; если вместо пути передан
 *   абсолютный адрес или путь с параметрами (проверка — в `canonicalizePath`).
 */
export function buildBreadcrumbTrail(input: BreadcrumbTrailInput): BreadcrumbTrail {
  const currentPath = crumbPath(input.current.path);
  if (currentPath === HOME_CRUMB.path) {
    throw new Error(
      'Крошки строятся только для страниц ГЛУБЖЕ главной (ТЗ §7.6), а текущая страница — ' +
        'главная. Цепочка из одной главной означала бы ссылку страницы на саму себя.',
    );
  }

  const nodes: BreadcrumbNode[] = [HOME_CRUMB];
  for (const ancestor of input.ancestors) {
    // Разрыв: звена нет публично. Не подставляем ни ссылку, ни заглушку —
    // см. BreadcrumbLink.
    if (ancestor === null) {
      continue;
    }
    nodes.push({
      label: requireLabel(ancestor.label, ancestor.path),
      path: crumbPath(ancestor.path),
    });
  }
  nodes.push({ label: requireLabel(input.current.label, currentPath), path: currentPath });

  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.path)) {
      throw new Error(
        `Путь «${node.path}» встречается в крошках повторно. Повтор означает ссылку на ` +
          'страницу, где посетитель уже находится, и два элемента BreadcrumbList с одним ' +
          'адресом. Проверьте цепочку родителей подборки и её основную подборку у карточки.',
      );
    }
    seen.add(node.path);
  }

  const last = nodes.length - 1;
  return nodes.map((node, index) => ({
    label: node.label,
    path: node.path,
    linked: index !== last,
    position: index + 1,
  }));
}

export interface BreadcrumbListItemJsonLd {
  readonly '@type': 'ListItem';
  readonly position: number;
  readonly name: string;
  /** Абсолютный URL звена. Собран из `SITE_URL` единственным хелпером проекта. */
  readonly item: string;
}

export interface BreadcrumbListJsonLd {
  readonly '@context': 'https://schema.org';
  readonly '@type': 'BreadcrumbList';
  readonly itemListElement: readonly BreadcrumbListItemJsonLd[];
}

/**
 * Разметка `BreadcrumbList` по УЖЕ СОБРАННОЙ цепочке.
 *
 * Соответствие видимому содержимому держится на входе: элементы, их порядок и
 * их `name` берутся из той же цепочки, что печатает компонент. Ни одного
 * элемента функция не добавляет и ни одного не пропускает.
 *
 * `item` задан у КАЖДОГО элемента, включая текущую страницу. Отсутствие ссылки
 * на экране — правило навигации (не ссылаться туда, где посетитель уже
 * находится), а не утверждение «у страницы нет адреса»: адрес у неё есть и
 * совпадает с self-canonical. Пропуск последнего `item` (что схема допускает)
 * сделал бы разметку и видимые крошки НЕ соответствующими один к одному, а
 * именно это соответствие требуется проверять.
 *
 * @param env срез окружения — аргумент, а не чтение `process.env` внутри: тест
 *   обязан проверять несколько значений `SITE_URL` без мутации глобального
 *   окружения.
 * @throws Error если `SITE_URL` не задан или некорректен.
 */
export function breadcrumbListJsonLd(
  trail: BreadcrumbTrail,
  env?: SharedEnv,
): BreadcrumbListJsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((item) => ({
      '@type': 'ListItem',
      position: item.position,
      name: item.label,
      item: env === undefined ? buildAbsoluteUrl(item.path) : buildAbsoluteUrl(item.path, env),
    })),
  };
}

/**
 * Текст для тела `<script type="application/ld+json">`.
 *
 * Экранируются `<`, `>` и `&`: заголовок записи — это текст, введённый
 * человеком, и последовательность `</script>` внутри строки закрыла бы тег.
 * Экранирование делается в JSON-строке (`<`), поэтому смысл значения не
 * меняется — распарсенный результат тождественно равен исходному объекту, что
 * проверяется тестом.
 */
export function jsonLdScriptText(value: BreadcrumbListJsonLd): string {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/>/gu, '\\u003e')
    .replace(/&/gu, '\\u0026');
}
