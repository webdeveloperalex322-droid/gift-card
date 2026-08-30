/**
 * Прогон проверки внутренних ссылок (Э5-03): что она спрашивает и, главное, чего
 * НЕ делает.
 *
 * Самый ценный тест здесь — негативный: фоновая задача не меняет ни статусов, ни
 * robots-директив, ни чего-либо ещё в записях. Проверка, которая «чинит»
 * найденное, была бы автоматическим решением о публикации и индексации, а такие
 * решения принимает только человек (п. 7.1 и п. 23). Утверждать это словами в
 * комментарии недостаточно: сюда однажды допишут удобный хук.
 */
import type { Payload } from 'payload';
import { describe, expect, it, vi } from 'vitest';

import type { ProbeResponse, SiteProbe } from '../export/inventory';
import { runLinkAudit } from './run';
import { LINK_AUDIT_SLUG } from './report';

/** Синтетический хост в фикстуре допустим и нужен: им проверяется сборка URL. */
const env = { SITE_URL: 'https://primer.test' };
const ORIGIN = 'https://primer.test';

interface FakeDoc {
  readonly id: number;
  readonly path?: string;
  readonly slug?: string;
  readonly status: string;
  readonly title: string;
}

function page(...hrefs: string[]): ProbeResponse {
  return {
    body: `<html><body>${hrefs.map((href) => `<a href="${href}">x</a>`).join('')}</body></html>`,
    status: 200,
  };
}

/** Payload, у которого записан каждый вызов: остальное — минимум для прогона. */
function fakePayload(docs: { cards: FakeDoc[]; collections: FakeDoc[] }) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const note =
    (name: string) =>
    (args: Record<string, unknown>): Promise<unknown> => {
      calls.push({ args, name });
      return Promise.resolve({});
    };
  const payload = {
    create: note('create'),
    delete: note('delete'),
    find: (args: Record<string, unknown>) => {
      calls.push({ args, name: 'find' });
      const collection = args.collection === 'cards' ? docs.cards : docs.collections;
      return Promise.resolve({ docs: collection });
    },
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    update: note('update'),
    updateGlobal: note('updateGlobal'),
  };
  return { calls, payload: payload as unknown as Payload };
}

const emptyDocs = { cards: [], collections: [] };

describe('прогон проверки внутренних ссылок', () => {
  it('пишет отчёт в глобал и НЕ трогает ни одной записи', async () => {
    const { calls, payload } = fakePayload({
      cards: [{ id: 1, slug: 'roza', status: 'published', title: 'Роза' }],
      collections: [],
    });
    const probe: SiteProbe = (url) =>
      Promise.resolve(url === `${ORIGIN}/` ? page('/otkrytki/roza') : page());

    await runLinkAudit({ env, payload, probe });

    const written = calls.filter((call) => call.name === 'updateGlobal');
    expect(written).toHaveLength(1);
    expect(written[0]?.args.slug).toBe(LINK_AUDIT_SLUG);
    // Ни create, ни update, ни delete — ни при каких находках.
    expect(calls.filter((call) => ['create', 'delete', 'update'].includes(call.name))).toEqual([]);
  });

  it('проверяет на достижимость только опубликованные записи', async () => {
    const { calls, payload } = fakePayload(emptyDocs);
    await runLinkAudit({ env, payload, probe: () => Promise.resolve(page()) });

    const finds = calls.filter((call) => call.name === 'find');
    expect(finds).toHaveLength(2);
    for (const find of finds) {
      expect(find.args.where).toEqual({ status: { equals: 'published' } });
    }
  });

  it('сирота попадает в отчёт с адресом, собранным из SITE_URL', async () => {
    const { calls, payload } = fakePayload({
      cards: [{ id: 7, slug: 'sirota', status: 'published', title: 'Сирота' }],
      collections: [],
    });
    await runLinkAudit({ env, payload, probe: () => Promise.resolve(page()) });

    const data = calls.find((call) => call.name === 'updateGlobal')?.args.data as {
      counts: { orphans: number; publishedRecords: number };
      records: { reason: string; url: string }[];
    };
    expect(data.counts.publishedRecords).toBe(1);
    expect(data.counts.orphans).toBe(1);
    expect(data.records[0]?.url).toBe(`${ORIGIN}/otkrytki/sirota`);
    expect(data.records[0]?.reason).toBe('not-linked');
  });

  it('карта сайта попадает в отчёт НАБЛЮДЕНИЕМ, а не датой генерации', async () => {
    // Отдельной «генерации» карты не существует: она собирается на запросе
    // (расхождение с нормой заведено вопросом Э4-04-A). Поэтому в отчёте стоит
    // то, что измерено: чем ответил /sitemap.xml и сколько в нём адресов.
    const { calls, payload } = fakePayload(emptyDocs);
    const probe: SiteProbe = (url) => {
      if (url === `${ORIGIN}/sitemap.xml`) {
        return Promise.resolve({
          body: `<sitemapindex><sitemap><loc>${ORIGIN}/sitemap-sections.xml</loc></sitemap></sitemapindex>`,
          status: 200,
        });
      }
      if (url === `${ORIGIN}/sitemap-sections.xml`) {
        return Promise.resolve({
          body: `<urlset><url><loc>${ORIGIN}/podborki</loc></url></urlset>`,
          status: 200,
        });
      }
      return Promise.resolve(page());
    };

    await runLinkAudit({ env, payload, probe });

    const data = calls.find((call) => call.name === 'updateGlobal')?.args.data as {
      sitemap: { indexStatus: number | null; urls: number | null };
    };
    expect(data.sitemap.indexStatus).toBe(200);
    expect(data.sitemap.urls).toBe(1);
  });

  it('непрочитанная карта не превращается в «страницы в карте нет»', async () => {
    const { calls, payload } = fakePayload({
      cards: [{ id: 3, slug: 'roza', status: 'published', title: 'Роза' }],
      collections: [],
    });
    const probe: SiteProbe = (url) =>
      url === `${ORIGIN}/sitemap.xml`
        ? Promise.resolve({ body: '', status: 500 })
        : Promise.resolve(page());

    await runLinkAudit({ env, payload, probe });

    const data = calls.find((call) => call.name === 'updateGlobal')?.args.data as {
      records: { inSitemap: string }[];
      sitemap: { indexStatus: number | null; urls: number | null };
      warnings: { text: string }[];
    };
    expect(data.sitemap.indexStatus).toBe(500);
    expect(data.sitemap.urls).toBeNull();
    // Пустая ячейка — «неизвестно», и предупреждение об этом дошло до отчёта.
    expect(data.records[0]?.inSitemap).toBe('');
    expect(data.warnings.map((warning) => warning.text).join(' ')).toContain('sitemap.xml');
  });

  it('без SITE_URL прогон падает, а не обходит выдуманный хост', async () => {
    const { payload } = fakePayload(emptyDocs);
    await expect(
      runLinkAudit({ env: {}, payload, probe: () => Promise.resolve(page()) }),
    ).rejects.toThrow('SITE_URL');
  });
});
