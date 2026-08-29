/**
 * Прогон проверки внутренних ссылок (задача Э5-03): что спросить у базы, что у
 * сайта и что положить в отчёт.
 *
 * ЧТО ПРОВЕРЯЕТСЯ НА ДОСТИЖИМОСТЬ — ТОЛЬКО `published`. Черновик и запись в
 * `review` обязаны быть недостижимы: они `noindex` и вне карты сайта, ссылок из
 * шаблона на них нет по построению. Включить их в проверку значило бы каждую
 * ночь получать отчёт, в котором сирот ровно столько, сколько черновиков, —
 * и перестать его читать.
 *
 * ЧТО ЭТА ФУНКЦИЯ НЕ ДЕЛАЕТ: не пишет ни в `cards`, ни в `collections`, не
 * трогает статусы, robots-директивы и карту сайта. Единственная запись —
 * `updateGlobal` отчёта. Это проверяется тестом (`./run.test.ts`), а не
 * обещанием: фоновая задача, которая «чинит» найденное, — это и есть
 * автоматическое решение о публикации и индексации, запрещённое п. 7.1 и п. 23.
 */
import type { Payload, PayloadRequest } from 'payload';

import { buildAbsoluteUrl, resolveSiteOrigin, type SharedEnv } from '@otkritka/shared';

import {
  MAX_INVENTORY_ROWS,
  type SiteProbe,
  fetchProbe,
  readSitemapUrls,
} from '../export/inventory';
import { contentDocumentPath } from '../seo/paths';
import {
  type AuditedRecord,
  type LinkFinding,
  classifyLinkAudit,
  crawlSite,
  orphanCount,
} from './link-audit';
import { LINK_AUDIT_SLUG, type LinkAuditReportValue } from './report';

/** Что вернул прогон вызывающему — тем же составом, что лёг в отчёт. */
export interface LinkAuditRunResult {
  readonly report: LinkAuditReportValue;
}

/**
 * Опубликованные записи обеих контентных коллекций с их адресами.
 *
 * Чтение идёт с правами системы (`overrideAccess` по умолчанию у Local API):
 * задача выполняется без пользователя, а список ограничен статусом `published`,
 * то есть тем, что и так публично. Отчёт при этом читают только
 * аутентифицированные — см. `./report.ts`.
 */
export async function collectPublishedRecords(args: {
  readonly env?: SharedEnv;
  readonly payload: Payload;
  readonly req?: PayloadRequest;
}): Promise<{ records: AuditedRecord[]; warnings: string[] }> {
  const warnings: string[] = [];
  const records: AuditedRecord[] = [];
  const shared = {
    depth: 0,
    limit: MAX_INVENTORY_ROWS + 1,
    sort: 'id',
    where: { status: { equals: 'published' } },
  } as const;

  const cards = await args.payload.find({
    ...shared,
    collection: 'cards',
    ...(args.req === undefined ? {} : { req: args.req }),
    select: { slug: true, status: true, title: true },
  });
  const collections = await args.payload.find({
    ...shared,
    collection: 'collections',
    ...(args.req === undefined ? {} : { req: args.req }),
    select: { path: true, status: true, title: true },
  });

  for (const [collection, page] of [
    ['cards', cards],
    ['collections', collections],
  ] as const) {
    for (const doc of page.docs) {
      const path = contentDocumentPath(collection, doc);
      const title = typeof doc.title === 'string' ? doc.title : '';
      if (path === null) {
        warnings.push(`Запись «${title}» (${collection}) пропущена: путь не собран.`);
        continue;
      }
      records.push({
        collection,
        id: String(doc.id),
        title,
        url: buildAbsoluteUrl(path, args.env),
      });
    }
    if (page.docs.length > MAX_INVENTORY_ROWS) {
      warnings.push(
        `Опубликованных записей в «${collection}» больше ${String(MAX_INVENTORY_ROWS)}: ` +
          'проверены первые, остальные в отчёт не вошли.',
      );
    }
  }
  return { records: records.slice(0, MAX_INVENTORY_ROWS), warnings };
}

function linkRow(finding: LinkFinding, kind: 'broken' | 'redirected') {
  return {
    kind,
    location: finding.location,
    referrers: finding.referrers.join('\n'),
    status: finding.status,
    url: finding.url,
  };
}

function sitemapCell(value: boolean | null): string {
  return value === null ? '' : value ? 'да' : 'нет';
}

/**
 * Выполняет прогон и сохраняет отчёт.
 *
 * `probe` — параметр: смоук и тесты подставляют синтетический сайт, а рабочий
 * прогон берёт `fetchProbe()`. Origin параметром НЕ является: он всегда из
 * `SITE_URL`, иначе задача превратилась бы в инструмент запросов с сервера CMS
 * на произвольный хост. Если `SITE_URL` из процесса не резолвится, прогон падает
 * с внятной ошибкой — и это верное поведение: обойти нечего.
 */
export async function runLinkAudit(args: {
  readonly env?: SharedEnv;
  readonly now?: () => Date;
  readonly payload: Payload;
  readonly probe?: SiteProbe;
  readonly req?: PayloadRequest;
}): Promise<LinkAuditRunResult> {
  const clock = args.now ?? (() => new Date());
  const startedAt = clock().toISOString();
  const origin = resolveSiteOrigin(args.env);
  const probe = args.probe ?? fetchProbe();

  const inventory = await collectPublishedRecords({
    payload: args.payload,
    ...(args.env === undefined ? {} : { env: args.env }),
    ...(args.req === undefined ? {} : { req: args.req }),
  });
  const sitemap = await readSitemapUrls({ origin, probe });
  const crawl = await crawlSite({ origin, probe });
  const findings = classifyLinkAudit({
    crawl,
    records: inventory.records,
    sitemapUrls: sitemap.urls,
  });

  const warnings = [...inventory.warnings, ...sitemap.warnings, ...findings.warnings];
  const report: LinkAuditReportValue = {
    counts: {
      broken: findings.brokenTotal,
      notMeasured: findings.records.filter((record) => record.reason === 'not-measured').length,
      orphans: orphanCount(findings),
      publishedRecords: inventory.records.length,
      redirected: findings.redirectedTotal,
      unhealthy: findings.records.filter((record) => record.reason === 'not-200').length,
    },
    crawl: { requested: crawl.requested, truncated: crawl.truncated },
    finishedAt: clock().toISOString(),
    links: [
      ...findings.broken.map((finding) => linkRow(finding, 'broken')),
      ...findings.redirected.map((finding) => linkRow(finding, 'redirected')),
    ],
    origin,
    records: findings.records.map((record) => ({
      depth: record.depth,
      documentCollection: record.collection,
      documentId: record.id,
      inSitemap: sitemapCell(record.inSitemap),
      reason: record.reason,
      title: record.title,
      url: record.url,
    })),
    reliable: findings.reliable,
    sitemap: {
      indexStatus: sitemap.indexStatus,
      urls: sitemap.urls === null ? null : sitemap.urls.size,
    },
    startedAt,
    warnings: warnings.map((text) => ({ text })),
  };

  await args.payload.updateGlobal({
    data: report,
    depth: 0,
    slug: LINK_AUDIT_SLUG,
  });

  return { report };
}
