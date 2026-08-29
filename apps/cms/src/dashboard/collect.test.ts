/**
 * Сбор данных дашборда (Э5-04).
 *
 * Главный тест здесь негативный: дашборд не показывает того, чего смотрящему не
 * положено. Проверяется не «мы так решили», а машинный признак — каждый запрос
 * идёт с `overrideAccess: false` и с `req` вызывающего. Именно это свойство
 * дважды нарушалось раньше (снимок дублей анониму, выгрузка мимо прав), и
 * агрегат — самое удобное место, чтобы нарушить его в третий раз незаметно.
 */
import type { Payload, PayloadRequest } from 'payload';
import { describe, expect, it } from 'vitest';

import { collectAudit, collectDashboardModel } from './collect';

interface Call {
  readonly args: Record<string, unknown>;
  readonly name: string;
}

function fakePayload(options: {
  readonly cards?: Record<string, unknown>[];
  readonly collections?: Record<string, unknown>[];
  readonly globalDoc?: Record<string, unknown>;
  readonly globalThrows?: boolean;
  readonly history?: Record<string, unknown>[];
}) {
  const calls: Call[] = [];
  const payload = {
    find: (args: Record<string, unknown>) => {
      calls.push({ args, name: `find:${String(args.collection)}` });
      if (args.collection === 'cards') {
        return Promise.resolve({ docs: options.cards ?? [] });
      }
      if (args.collection === 'collections') {
        return Promise.resolve({ docs: options.collections ?? [] });
      }
      return Promise.resolve({ docs: options.history ?? [] });
    },
    findGlobal: (args: Record<string, unknown>) => {
      calls.push({ args, name: 'findGlobal' });
      if (options.globalThrows === true) {
        return Promise.reject(new Error('Forbidden'));
      }
      return Promise.resolve(options.globalDoc ?? {});
    },
  };
  return { calls, payload: payload as unknown as Payload };
}

const viewer = { user: { email: 'admin@otkritka.test' } } as unknown as PayloadRequest;

describe('права смотрящего', () => {
  it('КАЖДЫЙ запрос идёт с overrideAccess: false и с req вызывающего', async () => {
    const { calls, payload } = fakePayload({});
    await collectDashboardModel({ payload, req: viewer });

    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const call of calls) {
      expect(call.args.overrideAccess).toBe(false);
      expect(call.args.req).toBe(viewer);
    }
  });

  it('закрытый отчёт проверки ссылок даёт «нет прав», а не нули', async () => {
    const { payload } = fakePayload({ globalThrows: true });
    const audit = await collectAudit({ payload, req: viewer });

    expect(audit.summary).toBeNull();
    expect(audit.absence).toBe('forbidden');
  });

  it('незапущенная проверка отличается от закрытой', async () => {
    const { payload } = fakePayload({ globalDoc: { id: 1 } });
    const audit = await collectAudit({ payload, req: viewer });

    expect(audit.absence).toBe('never-run');
  });
});

describe('чтение отчёта проверки ссылок', () => {
  it('счётчики и наблюдение за картой сайта доходят до модели', async () => {
    const { payload } = fakePayload({
      globalDoc: {
        counts: { broken: 2, notMeasured: 0, orphans: 3, redirected: 1, unhealthy: 0 },
        crawl: { requested: 40, truncated: false },
        finishedAt: '2026-08-29T03:04:00.000Z',
        reliable: true,
        sitemap: { indexStatus: 200, urls: 12 },
        startedAt: '2026-08-29T03:00:00.000Z',
      },
    });
    const audit = await collectAudit({ payload, req: viewer });

    expect(audit.summary).toMatchObject({
      broken: 2,
      orphans: 3,
      reliable: true,
      sitemapIndexStatus: 200,
      sitemapUrls: 12,
    });
  });
});

describe('сборка модели из записей', () => {
  it('счётчики и адреса собираются из документов обеих коллекций', async () => {
    const { payload } = fakePayload({
      cards: [{ id: 1, slug: 'roza', status: 'published', title: 'Роза' }],
      collections: [
        { id: 2, path: '/podborki/prazdniki/8-marta', status: 'review', title: '8 марта' },
      ],
    });
    const model = await collectDashboardModel({ payload, req: viewer });

    expect(model.statuses[0]).toMatchObject({ collection: 'cards', published: 1 });
    expect(model.review.rows[0]?.path).toBe('/podborki/prazdniki/8-marta');
  });
});
