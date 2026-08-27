/**
 * Параметры запроса: фильтр меняет ПРЕДСТАВЛЕНИЕ и не создаёт адресов
 * (задача Э3-10).
 *
 * Норма: ТЗ §5.5 («фильтры на страницах подборок работают на клиенте или через
 * параметры, но не создают индексируемых URL: любые URL с параметрами
 * фильтрации отдают canonical на чистую страницу подборки»), ТЗ §6.5 («параметры
 * не попадают в sitemap и не участвуют в перелинковке»), решение Ч-04-3 (стили
 * и настроения — неиндексируемый фильтр, отдельных URL под них не создаётся),
 * `CLAUDE.md` — «Рендеринг» (фильтры меняют представление, но не создают
 * индексируемых URL).
 *
 * Здесь проверяется ЧИСТАЯ часть — разбор параметров, форма ссылок фильтра и
 * директива робота отфильтрованного представления. Что параметр не меняет
 * canonical, проверяется и здесь (значение canonical от параметров не зависит по
 * построению — путь передаётся отдельно), и на живом ответе смоуком
 * `apps/web/scripts/smoke-home-search.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  CARD_FORMAT_LABELS,
  CARD_FORMAT_PARAM,
  CARD_FORMATS,
  cardFormatOf,
  filterOptions,
  hasActiveFilter,
  NO_VIEW_PARAMS,
  parseViewParams,
  robotsForFilteredView,
  viewParamsQuery,
  withViewParams,
} from '../../apps/web/src/routing/view-params.js';

describe('разбор параметров представления', () => {
  it('без параметров фильтр не активен', () => {
    expect(parseViewParams('')).toEqual(NO_VIEW_PARAMS);
    expect(parseViewParams(null)).toEqual(NO_VIEW_PARAMS);
    expect(hasActiveFilter(NO_VIEW_PARAMS)).toBe(false);
  });

  it('известный параметр с известным значением включает фильтр', () => {
    const params = parseViewParams(`?${CARD_FORMAT_PARAM}=vertical`);

    expect(params.format).toBe('vertical');
    expect(hasActiveFilter(params)).toBe(true);
  });

  it('чужие параметры игнорируются целиком — они не фильтр', () => {
    // utm-метки и прочий хвост из внешних ссылок обязаны оставлять страницу той
    // же самой: у неё чистый canonical и НЕ изменившаяся директива робота.
    // Закрывать их `noindex` нельзя — noindex у адреса, склеиваемого с
    // каноническим, бьёт по самой канонической странице.
    const params = parseViewParams('?utm_source=vk&utm_campaign=8marta&fbclid=xxx');

    expect(params).toEqual(NO_VIEW_PARAMS);
    expect(hasActiveFilter(params)).toBe(false);
  });

  it('неизвестное значение известного параметра фильтром не становится', () => {
    expect(parseViewParams(`?${CARD_FORMAT_PARAM}=panorama`)).toEqual(NO_VIEW_PARAMS);
    expect(parseViewParams(`?${CARD_FORMAT_PARAM}=`)).toEqual(NO_VIEW_PARAMS);
  });

  it('порядок и повторы параметров на результат не влияют', () => {
    const direct = parseViewParams(`?${CARD_FORMAT_PARAM}=square`);

    expect(parseViewParams(`?utm_source=x&${CARD_FORMAT_PARAM}=square`)).toEqual(direct);
    expect(parseViewParams(new URLSearchParams([[CARD_FORMAT_PARAM, 'square']]))).toEqual(direct);
  });
});

describe('ссылки фильтра: второго адреса у страницы не появляется', () => {
  const BASE = '/podborki/prazdniki/8-marta';

  it('сброс фильтра ведёт на ЧИСТЫЙ путь, без пустого параметра', () => {
    expect(withViewParams(BASE, NO_VIEW_PARAMS)).toBe(BASE);
    expect(viewParamsQuery(NO_VIEW_PARAMS)).toBe('');
  });

  it('включённый фильтр — тот же путь плюс строка запроса', () => {
    const params = parseViewParams(`?${CARD_FORMAT_PARAM}=vertical`);

    expect(viewParamsQuery(params)).toBe(`?${CARD_FORMAT_PARAM}=vertical`);
    expect(withViewParams(BASE, params)).toBe(`${BASE}?${CARD_FORMAT_PARAM}=vertical`);
  });

  it('путь страницы пагинации фильтр не переписывает: /page/1 не появляется', () => {
    const params = parseViewParams(`?${CARD_FORMAT_PARAM}=horizontal`);

    expect(withViewParams(`${BASE}/page/2`, params)).toBe(
      `${BASE}/page/2?${CARD_FORMAT_PARAM}=horizontal`,
    );
    // Первая страница списка живёт по базовому URL (решение Ч-05): фильтр
    // добавляет только строку запроса и адресов не сочиняет.
    expect(withViewParams(BASE, params)).not.toContain('/page/1');
  });

  it('ряд ссылок фильтра: «все» плюс по одной на формат, текущая помечена', () => {
    const options = filterOptions(BASE, parseViewParams(`?${CARD_FORMAT_PARAM}=vertical`));

    expect(options).toHaveLength(CARD_FORMATS.length + 1);
    expect(options[0]?.href).toBe(BASE);
    expect(options.filter((option) => option.active)).toHaveLength(1);
    expect(options.find((option) => option.active)?.label).toBe(CARD_FORMAT_LABELS.vertical);
    for (const option of options) {
      expect(option.href.startsWith(BASE)).toBe(true);
    }
  });

  it('без фильтра текущим помечен пункт «все»', () => {
    const options = filterOptions(BASE, NO_VIEW_PARAMS);

    expect(options[0]?.active).toBe(true);
    expect(options.filter((option) => option.active)).toHaveLength(1);
  });
});

describe('директива робота отфильтрованного представления', () => {
  const FILTERED = parseViewParams(`?${CARD_FORMAT_PARAM}=vertical`);

  it('фильтр закрывает представление от индексации (ТЗ §5.2, §5.5)', () => {
    expect(robotsForFilteredView('index,follow', FILTERED)).toBe('noindex,follow');
    expect(robotsForFilteredView('noindex,follow', FILTERED)).toBe('noindex,follow');
  });

  it('без фильтра директива страницы не меняется', () => {
    expect(robotsForFilteredView('index,follow', NO_VIEW_PARAMS)).toBe('index,follow');
    expect(robotsForFilteredView('noindex,follow', NO_VIEW_PARAMS)).toBe('noindex,follow');
  });

  it('отфильтрованное представление не бывает открытее самой страницы', () => {
    expect(robotsForFilteredView('noindex,nofollow', FILTERED)).toBe('noindex,nofollow');
  });
});

describe('формат открытки считается по фактическим размерам файла', () => {
  it('вертикальная, горизонтальная и квадратная различаются', () => {
    expect(cardFormatOf({ height: 1600, width: 1280 })).toBe('vertical');
    expect(cardFormatOf({ height: 1280, width: 1600 })).toBe('horizontal');
    expect(cardFormatOf({ height: 1080, width: 1080 })).toBe('square');
  });

  it('почти квадратная считается квадратной, а не вертикальной', () => {
    // Порог нужен, потому что 1000×1004 глазом квадрат: без допуска фильтр
    // «квадратные» не нашёл бы ни одной открытки, а «вертикальные» показал бы
    // квадрат.
    expect(cardFormatOf({ height: 1004, width: 1000 })).toBe('square');
    expect(cardFormatOf({ height: 1000, width: 1004 })).toBe('square');
  });

  it('у каждого формата есть видимая подпись', () => {
    for (const format of CARD_FORMATS) {
      expect(CARD_FORMAT_LABELS[format].trim()).not.toBe('');
    }
  });
});
