/**
 * Единственный источник robots-директивы страницы (задача Э4-01).
 *
 * Норма: ТЗ §7.1 и §7.2, `CLAUDE.md` — «Правила индексации» (всегда `noindex`:
 * внутренний поиск, фильтры и сортировка, черновики, пагинация; `index,follow`
 * только по решению человека и только при выполнении условий п. 5.1), п. 22.1
 * (уникальные title/H1/description на выборке), п. 23.4 (шаблонных SEO-текстов
 * не сочиняем), решения Ч-01b/Ч-05 (страницы 2+ — `noindex,follow` и вне
 * sitemap), Ч-04-3 (фильтр отдельных URL не создаёт).
 *
 * Зачем этот тест существует. До Э4-01 итоговая директива складывалась в
 * шаблонах из трёх независимых слоёв (`robotsForPage`, `robotsForFilteredView`,
 * поле записи), и совпадали они по дисциплине автора шаблона, а не по
 * построению: каталог считал её одной формулой, подборка — другой, карточка не
 * считала вовсе. Sitemap на Э4-04 отбирает страницы ПО ЭТОЙ директиве, поэтому
 * вторая трактовка означала бы страницу, закрытую в разметке и открытую в карте
 * сайта (или наоборот). Здесь проверяется, что трактовка одна и что она умеет
 * только ЗАКРЫВАТЬ.
 */
import { describe, expect, it } from 'vitest';

import { parseViewParams } from '../../apps/web/src/routing/view-params.js';
import {
  isIndexableDirective,
  resolvePageRobots,
  ROBOTS_DIRECTIVES,
  sitemapEligibility,
} from '../../apps/web/src/seo/robots-directive.js';

/** Страница, у которой нет ни одной причины закрываться. */
const OPEN = {
  declared: 'index,follow',
  description: 'Непустое описание страницы, написанное редактором.',
} as const;

const FILTERED = parseViewParams('?format=vertical');

describe('объявленная директива — потолок, а не подсказка', () => {
  it('при отсутствии закрывающих причин директива записи доходит до тега без изменений', () => {
    const resolved = resolvePageRobots(OPEN);

    expect(resolved.robots).toBe('index,follow');
    expect(resolved.indexable).toBe(true);
    expect(resolved.closedBy).toEqual([]);
  });

  it('директива никогда не становится ОТКРЫТЕЕ объявленной', () => {
    for (const declared of ROBOTS_DIRECTIVES) {
      const resolved = resolvePageRobots({ ...OPEN, declared });

      // Ни один слой не имеет права открыть страницу: решение об index,follow
      // принимает человек (п. 7.1 и п. 23 ТЗ).
      expect(resolved.robots).toBe(declared);
    }
  });

  it('«noindex,nofollow» не превращается в «noindex,follow» ни по одной причине', () => {
    const resolved = resolvePageRobots({
      declared: 'noindex,nofollow',
      description: null,
      listPage: 7,
      view: FILTERED,
    });

    expect(resolved.robots).toBe('noindex,nofollow');
  });

  it('неизвестное значение директивы — отказ, а не догадка', () => {
    // Значение приходит из поля записи, то есть из базы: молча подставленный
    // «безопасный» дефолт скрыл бы, что решение человека не применилось.
    expect(() =>
      resolvePageRobots({
        declared: 'index, follow' as unknown as (typeof ROBOTS_DIRECTIVES)[number],
        description: 'есть',
      }),
    ).toThrow(/index, follow/);
  });
});

describe('что закрывает страницу от индексации', () => {
  it('страница пагинации 2+ (решение Ч-01b)', () => {
    const resolved = resolvePageRobots({ ...OPEN, listPage: 2 });

    expect(resolved.robots).toBe('noindex,follow');
    expect(resolved.closedBy).toContain('pagination');
  });

  it('первая страница списка не закрывается: /page/1 не существует (Ч-05)', () => {
    expect(resolvePageRobots({ ...OPEN, listPage: 1 }).closedBy).toEqual([]);
  });

  it('активный фильтр представления (ТЗ §5.2, §5.5)', () => {
    const resolved = resolvePageRobots({ ...OPEN, view: FILTERED });

    expect(resolved.robots).toBe('noindex,follow');
    expect(resolved.closedBy).toContain('filter');
  });

  it('чужой параметр фильтром не является и страницу не закрывает', () => {
    // utm-метка и хвост из внешней ссылки оставляют страницу той же самой:
    // директива у адреса, который склеивается с каноническим, бьёт по самой
    // канонической странице.
    const resolved = resolvePageRobots({ ...OPEN, view: parseViewParams('?utm_source=mail') });

    expect(resolved.robots).toBe('index,follow');
  });

  it('пустое описание: тега description нет, значит и в индекс страница не идёт', () => {
    for (const description of [null, undefined, '', '   ']) {
      const resolved = resolvePageRobots({ ...OPEN, description });

      // Альтернатива — собрать описание по шаблону — прямо запрещена п. 23.4,
      // поэтому закрывается страница, а не выдумывается текст.
      expect(resolved.robots).toBe('noindex,follow');
      expect(resolved.closedBy).toContain('no-description');
    }
  });

  it('статус, отличный от published, закрывает страницу даже при открытой директиве', () => {
    for (const status of ['draft', 'review']) {
      const resolved = resolvePageRobots({ ...OPEN, status });

      expect(resolved.robots).toBe('noindex,follow');
      expect(resolved.closedBy).toContain('unpublished');
    }
  });

  it('отсутствие статуса причиной не является: у маршрута статуса нет вовсе', () => {
    expect(resolvePageRobots({ ...OPEN, status: undefined }).closedBy).toEqual([]);
    expect(resolvePageRobots({ ...OPEN, status: 'published' }).closedBy).toEqual([]);
  });

  it('причины перечисляются все, а не только сработавшая первой', () => {
    const resolved = resolvePageRobots({
      ...OPEN,
      description: null,
      listPage: 3,
      view: FILTERED,
    });

    expect([...resolved.closedBy].sort()).toEqual(['filter', 'no-description', 'pagination']);
  });
});

describe('признак индексируемости', () => {
  it('индексируемой считается ровно «index,follow»', () => {
    expect(isIndexableDirective('index,follow')).toBe(true);
    expect(isIndexableDirective('noindex,follow')).toBe(false);
    expect(isIndexableDirective('noindex,nofollow')).toBe(false);
    // Не «всё, что не noindex»: набор значений закрытый, и такая проверка при
    // появлении нового значения молча пустила бы страницу в индекс.
    expect(isIndexableDirective('all')).toBe(false);
    expect(isIndexableDirective(undefined)).toBe(false);
  });
});

describe('право страницы попасть в sitemap (читает Э4-04)', () => {
  const INDEXABLE = resolvePageRobots(OPEN).robots;
  const CLOSED = resolvePageRobots({ ...OPEN, declared: 'noindex,follow' }).robots;

  it('индексируемая страница с self-canonical входит', () => {
    const decision = sitemapEligibility({
      canonicalPath: '/podborki/prazdniki/8-marta',
      pagePath: '/podborki/prazdniki/8-marta',
      robots: INDEXABLE,
    });

    expect(decision.eligible).toBe(true);
    expect(decision.excludedBy).toEqual([]);
  });

  it('закрытая директива исключает страницу', () => {
    const decision = sitemapEligibility({
      canonicalPath: '/otkrytki/mame',
      pagePath: '/otkrytki/mame',
      robots: CLOSED,
    });

    expect(decision.eligible).toBe(false);
    expect(decision.excludedBy).toContain('noindex');
  });

  it('переопределённый canonical исключает страницу: в sitemap идут только канонические URL', () => {
    const decision = sitemapEligibility({
      canonicalPath: '/podborki/prazdniki/8-marta',
      pagePath: '/podborki/prazdniki/8-marta-tyulpany',
      robots: INDEXABLE,
    });

    expect(decision.eligible).toBe(false);
    expect(decision.excludedBy).toContain('not-self-canonical');
  });

  it('форма пути сравнивается канонически, а не посимвольно', () => {
    // Хвостовой слеш — не второй адрес (решение Ч-21), и сравнение путей не
    // должно объявлять такую страницу неканонической.
    const decision = sitemapEligibility({
      canonicalPath: '/otkrytki/mame/',
      pagePath: '/otkrytki/mame',
      robots: INDEXABLE,
    });

    expect(decision.eligible).toBe(true);
  });
});
