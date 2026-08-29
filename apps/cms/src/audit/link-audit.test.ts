/**
 * Проверка внутренних ссылок (Э5-03, ТЗ §8.3.4).
 *
 * Сайт здесь СИНТЕТИЧЕСКИЙ: опрос подменяется картой «адрес → ответ». Эталонной
 * выборки страниц у проекта пока нет (Э3-13 отложена человеком, опубликованных
 * записей ноль), и делать вид, что обход проверен на настоящем каталоге, нельзя.
 * Что доказывают эти тесты: правила разбора и классификации верны на каждом
 * классе ответа, включая те, которые на живом сайте встречаются редко и потому
 * ломаются незаметно, — 301 внутрь сайта, ссылка на файл, оборванный обход.
 */
import { describe, expect, it } from 'vitest';

import type { ProbeResponse, SiteProbe } from '../export/inventory';
import {
  type AuditedRecord,
  LINK_AUDIT_MAX_CLICKS,
  classifyLinkAudit,
  crawlSite,
  extractHrefs,
  orphanCount,
  resolveInternalTarget,
} from './link-audit';

const ORIGIN = 'http://otkritka.test';

/** Страница синтетического сайта: ответ 200 со ссылками. */
function page(...hrefs: string[]): ProbeResponse {
  const links = hrefs.map((href) => `<a href="${href}">ссылка</a>`).join('\n');
  return { body: `<html><body><h1>Заголовок</h1>${links}</body></html>`, status: 200 };
}

function siteProbe(
  site: Readonly<Record<string, ProbeResponse>>,
): { calls: string[]; probe: SiteProbe } {
  const calls: string[] = [];
  const probe: SiteProbe = (url) => {
    calls.push(url);
    const answer = site[url];
    return Promise.resolve(answer ?? { body: 'не найдено', status: 404 });
  };
  return { calls, probe };
}

describe('разбор ссылок в HTML', () => {
  it('находит href в любой форме записи атрибута', () => {
    const html = `<a href="/a">1</a><a href='/b'>2</a><a class="x" href=/c >3</a>`;
    expect(extractHrefs(html)).toEqual(['/a', '/b', '/c']);
  });

  it('не считает ссылкой то, что ссылкой не является', () => {
    const html = '<link href="/style.css"><area href="/z"><span data-href="/y"></span>';
    expect(extractHrefs(html)).toEqual([]);
  });
});

describe('какой адрес принадлежит обходу', () => {
  const from = `${ORIGIN}/podborki/prazdniki/8-marta`;

  it('относительный и абсолютный адреса своего хоста приводятся к одной форме', () => {
    expect(resolveInternalTarget('/otkrytki/roza', from, ORIGIN)).toBe(`${ORIGIN}/otkrytki/roza`);
    // Относительная ссылка разрешается по правилам URL, а не по вкусу: при
    // канонической форме БЕЗ завершающего слеша (Ч-21) `mame` со страницы
    // `/podborki/prazdniki/8-marta` — это СОСЕД, а не потомок. Обход обязан
    // видеть тот же адрес, что браузер и краулер, иначе он проверял бы
    // выдуманную ссылку.
    expect(resolveInternalTarget('mame', from, ORIGIN)).toBe(`${ORIGIN}/podborki/prazdniki/mame`);
    expect(resolveInternalTarget(`${ORIGIN}/otkrytki/roza`, from, ORIGIN)).toBe(
      `${ORIGIN}/otkrytki/roza`,
    );
  });

  it('чужой хост и не-HTTP схемы в обход не берутся', () => {
    expect(resolveInternalTarget('https://yandex.ru/', from, ORIGIN)).toBeNull();
    expect(resolveInternalTarget('mailto:a@b.ru', from, ORIGIN)).toBeNull();
    expect(resolveInternalTarget('tel:+70000000000', from, ORIGIN)).toBeNull();
    expect(resolveInternalTarget('javascript:void(0)', from, ORIGIN)).toBeNull();
  });

  it('якорь адресом не является, а строка запроса — является', () => {
    expect(resolveInternalTarget('#dalshe', from, ORIGIN)).toBeNull();
    expect(resolveInternalTarget('/otkrytki/roza#blok', from, ORIGIN)).toBe(
      `${ORIGIN}/otkrytki/roza`,
    );
    expect(resolveInternalTarget('/poisk?q=roza', from, ORIGIN)).toBe(`${ORIGIN}/poisk?q=roza`);
  });
});

describe('обход от главной', () => {
  it('считает МИНИМАЛЬНОЕ число переходов, а не первое найденное', async () => {
    const site = {
      [`${ORIGIN}/`]: page('/a', '/b'),
      [`${ORIGIN}/a`]: page('/c'),
      [`${ORIGIN}/b`]: page('/c'),
      [`${ORIGIN}/c`]: page('/'),
    };
    const { probe } = siteProbe(site);
    const crawl = await crawlSite({ origin: ORIGIN, probe });

    expect(crawl.targets.get(`${ORIGIN}/c`)?.depth).toBe(2);
    expect(crawl.truncated).toBe(false);
  });

  it('редирект не тратит переход и не обрывает ветку', async () => {
    const site = {
      [`${ORIGIN}/`]: page('/staryy'),
      [`${ORIGIN}/staryy`]: { body: '', location: '/novyy', status: 301 },
      [`${ORIGIN}/novyy`]: page('/glubzhe'),
      [`${ORIGIN}/glubzhe`]: page(),
    };
    const { probe } = siteProbe(site);
    const crawl = await crawlSite({ origin: ORIGIN, probe });

    expect(crawl.targets.get(`${ORIGIN}/novyy`)?.depth).toBe(1);
    expect(crawl.targets.get(`${ORIGIN}/glubzhe`)?.depth).toBe(2);
  });

  it('файл спрашивается, но ссылок внутри него не ищут', async () => {
    const site = {
      [`${ORIGIN}/`]: page('/media/otkrytka.webp'),
      [`${ORIGIN}/media/otkrytka.webp`]: page('/nikogda-ne-viden'),
    };
    const { calls, probe } = siteProbe(site);
    const crawl = await crawlSite({ origin: ORIGIN, probe });

    expect(calls).toContain(`${ORIGIN}/media/otkrytka.webp`);
    expect(crawl.targets.has(`${ORIGIN}/nikogda-ne-viden`)).toBe(false);
  });

  it('каждый адрес спрашивается один раз, каким бы числом ссылок он ни был назван', async () => {
    const site = {
      [`${ORIGIN}/`]: page('/a', '/a', '/a'),
      [`${ORIGIN}/a`]: page('/'),
    };
    const { calls, probe } = siteProbe(site);
    await crawlSite({ origin: ORIGIN, probe });

    expect(calls.filter((url) => url === `${ORIGIN}/a`)).toHaveLength(1);
  });

  it('предел запросов обрывает обход и помечает его усечённым', async () => {
    const site: Record<string, ProbeResponse> = { [`${ORIGIN}/`]: page('/a', '/b', '/c') };
    for (const slug of ['a', 'b', 'c']) {
      site[`${ORIGIN}/${slug}`] = page();
    }
    const { probe } = siteProbe(site);
    const crawl = await crawlSite({ maxRequests: 2, origin: ORIGIN, probe });

    expect(crawl.truncated).toBe(true);
    expect(crawl.requested).toBeLessThanOrEqual(2);
  });

  it('чужой хост не спрашивается вовсе', async () => {
    const { calls, probe } = siteProbe({ [`${ORIGIN}/`]: page('https://example.com/x') });
    await crawlSite({ origin: ORIGIN, probe });

    expect(calls).toEqual([`${ORIGIN}/`]);
  });

  it('упавший запрос становится предупреждением, а не тишиной', async () => {
    const probe: SiteProbe = (url) =>
      url === `${ORIGIN}/` ? Promise.resolve(page('/a')) : Promise.reject(new Error('ECONNREFUSED'));
    const crawl = await crawlSite({ origin: ORIGIN, probe });

    expect(crawl.targets.get(`${ORIGIN}/a`)?.failure).toBe('ECONNREFUSED');
    expect(crawl.warnings.join(' ')).toContain('ECONNREFUSED');
  });
});

describe('разбор находок', () => {
  const record = (path: string): AuditedRecord => ({
    collection: 'cards',
    id: path,
    title: `Запись ${path}`,
    url: `${ORIGIN}${path}`,
  });

  async function crawl(site: Readonly<Record<string, ProbeResponse>>, maxRequests?: number) {
    const { probe } = siteProbe(site);
    return crawlSite({
      origin: ORIGIN,
      probe,
      ...(maxRequests === undefined ? {} : { maxRequests }),
    });
  }

  it('ссылка на 404 названа битой и показывает страницу-источник', async () => {
    const result = await crawl({ [`${ORIGIN}/`]: page('/net-takoy') });
    const findings = classifyLinkAudit({ crawl: result, records: [], sitemapUrls: null });

    expect(findings.brokenTotal).toBe(1);
    expect(findings.broken[0]?.url).toBe(`${ORIGIN}/net-takoy`);
    expect(findings.broken[0]?.referrers).toEqual([`${ORIGIN}/`]);
  });

  it('ссылка на 301 битой не считается и лежит отдельным списком', async () => {
    const result = await crawl({
      [`${ORIGIN}/`]: page('/staryy'),
      [`${ORIGIN}/staryy`]: { body: '', location: '/novyy', status: 301 },
      [`${ORIGIN}/novyy`]: page(),
    });
    const findings = classifyLinkAudit({ crawl: result, records: [], sitemapUrls: null });

    expect(findings.brokenTotal).toBe(0);
    expect(findings.redirectedTotal).toBe(1);
    expect(findings.redirected[0]?.location).toBe('/novyy');
  });

  it('запись, на которую нет ни одной ссылки, названа именно так', async () => {
    const result = await crawl({ [`${ORIGIN}/`]: page('/est-ssylka'), [`${ORIGIN}/est-ssylka`]: page() });
    const findings = classifyLinkAudit({
      crawl: result,
      records: [record('/est-ssylka'), record('/sirota')],
      sitemapUrls: null,
    });

    expect(findings.recordsTotal).toBe(1);
    expect(findings.records[0]?.url).toBe(`${ORIGIN}/sirota`);
    expect(findings.records[0]?.reason).toBe('not-linked');
    expect(orphanCount(findings)).toBe(1);
  });

  it('путь длиннее нормы назван «слишком глубоко», а ровно по норме — не находка', async () => {
    const chain: Record<string, ProbeResponse> = { [`${ORIGIN}/`]: page('/s1') };
    for (let step = 1; step <= LINK_AUDIT_MAX_CLICKS + 1; step += 1) {
      chain[`${ORIGIN}/s${String(step)}`] = page(`/s${String(step + 1)}`);
    }
    chain[`${ORIGIN}/s${String(LINK_AUDIT_MAX_CLICKS + 2)}`] = page();

    const result = await crawl(chain);
    const findings = classifyLinkAudit({
      crawl: result,
      records: [record(`/s${String(LINK_AUDIT_MAX_CLICKS)}`), record(`/s${String(LINK_AUDIT_MAX_CLICKS + 1)}`)],
      sitemapUrls: null,
    });

    expect(findings.records).toHaveLength(1);
    expect(findings.records[0]?.url).toBe(`${ORIGIN}/s${String(LINK_AUDIT_MAX_CLICKS + 1)}`);
    expect(findings.records[0]?.reason).toBe('too-deep');
    expect(findings.records[0]?.depth).toBe(LINK_AUDIT_MAX_CLICKS + 1);
  });

  it('опубликованная запись, отдающая 404, — не сирота, и причина названа своя', async () => {
    const result = await crawl({ [`${ORIGIN}/`]: page('/udalennaya') });
    const findings = classifyLinkAudit({
      crawl: result,
      records: [record('/udalennaya')],
      sitemapUrls: null,
    });

    expect(findings.records[0]?.reason).toBe('not-200');
    expect(findings.records[0]?.status).toBe(404);
    expect(orphanCount(findings)).toBe(0);
  });

  it('усечённый обход объявляет находки о достижимости ненадёжными', async () => {
    const result = await crawl({ [`${ORIGIN}/`]: page('/a', '/b') }, 1);
    const findings = classifyLinkAudit({
      crawl: result,
      records: [record('/a')],
      sitemapUrls: null,
    });

    expect(findings.reliable).toBe(false);
    expect(findings.warnings.join(' ')).toContain('ненадёжны');
  });

  it('не ответившая главная — не повод объявить весь каталог сиротами', async () => {
    const result = await crawl({ [`${ORIGIN}/`]: { body: '', status: 503 } });
    const findings = classifyLinkAudit({
      crawl: result,
      records: [record('/kartochka')],
      sitemapUrls: null,
    });

    expect(findings.reliable).toBe(false);
    expect(findings.warnings.join(' ')).toContain('обход не состоялся');
  });

  it('наличие в карте сайта — наблюдение, а не догадка', async () => {
    const result = await crawl({ [`${ORIGIN}/`]: page() });
    const withMap = classifyLinkAudit({
      crawl: result,
      records: [record('/sirota')],
      sitemapUrls: new Set([`${ORIGIN}/sirota`]),
    });
    const withoutMap = classifyLinkAudit({
      crawl: result,
      records: [record('/sirota')],
      sitemapUrls: null,
    });

    expect(withMap.records[0]?.inSitemap).toBe(true);
    // Карта не прочитана — не «нет в карте», а «неизвестно».
    expect(withoutMap.records[0]?.inSitemap).toBeNull();
  });
});
