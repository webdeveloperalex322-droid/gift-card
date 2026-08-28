/**
 * Карта сайта: три условия включения, разбиение на файлы и форма XML
 * (задача Э4-04).
 *
 * Норма: ТЗ §7.3, `CLAUDE.md` — раздел «Sitemap и robots» («включаются только
 * абсолютные канонические URL со статусом 200 и разрешением на индексацию;
 * редиректы, 404, noindex, параметры — исключаются. Это проверяется тестом, а не
 * соглашением»; «`lastmod` меняется только при содержательном обновлении»),
 * решения Ч-01b/Ч-05 (страницы 2+ — `noindex,follow` и вне карты), Ч-21 (форма
 * пути без завершающего слеша), Ч-23 (служебные страницы).
 *
 * Три условия проверяются ПО ОТДЕЛЬНОСТИ и каждое своим источником:
 *
 *   1. разрешение на индексацию — директива, посчитанная единственным
 *      разрешателем (`resolvePageRobots`, задача Э4-01);
 *   2. каноничность адреса — сравнение canonical записи с адресом страницы;
 *   3. ответ 200 — ФАКТ, переданный снаружи: его знает только маршрут, и
 *      догадываться о нём карта сайта не имеет права.
 *
 * Отдельного списка исключений (пагинация, поиск, фильтры) здесь нет и быть не
 * должно: у всех этих страниц директива уже закрыта, и второй список разошёлся
 * бы с первым.
 */
import { describe, expect, it } from 'vitest';

import { resolvePageRobots } from '../../apps/web/src/seo/robots-directive.js';
import {
  decideSitemapUrl,
  MAX_URLS_PER_SITEMAP,
  parseShardParam,
  renderImageUrlset,
  renderSitemapIndex,
  renderUrlset,
  selectSitemapUrls,
  shardFilePath,
  SITEMAP_CARDS_PREFIX,
  SITEMAP_IMAGES_PREFIX,
  SITEMAP_INDEX_PATH,
  SITEMAP_SECTIONS_PATH,
  shardUrls,
  type SitemapPageFacts,
} from '../../apps/web/src/seo/sitemap.js';

const ENV = { SITE_URL: 'https://primer.test' } as const;

/** Директива открытой страницы. Собрать её можно только разрешателем (Э4-01). */
const OPEN = resolvePageRobots({
  declared: 'index,follow',
  description: 'Непустое описание, написанное редактором.',
}).robots;

/** Директива страницы пагинации: закрыта самим фактом номера 2 (решение Ч-01b). */
const PAGE_TWO = resolvePageRobots({
  declared: 'index,follow',
  description: 'Непустое описание, написанное редактором.',
  listPage: 2,
}).robots;

function page(overrides: Partial<SitemapPageFacts> = {}): SitemapPageFacts {
  return {
    canonicalPath: '/otkrytki/8-marta-tyulpany',
    pagePath: '/otkrytki/8-marta-tyulpany',
    respondsOk: true,
    robots: OPEN,
    ...overrides,
  };
}

describe('условие 1: разрешение на индексацию', () => {
  it('страница с index,follow входит в карту', () => {
    const decision = decideSitemapUrl(page(), ENV);

    expect(decision.included).toBe(true);
    expect(decision.included ? decision.url.loc : null).toBe(
      'https://primer.test/otkrytki/8-marta-tyulpany',
    );
  });

  it('noindex не входит — и причина названа', () => {
    const closed = resolvePageRobots({ declared: 'noindex,follow', description: 'Есть.' }).robots;
    const decision = decideSitemapUrl(page({ robots: closed }), ENV);

    expect(decision.included).toBe(false);
    expect(decision.included ? [] : decision.excludedBy).toContain('noindex');
  });

  it('страница пагинации исключается САМА, без отдельного списка исключений', () => {
    // Директива страницы 2+ закрыта разрешателем (решение Ч-01b), поэтому карте
    // сайта не нужно знать про `/page/N` вовсе.
    const decision = decideSitemapUrl(
      page({ canonicalPath: '/podborki/prazdniki/8-marta/page/2', pagePath: '/podborki/prazdniki/8-marta/page/2', robots: PAGE_TWO }),
      ENV,
    );

    expect(decision.included).toBe(false);
    expect(decision.included ? [] : decision.excludedBy).toEqual(['noindex']);
  });
});

describe('условие 2: адрес канонический', () => {
  it('страница с чужим canonical не входит, хотя остаётся index,follow', () => {
    // Переопределение canonical — законное решение администратора: страница
    // отвечает 200 и открыта, но склеена с другим адресом. В карте ей не место, и
    // по директиве это не видно.
    const decision = decideSitemapUrl(
      page({ canonicalPath: '/podborki/prazdniki/8-marta' }),
      ENV,
    );

    expect(decision.included).toBe(false);
    expect(decision.included ? [] : decision.excludedBy).toEqual(['not-self-canonical']);
  });

  it('хвостовой слеш в записи не делает страницу неканонической (решение Ч-21)', () => {
    const decision = decideSitemapUrl(
      page({ canonicalPath: '/otkrytki/8-marta-tyulpany/' }),
      ENV,
    );

    expect(decision.included).toBe(true);
  });

  it('адрес с параметрами не входит и в loc не превращается', () => {
    const decision = decideSitemapUrl(
      page({ canonicalPath: '/otkrytki?utm_source=vk', pagePath: '/otkrytki?utm_source=vk' }),
      ENV,
    );

    expect(decision.included).toBe(false);
    expect(decision.included ? [] : decision.excludedBy).toContain('not-a-path');
  });

  it('абсолютный адрес в поле canonical не входит: чужой хост в карту не попадает', () => {
    const decision = decideSitemapUrl(
      page({ canonicalPath: 'https://chuzhoy.test/otkrytki/8-marta-tyulpany' }),
      ENV,
    );

    expect(decision.included).toBe(false);
    expect(decision.included ? [] : decision.excludedBy).toContain('not-a-path');
  });
});

describe('условие 3: ответ 200 — факт снаружи, а не догадка', () => {
  it('страница, которая не отвечает 200, не входит', () => {
    const decision = decideSitemapUrl(page({ respondsOk: false }), ENV);

    expect(decision.included).toBe(false);
    expect(decision.included ? [] : decision.excludedBy).toEqual(['not-200']);
  });

  it('перечисляются ВСЕ причины сразу, а не первая', () => {
    const closed = resolvePageRobots({ declared: 'noindex,follow', description: 'Есть.' }).robots;
    const decision = decideSitemapUrl(
      page({ canonicalPath: '/drugoy-adres', respondsOk: false, robots: closed }),
      ENV,
    );

    expect(decision.included ? [] : decision.excludedBy).toEqual([
      'noindex',
      'not-self-canonical',
      'not-200',
    ]);
  });
});

describe('lastmod', () => {
  it('берётся из даты содержательного обновления', () => {
    const decision = decideSitemapUrl(page({ lastmod: '2026-03-08T09:30:00.000Z' }), ENV);

    expect(decision.included ? decision.url.lastmod : null).toBe('2026-03-08T09:30:00.000Z');
  });

  it('пустая дата означает отсутствие lastmod, а не сегодняшний день', () => {
    // Подстановка «сейчас» превратила бы lastmod в дату выдачи файла: поисковику
    // сообщалось бы об обновлении, которого не было.
    expect(decideSitemapUrl(page({ lastmod: null }), ENV).included).toBe(true);
    expect(renderUrlset(selectSitemapUrls([page({ lastmod: null })], ENV).urls)).not.toContain(
      '<lastmod>',
    );
  });

  it('непонятная дата — отказ, а не тихий пропуск значения', () => {
    expect(() => decideSitemapUrl(page({ lastmod: 'позавчера' }), ENV)).toThrow(/lastmod/u);
  });
});

describe('отбор набора и диагностика', () => {
  it('считает рассмотренные, включённые и причины исключения', () => {
    const closed = resolvePageRobots({ declared: 'noindex,follow', description: 'Есть.' }).robots;
    const selection = selectSitemapUrls(
      [
        page(),
        page({ pagePath: '/otkrytki/vtoraya', canonicalPath: '/otkrytki/vtoraya', robots: closed }),
        page({ pagePath: '/otkrytki/tretya', canonicalPath: '/otkrytki/tretya', respondsOk: false }),
      ],
      ENV,
    );

    expect(selection.urls).toHaveLength(1);
    expect(selection.diagnostics.considered).toBe(3);
    expect(selection.diagnostics.included).toBe(1);
    expect(selection.diagnostics.excludedBy.noindex).toBe(1);
    expect(selection.diagnostics.excludedBy['not-200']).toBe(1);
  });

  it('пустой вход отличим от «всё отфильтровано» по одной и той же диагностике', () => {
    const empty = selectSitemapUrls([], ENV);

    expect(empty.diagnostics.considered).toBe(0);
    expect(empty.diagnostics.included).toBe(0);
  });
});

describe('разбиение на файлы', () => {
  it('предел — 50 000 URL на файл', () => {
    expect(MAX_URLS_PER_SITEMAP).toBe(50_000);
  });

  it('набор ровно в предел остаётся одним файлом', () => {
    const urls = Array.from({ length: MAX_URLS_PER_SITEMAP }, (_value, index) => ({
      images: [],
      lastmod: null,
      loc: `https://primer.test/otkrytki/kartochka-${String(index)}`,
    }));

    expect(shardUrls(urls)).toHaveLength(1);
  });

  it('превышение предела режется на файлы, и ни один URL не теряется и не дублируется', () => {
    const total = MAX_URLS_PER_SITEMAP + 3;
    const urls = Array.from({ length: total }, (_value, index) => ({
      images: [],
      lastmod: null,
      loc: `https://primer.test/otkrytki/kartochka-${String(index)}`,
    }));
    const shards = shardUrls(urls);

    expect(shards).toHaveLength(2);
    expect(shards[0]).toHaveLength(MAX_URLS_PER_SITEMAP);
    expect(shards[1]).toHaveLength(3);
    expect(new Set(shards.flat().map((url) => url.loc)).size).toBe(total);
  });

  it('пустой набор не даёт ни одного файла: пустая карта сайта не выкладывается', () => {
    expect(shardUrls([])).toEqual([]);
  });

  it('имена файлов нумеруются с единицы', () => {
    expect(shardFilePath(SITEMAP_CARDS_PREFIX, 1)).toBe('/sitemap-cards-1.xml');
    expect(shardFilePath(SITEMAP_IMAGES_PREFIX, 12)).toBe('/sitemap-images-12.xml');
  });

  it('номер файла разбирается строго: ведущий ноль, дробь и мусор — не номер', () => {
    expect(parseShardParam('1')).toBe(1);
    expect(parseShardParam('42')).toBe(42);
    for (const raw of ['0', '01', '-1', '1.0', 'odin', '', undefined]) {
      expect(parseShardParam(raw)).toBeNull();
    }
  });
});

describe('форма XML', () => {
  const urls = [
    { images: [], lastmod: '2026-03-08T09:30:00.000Z', loc: 'https://primer.test/otkrytki/a' },
    { images: [], lastmod: null, loc: 'https://primer.test/otkrytki/b' },
  ];

  it('urlset: объявление, пространство имён и по одному <url> на адрес', () => {
    const xml = renderUrlset(urls);

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect([...xml.matchAll(/<url>/gu)]).toHaveLength(2);
    expect(xml).toContain('<loc>https://primer.test/otkrytki/a</loc>');
    expect(xml).toContain('<lastmod>2026-03-08T09:30:00.000Z</lastmod>');
    expect(xml.trimEnd().endsWith('</urlset>')).toBe(true);
  });

  it('image sitemap: своё пространство имён и <image:loc> внутри <url>', () => {
    const xml = renderImageUrlset([
      {
        images: [{ loc: 'https://primer.test/media/cards/r1/otkrytka-1280.jpg' }],
        lastmod: null,
        loc: 'https://primer.test/otkrytki/a',
      },
    ]);

    expect(xml).toContain('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
    expect(xml).toContain('<image:image>');
    expect(xml).toContain(
      '<image:loc>https://primer.test/media/cards/r1/otkrytka-1280.jpg</image:loc>',
    );
  });

  it('image sitemap отказывается описывать адрес без изображений', () => {
    expect(() => renderImageUrlset(urls)).toThrow(/image/iu);
  });

  it('индекс перечисляет файлы и берёт lastmod самого свежего из них', () => {
    const xml = renderSitemapIndex([
      { lastmod: '2026-03-08T09:30:00.000Z', loc: `https://primer.test${SITEMAP_SECTIONS_PATH}` },
      { lastmod: null, loc: 'https://primer.test/sitemap-cards-1.xml' },
    ]);

    expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect([...xml.matchAll(/<sitemap>/gu)]).toHaveLength(2);
    expect(xml).toContain(`<loc>https://primer.test${SITEMAP_SECTIONS_PATH}</loc>`);
    expect(xml).toContain('<lastmod>2026-03-08T09:30:00.000Z</lastmod>');
  });

  it('спецсимволы экранируются: XML остаётся разбираемым', () => {
    const xml = renderUrlset([
      { images: [], lastmod: null, loc: 'https://primer.test/otkrytki/a&b' },
    ]);

    expect(xml).toContain('<loc>https://primer.test/otkrytki/a&amp;b</loc>');
  });

  it('адрес индекса — тот же, на который ссылается robots.txt', () => {
    expect(SITEMAP_INDEX_PATH).toBe('/sitemap.xml');
  });
});
