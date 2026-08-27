/**
 * Параметры запроса, меняющие ПРЕДСТАВЛЕНИЕ страницы (задача Э3-10).
 *
 * Норма: ТЗ §5.5 («фильтры на страницах подборок работают на клиенте или через
 * параметры, но не создают индексируемых URL: любые URL с параметрами
 * фильтрации отдают canonical на чистую страницу подборки»), ТЗ §6.5
 * («параметры не попадают в sitemap и не участвуют в перелинковке»), решение
 * Ч-04-3 («стили и настроения — неиндексируемый фильтр, отдельных URL под них не
 * создаётся»), `CLAUDE.md` — разделы «Рендеринг» и «Правила индексации».
 *
 * Модуль ЧИСТЫЙ: без Astro, без Payload, без чтения `process.env`. Входит в
 * composite-проект `../../tsconfig.node.json`, проверяется юнит-тестом
 * `tests/unit/web-view-params.test.ts`.
 *
 * ## Три правила, которые здесь закодированы
 *
 *   1. **Параметр не участвует в canonical.** Его здесь просто нет: canonical
 *      строится из ПУТИ (`./canonical.ts`), а путь приходит отдельно от строки
 *      запроса — сложить их в один адрес нечем. Свойство «набор параметров не
 *      влияет на canonical» держится поэтому на форме кода, а не на дисциплине
 *      шаблонов;
 *   2. **Отфильтрованное представление закрыто от индексации** (ТЗ §5.2:
 *      фильтры — всегда `noindex`). При этом оно не бывает ОТКРЫТЕЕ самой
 *      страницы: {@link robotsForFilteredView} только закрывает;
 *   3. **Чужие параметры игнорируются целиком.** utm-метки и хвост из внешних
 *      ссылок оставляют страницу той же самой: у неё чистый canonical и
 *      неизменившаяся директива. Закрывать их `noindex` НЕЛЬЗЯ — директива у
 *      адреса, который склеивается с каноническим, бьёт по самой канонической
 *      странице.
 *
 * ## Почему фильтр — по ФОРМАТУ, а не по стилю и настроению
 *
 * ТЗ §5.5 называет три измерения: стиль, формат, настроение. Стиля и настроения
 * в модели данных НЕТ — и это не пробел: список стилей человек не утверждал, а
 * отдельными узлами таксономии они не создаются (Ч-04-3). Придумать значения
 * означало бы завести данные за человека. Формат же считается по ФАКТИЧЕСКИМ
 * размерам файла, которые уже лежат в зеркале производных: ни нового поля, ни
 * нового справочника для него не нужно. Фильтр по стилю и настроению появится,
 * когда человек утвердит значения, — и появится он тем же механизмом, добавлением
 * измерения сюда.
 *
 * ## Почему фильтр НЕ пересобирает страницы списка
 *
 * Отфильтрованное представление показывает те же страницы того же списка, просто
 * пряча часть плиток. Пересчёт числа страниц под фильтр означал бы, что состав
 * `/page/2` зависит от параметра: один и тот же адрес отдавал бы разное
 * содержание и разный статус (страница 3 «существует» без фильтра и «не
 * существует» с ним). Это ровно то семейство адресов, которого §5.5 велит
 * избегать. Поэтому пагинация считается по ПОЛНОМУ списку, а фильтр — это
 * представление её страниц; цена решения — возможная полупустая страница у
 * узкого фильтра, и она названа в отчёте задачи.
 */

import type { RobotsDirective } from './pagination.js';

/**
 * Имя параметра фильтра по формату открытки.
 *
 * Латиницей и без транслитерации: правила slug (Ч-04) описывают ПУТИ, а строка
 * запроса частью пути не является и в канонический адрес не попадает вовсе.
 */
export const CARD_FORMAT_PARAM = 'format';

/**
 * Форматы открытки. Набор закрыт: значение вне набора фильтром не становится, и
 * страница показывает весь список — то есть непонятный параметр ведёт себя как
 * его отсутствие, а не как пустая выдача.
 */
export const CARD_FORMATS = ['vertical', 'horizontal', 'square'] as const;

export type CardFormat = (typeof CARD_FORMATS)[number];

/** Видимые подписи форматов: текст ссылки фильтра. */
export const CARD_FORMAT_LABELS: Readonly<Record<CardFormat, string>> = {
  horizontal: 'Горизонтальные',
  square: 'Квадратные',
  vertical: 'Вертикальные',
};

/**
 * Допуск, внутри которого стороны считаются равными, — 5 % большей стороны.
 *
 * Без допуска квадратной считалась бы только точная пропорция 1:1, и открытка
 * 1000×1004 (глазом квадрат) попадала бы в «вертикальные». Порог — выбор агента
 * (кандидат в реестр решений); он влияет только на распределение плиток по
 * фильтру и ни на один адрес.
 */
const SQUARE_TOLERANCE = 0.05;

/** Состояние представления, заданное строкой запроса. */
export interface ViewParams {
  /** Активный фильтр по формату либо `null` — показываются все открытки. */
  readonly format: CardFormat | null;
}

/** Представление без единого активного фильтра. */
export const NO_VIEW_PARAMS: ViewParams = Object.freeze({ format: null });

function isCardFormat(value: string | null): value is CardFormat {
  return value !== null && (CARD_FORMATS as readonly string[]).includes(value);
}

/**
 * Разбор строки запроса в состояние представления.
 *
 * Всё, чего модуль не знает, отбрасывается: неизвестный параметр, неизвестное
 * значение известного параметра и пустое значение дают {@link NO_VIEW_PARAMS}.
 * Отказом это не является намеренно — адрес с чужим параметром обязан отдавать
 * ту же страницу с тем же canonical, а не 400.
 */
export function parseViewParams(
  search: string | URLSearchParams | null | undefined,
): ViewParams {
  if (search === null || search === undefined) {
    return NO_VIEW_PARAMS;
  }
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const format = params.get(CARD_FORMAT_PARAM);
  return isCardFormat(format) ? { format } : NO_VIEW_PARAMS;
}

/** Активен ли хоть один фильтр представления. */
export function hasActiveFilter(params: ViewParams): boolean {
  return params.format !== null;
}

/** Строка запроса активных фильтров: `''` либо `?format=<значение>`. */
export function viewParamsQuery(params: ViewParams): string {
  if (params.format === null) {
    return '';
  }
  return `?${CARD_FORMAT_PARAM}=${encodeURIComponent(params.format)}`;
}

/**
 * Адрес того же пути с активными фильтрами.
 *
 * Путь передаётся как есть: функция не сочиняет адресов, не трогает сегмент
 * `/page/N` и не превращает базовый URL в `/page/1` (которого не существует).
 */
export function withViewParams(path: string, params: ViewParams): string {
  return `${path}${viewParamsQuery(params)}`;
}

/** Пункт ряда ссылок фильтра. */
export interface FilterOption {
  /** Видимый текст ссылки. */
  readonly label: string;
  /** Адрес: тот же путь плюс строка запроса; у пункта «все» — чистый путь. */
  readonly href: string;
  /** Пункт соответствует текущему представлению. */
  readonly active: boolean;
}

/** Подпись пункта «показать всё». */
export const ALL_FORMATS_LABEL = 'Все форматы';

/**
 * Ряд ссылок фильтра для страницы по адресу `path`.
 *
 * Первым идёт пункт сброса — он ведёт на ЧИСТЫЙ путь, то есть на канонический
 * адрес страницы. Так у любого отфильтрованного представления есть видимая
 * ссылка на каноническую страницу.
 */
export function filterOptions(path: string, params: ViewParams): readonly FilterOption[] {
  return [
    { active: params.format === null, href: path, label: ALL_FORMATS_LABEL },
    ...CARD_FORMATS.map((format) => ({
      active: params.format === format,
      href: withViewParams(path, { format }),
      label: CARD_FORMAT_LABELS[format],
    })),
  ];
}

/**
 * Директива робота отфильтрованного представления.
 *
 * Фильтр закрывает страницу от индексации (ТЗ §5.2: фильтры и сортировка —
 * всегда `noindex`), но не открывает: у страницы с `noindex,nofollow`
 * представление остаётся `noindex,nofollow`. Правило повторяет форму
 * `robotsForPage` из `./pagination.ts` намеренно — оба про одно: производное
 * представление не бывает открытее исходной страницы.
 */
export function robotsForFilteredView(base: RobotsDirective, params: ViewParams): RobotsDirective {
  if (!hasActiveFilter(params)) {
    return base;
  }
  return base === 'noindex,nofollow' ? base : 'noindex,follow';
}

/**
 * Формат открытки по фактическим размерам файла.
 *
 * Размеры берутся из зеркала производных (`../images/card-image.ts`), то есть из
 * того же значения, которое стоит в атрибутах `<img>`: фильтр показывает ровно
 * то, что видно, а не то, что записано отдельным полем и может с картинкой
 * разойтись.
 */
export function cardFormatOf(size: { readonly width: number; readonly height: number }): CardFormat {
  const longest = Math.max(size.width, size.height);
  if (longest <= 0) {
    return 'square';
  }
  if (Math.abs(size.width - size.height) <= longest * SQUARE_TOLERANCE) {
    return 'square';
  }
  return size.height > size.width ? 'vertical' : 'horizontal';
}
