/**
 * Пагинация сегментом пути (задача Э3-07).
 *
 * Норма: решение Ч-05 (`CLAUDE.md`, «Правила URL» — пагинация сегментом
 * `/page/N`, первая страница живёт по базовому URL, `/page/1` не существует ни на
 * одном уровне), решение Ч-01b/Ч-05 («Правила индексации» — страницы 2+ отдают
 * `noindex,follow`, в sitemap не входят), раздел «Рендеринг» (бесконечная лента
 * запрещена, навигация только `<a href>`).
 *
 * Здесь проверяются ЗНАЧЕНИЯ, из которых собираются адреса и ссылки пагинации:
 * разбор номера страницы из адреса, расчёт числа страниц, форма пути, директива
 * робота и модель блока ссылок. HTTP-статусы (301 на `/page/1`, 404 на номере вне
 * диапазона) складываются в маршрутах из этих же решений, и на живом сервере их
 * проверяет смоук `apps/web/scripts/smoke-pages.ts`.
 *
 * Главное, что закрепляется: адреса `/page/1` не существует НИ В ОДНОМ выходном
 * значении — ни у ссылки «первая страница», ни у ссылки «предыдущая» со второй
 * страницы. Проверяется не отсутствием опечатки в шаблоне, а свойством функции:
 * `paginationPathFor(base, 1)` равен базовому пути.
 */
import { describe, expect, it } from 'vitest';

import { PAGINATION_SEGMENT } from '@otkritka/shared';

import {
  decidePageParam,
  pageCountFor,
  PAGINATION_WINDOW,
  paginationCrumbLabel,
  paginationModel,
  paginationPathFor,
  paginationTitle,
  splitPaginatedPath,
} from '../../apps/web/src/routing/pagination.js';

const BASE = '/podborki/prazdniki/8-marta';

describe('форма пути страницы пагинации', () => {
  it('первая страница живёт по базовому URL: /page/1 не собирается никогда', () => {
    expect(paginationPathFor(BASE, 1)).toBe(BASE);
    expect(paginationPathFor('/otkrytki', 1)).toBe('/otkrytki');
  });

  it('страницы 2+ — сегментом пути, а не параметром запроса (решение Ч-05)', () => {
    expect(paginationPathFor(BASE, 2)).toBe(`${BASE}/${PAGINATION_SEGMENT}/2`);
    expect(paginationPathFor('/otkrytki', 17)).toBe(`/otkrytki/${PAGINATION_SEGMENT}/17`);
  });

  it('базовый путь приводится к канонической форме до склейки', () => {
    expect(paginationPathFor(`${BASE}/`, 2)).toBe(`${BASE}/${PAGINATION_SEGMENT}/2`);
  });

  it('корень не пагинируется: у главной списка нет', () => {
    expect(() => paginationPathFor('/', 2)).toThrow(/Корень сайта не пагинируется/);
  });

  it('абсолютный адрес вместо базового пути отклоняется, а не превращается в путь', () => {
    expect(() => paginationPathFor('https://chuzhoy.test/otkrytki', 2)).toThrow();
  });

  it('номер страницы — целое от 1; ноль, дробь и отрицательное отклоняются', () => {
    for (const page of [0, -1, 1.5, Number.NaN]) {
      expect(() => paginationPathFor(BASE, page)).toThrow();
    }
  });
});

describe('разбор адреса: где кончается список и начинается номер страницы', () => {
  it('путь без сегмента page — это базовый URL списка', () => {
    expect(splitPaginatedPath(BASE)).toEqual({ basePath: BASE, pageParam: null });
    expect(splitPaginatedPath('/otkrytki')).toEqual({ basePath: '/otkrytki', pageParam: null });
  });

  it('хвост page/N отделяется от базового пути', () => {
    expect(splitPaginatedPath(`${BASE}/${PAGINATION_SEGMENT}/2`)).toEqual({
      basePath: BASE,
      pageParam: '2',
    });
    expect(splitPaginatedPath(`/otkrytki/${PAGINATION_SEGMENT}/01`)).toEqual({
      basePath: '/otkrytki',
      pageParam: '01',
    });
  });

  it('сегмент page без номера базовым путём не считается: номера нет — списка нет', () => {
    expect(splitPaginatedPath(`/otkrytki/${PAGINATION_SEGMENT}`)).toEqual({
      basePath: `/otkrytki/${PAGINATION_SEGMENT}`,
      pageParam: null,
    });
  });

  it('сегмент page в СЕРЕДИНЕ пути хвостом пагинации не является', () => {
    expect(splitPaginatedPath(`/otkrytki/${PAGINATION_SEGMENT}/2/eshche`)).toEqual({
      basePath: `/otkrytki/${PAGINATION_SEGMENT}/2/eshche`,
      pageParam: null,
    });
  });
});

describe('решение по номеру страницы из адреса', () => {
  it('канонический номер (2 и больше) — это страница', () => {
    expect(decidePageParam('2')).toEqual({ action: 'page', page: 2 });
    expect(decidePageParam('123')).toEqual({ action: 'page', page: 123 });
  });

  it('/page/1 — одиночный 301 на базовый URL, а не существующий адрес', () => {
    const decision = decidePageParam('1');

    expect(decision.action).toBe('redirect-to-base');
  });

  it.each(['0', '01', '007', '-1', '+2', '1.0', '2,5', 'abc', '', ' 2', '2 ', '٢'])(
    'номер «%s» адресом страницы не является — 404, а не 200 с пустой сеткой',
    (raw) => {
      expect(decidePageParam(raw).action).toBe('not-found');
    },
  );

  it('номер за пределом безопасного целого отклоняется, а не переполняется', () => {
    expect(decidePageParam('9007199254740993').action).toBe('not-found');
  });
});

describe('расчёт числа страниц', () => {
  it('ровно на границе страницы лишней не появляется', () => {
    expect(pageCountFor(24, 24)).toBe(1);
    expect(pageCountFor(48, 24)).toBe(2);
    expect(pageCountFor(25, 24)).toBe(2);
  });

  it('пустой список — ноль страниц: страницы 1 у него тоже нет', () => {
    expect(pageCountFor(0, 24)).toBe(0);
  });

  it('некорректный размер страницы — отказ, а не деление на ноль', () => {
    expect(() => pageCountFor(10, 0)).toThrow();
    expect(() => pageCountFor(-1, 24)).toThrow();
  });
});

describe('заголовок и крошка страницы пагинации', () => {
  it('первая страница заголовок не меняет', () => {
    expect(paginationTitle('Открытки на 8 Марта', 1)).toBe('Открытки на 8 Марта');
  });

  it('на страницах 2+ номер входит в заголовок: два одинаковых title — это дубль', () => {
    expect(paginationTitle('Открытки на 8 Марта', 3)).toBe('Открытки на 8 Марта — страница 3');
  });

  it('крошка страницы пагинации называет номер', () => {
    expect(paginationCrumbLabel(2)).toBe('Страница 2');
    expect(() => paginationCrumbLabel(1)).toThrow();
  });
});

describe('модель блока ссылок пагинации', () => {
  it('одна страница — блока нет вовсе: ссылаться некуда', () => {
    expect(paginationModel({ basePath: BASE, page: 1, pageCount: 1 })).toBeNull();
    expect(paginationModel({ basePath: BASE, page: 1, pageCount: 0 })).toBeNull();
  });

  it('на базовом URL нет ссылки «предыдущая» и нет ссылки на /page/1', () => {
    const model = paginationModel({ basePath: BASE, page: 1, pageCount: 3 });

    expect(model).not.toBeNull();
    expect(model?.previousPath).toBeNull();
    expect(model?.nextPath).toBe(`${BASE}/${PAGINATION_SEGMENT}/2`);
    expect(JSON.stringify(model)).not.toContain(`/${PAGINATION_SEGMENT}/1`);
  });

  it('со второй страницы «предыдущая» ведёт на базовый URL, а не на /page/1', () => {
    const model = paginationModel({ basePath: BASE, page: 2, pageCount: 3 });

    expect(model?.previousPath).toBe(BASE);
    expect(model?.nextPath).toBe(`${BASE}/${PAGINATION_SEGMENT}/3`);
  });

  it('на последней странице «следующая» отсутствует: бесконечной ленты нет', () => {
    const model = paginationModel({ basePath: BASE, page: 3, pageCount: 3 });

    expect(model?.nextPath).toBeNull();
  });

  it('первая страница в списке номеров — базовый URL, и такой номер один', () => {
    const model = paginationModel({ basePath: BASE, page: 4, pageCount: 9 });
    const pages = (model?.entries ?? []).filter((entry) => entry.kind === 'page');

    expect(pages.filter((entry) => entry.page === 1)).toHaveLength(1);
    expect(pages.find((entry) => entry.page === 1)?.path).toBe(BASE);
    expect(pages.map((entry) => entry.path)).not.toContain(`${BASE}/${PAGINATION_SEGMENT}/1`);
  });

  it('текущая страница отмечена ровно один раз и ведёт на свой же адрес', () => {
    const model = paginationModel({ basePath: BASE, page: 4, pageCount: 9 });
    const current = (model?.entries ?? []).filter(
      (entry) => entry.kind === 'page' && entry.current,
    );

    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ page: 4, path: `${BASE}/${PAGINATION_SEGMENT}/4` });
  });

  it('номера идут по возрастанию, без повторов, первая и последняя всегда есть', () => {
    const model = paginationModel({ basePath: BASE, page: 5, pageCount: 20 });
    const numbers = (model?.entries ?? [])
      .filter((entry) => entry.kind === 'page')
      .map((entry) => (entry.kind === 'page' ? entry.page : 0));

    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers.at(0)).toBe(1);
    expect(numbers.at(-1)).toBe(20);
    expect(numbers).toContain(5 - PAGINATION_WINDOW);
    expect(numbers).toContain(5 + PAGINATION_WINDOW);
  });

  it('разрыв в списке номеров помечен, а не подразумевается пропуском', () => {
    const model = paginationModel({ basePath: BASE, page: 10, pageCount: 20 });

    expect((model?.entries ?? []).filter((entry) => entry.kind === 'gap')).toHaveLength(2);
  });

  it('короткий список выводится целиком, без разрывов', () => {
    const model = paginationModel({ basePath: BASE, page: 2, pageCount: 4 });
    const numbers = (model?.entries ?? [])
      .filter((entry) => entry.kind === 'page')
      .map((entry) => (entry.kind === 'page' ? entry.page : 0));

    expect(numbers).toEqual([1, 2, 3, 4]);
    expect((model?.entries ?? []).some((entry) => entry.kind === 'gap')).toBe(false);
  });

  it('номер вне диапазона в модель не попадает: такой страницы не существует', () => {
    expect(() => paginationModel({ basePath: BASE, page: 4, pageCount: 3 })).toThrow();
  });
});
