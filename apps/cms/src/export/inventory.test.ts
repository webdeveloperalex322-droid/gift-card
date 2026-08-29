import { describe, expect, it } from 'vitest';

import { CSV_EOL } from './csv';
import {
  INVENTORY_COLUMNS,
  type InventoryRecord,
  MAX_INVENTORY_ROWS,
  type ProbeResponse,
  type SiteProbe,
  UNOBSERVED,
  buildInventoryCsv,
  inventoryPageType,
  inventoryRow,
  inventoryUpdatedAt,
  parseCanonical,
  parseSitemapLocations,
  readSitemapUrls,
} from './inventory';

/** Синтетический хост в фикстуре допустим и нужен: им проверяется сборка URL. */
const env = { SITE_URL: 'https://primer.test' };

const card: InventoryRecord = {
  collection: 'cards',
  path: '/otkrytki/8-marta-mame',
  robots: 'index,follow',
  status: 'published',
  title: 'Открытка маме на 8 Марта',
  updatedAt: '2026-08-20T10:00:00.000Z',
  updatedContentAt: '2026-08-01T09:00:00.000Z',
};

function respond(map: Record<string, ProbeResponse>): SiteProbe {
  return (url: string) => {
    const response = map[url];
    if (response === undefined) {
      return Promise.reject(new Error('ECONNREFUSED'));
    }
    return Promise.resolve(response);
  };
}

describe('состав колонок', () => {
  it('дословно по ТЗ §8.5 и в том же порядке', () => {
    expect([...INVENTORY_COLUMNS]).toEqual([
      'URL',
      'Тип страницы',
      'Статус записи',
      'HTTP-статус',
      'robots',
      'canonical',
      'title',
      'В sitemap',
      'Дата обновления',
    ]);
  });
});

describe('колонки, выводимые из записи', () => {
  it('тип страницы берётся из подписей видов узла, а не из своего словаря', () => {
    expect(inventoryPageType(card)).toBe('Открытка');
    expect(inventoryPageType({ collection: 'collections', nodeKind: 'occasion', path: '/p' })).toBe(
      'Повод: праздничная посадочная',
    );
    expect(inventoryPageType({ collection: 'collections', nodeKind: 'нечто', path: '/p' })).toBe(
      'Подборка (вид узла не задан)',
    );
  });

  it('дата обновления — содержательная, иначе техническая', () => {
    expect(inventoryUpdatedAt(card)).toBe('2026-08-01T09:00:00.000Z');
    expect(inventoryUpdatedAt({ ...card, updatedContentAt: '  ' })).toBe('2026-08-20T10:00:00.000Z');
    expect(inventoryUpdatedAt({ collection: 'cards', path: '/x' })).toBe('');
  });
});

describe('строка выгрузки', () => {
  it('неизмеренные колонки остаются ПУСТЫМИ, а не «нет» и не «200»', () => {
    const row = inventoryRow({ observation: UNOBSERVED, record: card, url: 'https://primer.test/x' });
    expect(row).toEqual([
      'https://primer.test/x',
      'Открытка',
      'published',
      '',
      'index,follow',
      '',
      'Открытка маме на 8 Марта',
      '',
      '2026-08-01T09:00:00.000Z',
    ]);
  });

  it('измеренные колонки показывают факт ответа', () => {
    const row = inventoryRow({
      observation: {
        canonical: 'https://primer.test/otkrytki/8-marta-mame',
        httpStatus: 301,
        inSitemap: false,
      },
      record: card,
      url: 'https://primer.test/otkrytki/8-marta-mame',
    });
    expect(row[3]).toBe('301');
    expect(row[5]).toBe('https://primer.test/otkrytki/8-marta-mame');
    expect(row[7]).toBe('нет');
  });
});

describe('разбор ответов сайта', () => {
  it('адреса карты читаются, а не вычисляются', () => {
    expect(
      parseSitemapLocations(
        '<sitemapindex><sitemap><loc>https://primer.test/sitemap-sections.xml</loc></sitemap>' +
          '<sitemap><loc>\n  https://primer.test/sitemap-cards-1.xml\n</loc></sitemap></sitemapindex>',
      ),
    ).toEqual(['https://primer.test/sitemap-sections.xml', 'https://primer.test/sitemap-cards-1.xml']);
  });

  it('canonical читается при любом порядке атрибутов, иначе null', () => {
    expect(parseCanonical('<link rel="canonical" href="https://primer.test/a">')).toBe(
      'https://primer.test/a',
    );
    expect(parseCanonical("<link href='https://primer.test/b' rel='canonical'/>")).toBe(
      'https://primer.test/b',
    );
    expect(parseCanonical('<link rel="stylesheet" href="/a.css">')).toBeNull();
  });
});

describe('чтение карты сайта', () => {
  it('собирает адреса из всех файлов индекса', async () => {
    const probe = respond({
      'https://primer.test/sitemap-sections.xml': {
        body: '<urlset><url><loc>https://primer.test/podborki/prazdniki/8-marta</loc></url></urlset>',
        status: 200,
      },
      'https://primer.test/sitemap.xml': {
        body:
          '<sitemapindex><sitemap><loc>https://primer.test/sitemap-sections.xml</loc></sitemap>' +
          '</sitemapindex>',
        status: 200,
      },
    });
    const reading = await readSitemapUrls({ origin: 'https://primer.test', probe });
    expect([...(reading.urls ?? [])]).toEqual(['https://primer.test/podborki/prazdniki/8-marta']);
    expect(reading.warnings).toEqual([]);
  });

  it('недоступный файл карты не отменяет уже прочитанные адреса, но назван', async () => {
    const probe = respond({
      'https://primer.test/sitemap-sections.xml': {
        body: '<urlset><url><loc>https://primer.test/podborki</loc></url></urlset>',
        status: 200,
      },
      'https://primer.test/sitemap.xml': {
        body:
          '<sitemapindex><sitemap><loc>https://primer.test/sitemap-sections.xml</loc></sitemap>' +
          '<sitemap><loc>https://primer.test/sitemap-cards-1.xml</loc></sitemap></sitemapindex>',
        status: 200,
      },
    });
    const reading = await readSitemapUrls({ origin: 'https://primer.test', probe });
    expect([...(reading.urls ?? [])]).toEqual(['https://primer.test/podborki']);
    expect(reading.warnings.join(' ')).toContain('sitemap-cards-1.xml');
  });

  it('индекс, ответивший не 200, оставляет набор неизвестным', async () => {
    const reading = await readSitemapUrls({
      origin: 'https://primer.test',
      probe: respond({ 'https://primer.test/sitemap.xml': { body: '', status: 500 } }),
    });
    expect(reading.urls).toBeNull();
    expect(reading.warnings.join(' ')).toContain('500');
  });

  it('недоступный индекс тоже оставляет набор неизвестным, а не пустым', async () => {
    const reading = await readSitemapUrls({ origin: 'https://primer.test', probe: respond({}) });
    expect(reading.urls).toBeNull();
    expect(reading.warnings.join(' ')).toContain('недоступен');
  });

  /**
   * Куда выгрузка ходит — правило КОДА, а не свойство данных.
   *
   * Находка ревизии от 2026-08-29: `<loc>` индекса запрашивались как есть.
   * Сегодня их собирает наш же шаблон из того же `SITE_URL`, поэтому вреда не
   * было; но между обещанием «только origin из SITE_URL» и запросом стоял файл,
   * который отдаёт сайт, а не проверка.
   */
  it('файл карты с ЧУЖОГО origin не запрашивается вовсе и назван в предупреждении', async () => {
    const asked: string[] = [];
    const probe: SiteProbe = (url: string) => {
      asked.push(url);
      if (url === 'https://primer.test/sitemap.xml') {
        return Promise.resolve({
          body:
            '<sitemapindex><sitemap><loc>https://chuzhoy.test/sitemap-cards-1.xml</loc></sitemap>' +
            '<sitemap><loc>https://primer.test/sitemap-sections.xml</loc></sitemap></sitemapindex>',
          status: 200,
        });
      }
      if (url === 'https://primer.test/sitemap-sections.xml') {
        return Promise.resolve({
          body: '<urlset><url><loc>https://primer.test/podborki</loc></url></urlset>',
          status: 200,
        });
      }
      return Promise.reject(new Error('ECONNREFUSED'));
    };

    const reading = await readSitemapUrls({ origin: 'https://primer.test', probe });

    expect(asked).not.toContain('https://chuzhoy.test/sitemap-cards-1.xml');
    expect(reading.warnings.join(' ')).toContain('chuzhoy.test');
    // Свой файл при этом прочитан: отказ точечный, а не «карта не прочитана».
    expect([...(reading.urls ?? [])]).toEqual(['https://primer.test/podborki']);
  });

  it('относительный <loc> разрешается ОТ индекса и остаётся своим', async () => {
    const probe = respond({
      'https://primer.test/sitemap-cards-1.xml': {
        body: '<urlset><url><loc>https://primer.test/otkrytki/roza</loc></url></urlset>',
        status: 200,
      },
      'https://primer.test/sitemap.xml': {
        body: '<sitemapindex><sitemap><loc>/sitemap-cards-1.xml</loc></sitemap></sitemapindex>',
        status: 200,
      },
    });
    const reading = await readSitemapUrls({ origin: 'https://primer.test', probe });
    expect([...(reading.urls ?? [])]).toEqual(['https://primer.test/otkrytki/roza']);
  });

  it('хвостовой слеш у origin не превращает адрес индекса в двойной', async () => {
    const probe = respond({
      'https://primer.test/sitemap.xml': { body: '<sitemapindex></sitemapindex>', status: 200 },
    });
    const reading = await readSitemapUrls({ origin: 'https://primer.test/', probe });
    expect(reading.indexStatus).toBe(200);
    expect(reading.urls).toEqual(new Set());
  });
});

describe('сборка файла', () => {
  const sitemapIndex: ProbeResponse = {
    body: '<sitemapindex><sitemap><loc>https://primer.test/sitemap-cards-1.xml</loc></sitemap></sitemapindex>',
    status: 200,
  };
  const cardsSitemap: ProbeResponse = {
    body: '<urlset><url><loc>https://primer.test/otkrytki/8-marta-mame</loc></url></urlset>',
    status: 200,
  };

  it('колонки ответа заполняются измерением, включая наличие в карте', async () => {
    const probe = respond({
      'https://primer.test/otkrytki/8-marta-mame': {
        body: '<html><head><link rel="canonical" href="https://primer.test/otkrytki/8-marta-mame"></head></html>',
        status: 200,
      },
      'https://primer.test/otkrytki/chernovik': { body: 'Не найдено', status: 404 },
      'https://primer.test/sitemap-cards-1.xml': cardsSitemap,
      'https://primer.test/sitemap.xml': sitemapIndex,
    });
    const result = await buildInventoryCsv({
      env,
      probe,
      records: [card, { ...card, path: '/otkrytki/chernovik', status: 'draft', title: 'Черновик' }],
    });
    const lines = result.csv.split(CSV_EOL);
    expect(lines[1]).toContain('200');
    expect(lines[1]).toContain('да');
    expect(lines[2]).toContain('404');
    expect(lines[2]).toContain('нет');
    expect(result.rows).toBe(2);
  });

  /**
   * Главное свойство честности колонки: недоступный сайт даёт пустые ячейки и
   * предупреждение, а не правдоподобную догадку.
   */
  it('недоступный сайт: ячейки ответа пусты, предупреждение названо', async () => {
    const result = await buildInventoryCsv({ env, probe: respond({}), records: [card] });
    // Строка сверяется целиком: проверка по номеру ячейки после `split(',')`
    // ложна — `index,follow` обрамлено кавычками и содержит запятую внутри.
    expect(result.csv.split(CSV_EOL)[1]).toBe(
      'https://primer.test/otkrytki/8-marta-mame,Открытка,published,,"index,follow",,' +
        'Открытка маме на 8 Марта,,2026-08-01T09:00:00.000Z',
    );
    expect(result.warnings.join(' ')).toContain('карта сайта не прочитана');
  });

  it('режим без опроса предупреждает о пустых колонках первым делом', async () => {
    const result = await buildInventoryCsv({ env, probe: null, records: [card] });
    expect(result.warnings[0]).toContain('Сайт не опрашивался');
    expect(result.rows).toBe(1);
  });

  it('опрос, запрещённый ролью, объясняется отдельно от «не просили»', async () => {
    // Пустые ячейки в обоих случаях одинаковые, а причины разные — и читателю
    // отчёта нужна именно причина: одна означает «спросите с probe=1», другая —
    // «этой роли опрос недоступен».
    const forbidden = await buildInventoryCsv({
      env,
      probe: null,
      probeAbsence: 'forbidden',
      records: [card],
    });
    expect(forbidden.warnings[0]).toContain('только роли admin');
    expect(forbidden.warnings[0]).not.toBe(
      (await buildInventoryCsv({ env, probe: null, records: [card] })).warnings[0],
    );
    // Строки при этом на месте: закрыт опрос, а не отчёт.
    expect(forbidden.rows).toBe(1);
    expect(forbidden.csv.split(CSV_EOL)[1]).toContain('https://primer.test/otkrytki/8-marta-mame');
  });

  it('запись без собранного пути в файл не попадает и названа в предупреждении', async () => {
    const result = await buildInventoryCsv({
      env,
      probe: null,
      records: [{ collection: 'collections', path: null, title: 'Без пути' }],
    });
    expect(result.rows).toBe(0);
    expect(result.warnings.join(' ')).toContain('Без пути');
  });

  it('превышение предела обрезает строки и не молчит об этом', async () => {
    const many = Array.from({ length: MAX_INVENTORY_ROWS + 2 }, (_, index) => ({
      ...card,
      path: `/otkrytki/kartochka-${String(index)}`,
    }));
    const result = await buildInventoryCsv({ env, probe: null, records: many });
    expect(result.rows).toBe(MAX_INVENTORY_ROWS);
    expect(result.warnings.join(' ')).toContain('предел выгрузки');
  });
});
