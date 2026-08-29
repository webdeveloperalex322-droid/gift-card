/**
 * Сбор данных дашборда (задача Э5-04): что и с чьими правами спрашивается.
 *
 * ═══ ГЛАВНОЕ ПРАВИЛО: ДАШБОРД ПОКАЗЫВАЕТ ТО, ЧТО ВИДИТ СМОТРЯЩИЙ ═══
 *
 * Каждый запрос идёт с `overrideAccess: false` и с `req` того, кто открыл экран,
 * то есть через тот же access control, что REST и GraphQL. Роль, которой
 * черновики не видны, не увидит их и в счётчиках; отчёт проверки ссылок закрыт
 * от анонима — значит блок покажет «нет прав», а не содержимое.
 *
 * Это не перестраховка, а третий заход на одну и ту же ошибку: на Э5-02 снимок
 * дублей уходил анониму вместе с идентификаторами записей в `review`, на Э5-05
 * выгрузка собиралась мимо прав вызывающего. Класс ошибки один — «сводка
 * отдаётся шире, чем сами записи», — и дашборд для неё самое удобное место:
 * он агрегирует, а агрегат выглядит безобидно.
 *
 * ═══ ПОЧЕМУ ОДИН ПРОХОД ПО ЗАПИСЯМ, А НЕ ЗАПРОС НА КАЖДЫЙ БЛОК ═══
 *
 * Блоков много (статусы, дубли метатегов, визуальные дубли, `review`,
 * сезонность), а данные у них общие. Отдельный запрос под каждый означал бы
 * пять-шесть обращений к базе на КАЖДОЕ открытие стартового экрана; вместо
 * этого читается один срез полей, а считают по нему чистые функции из
 * `./health.ts` — те самые, что покрыты тестами.
 *
 * Цена названа прямо: срез ограничен {@link DASHBOARD_SCAN_LIMIT} записями.
 * Упёрлись в предел — модель помечена `scanTruncated`, и дашборд говорит, что
 * его числа НИЖНЯЯ ГРАНИЦА, а не итог.
 */
import type { Payload, PayloadRequest } from 'payload';

import { contentDocumentPath } from '../seo/paths';
import { LINK_AUDIT_SLUG } from '../audit/report';
import {
  type AuditAbsence,
  type AuditSummary,
  DASHBOARD_HISTORY_LIMIT,
  DASHBOARD_SCAN_LIMIT,
  type DashboardModel,
  type DashboardRecord,
  type HistoryEntry,
  buildDashboard,
  toDashboardRecord,
} from './health';

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalTextOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function numberOf(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

/** Идентификатор связи строкой: на глубине 0 Payload отдаёт число или строку. */
function identifierOf(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  return typeof value === 'number' ? String(value) : null;
}

/** Читает обе контентные коллекции одним срезом полей. */
export async function collectDashboardRecords(args: {
  readonly payload: Payload;
  readonly req: PayloadRequest;
}): Promise<{ records: DashboardRecord[]; truncated: boolean }> {
  const shared = {
    depth: 0,
    // На единицу больше предела: превышение обязано быть ВИДНО, а не потеряться
    // на границе выборки. Тот же приём, что в выгрузке Э5-05.
    limit: DASHBOARD_SCAN_LIMIT + 1,
    overrideAccess: false,
    req: args.req,
    sort: 'id',
  } as const;

  const cards = await args.payload.find({
    ...shared,
    collection: 'cards',
    select: {
      metaConflict: true,
      metaDescriptionKey: true,
      robots: true,
      slug: true,
      status: true,
      title: true,
      titleKey: true,
      updatedAt: true,
      visualDuplicate: true,
    },
  });
  const collections = await args.payload.find({
    ...shared,
    collection: 'collections',
    select: {
      metaConflict: true,
      metaDescriptionKey: true,
      path: true,
      robots: true,
      seasonal: true,
      status: true,
      title: true,
      titleKey: true,
      updatedAt: true,
    },
  });

  const records: DashboardRecord[] = [];
  for (const [collection, page] of [
    ['cards', cards],
    ['collections', collections],
  ] as const) {
    for (const doc of page.docs.slice(0, DASHBOARD_SCAN_LIMIT)) {
      const raw = doc as unknown as Record<string, unknown>;
      records.push(toDashboardRecord(collection, raw, contentDocumentPath(collection, doc)));
    }
  }
  return {
    records,
    truncated: cards.docs.length > DASHBOARD_SCAN_LIMIT || collections.docs.length > DASHBOARD_SCAN_LIMIT,
  };
}

/** Последние изменения SEO-полей. Журнал читают только аутентифицированные. */
export async function collectHistory(args: {
  readonly payload: Payload;
  readonly req: PayloadRequest;
}): Promise<HistoryEntry[]> {
  try {
    const page = await args.payload.find({
      collection: 'seo-history',
      depth: 0,
      limit: DASHBOARD_HISTORY_LIMIT,
      overrideAccess: false,
      req: args.req,
      sort: '-changedAt',
    });
    return page.docs.map((doc) => {
      const raw = doc as unknown as Record<string, unknown>;
      return {
        authorRole: textOf(raw.authorRole),
        changedAt: optionalTextOf(raw.changedAt),
        changedBy: identifierOf(raw.changedBy),
        documentPath: optionalTextOf(raw.documentPath),
        field: textOf(raw.field),
        operation: textOf(raw.operation),
      };
    });
  } catch {
    // Нет прав на журнал — пустой список, а не падение экрана. Отличить «нет
    // прав» от «изменений не было» помогает роль смотрящего: журнал закрыт от
    // анонима целиком.
    return [];
  }
}

/**
 * Отчёт проверки внутренних ссылок.
 *
 * Три исхода, и они РАЗНЫЕ: отчёт есть; отчёта нет, потому что проверка ни разу
 * не запускалась; отчёт есть, но смотрящему он не отдан. Свести их к «нулю
 * сирот» нельзя — это ровно то враньё, ради которого дашборд и заводят.
 */
export async function collectAudit(args: {
  readonly payload: Payload;
  readonly req: PayloadRequest;
}): Promise<{ absence: AuditAbsence | null; summary: AuditSummary | null }> {
  let raw: Record<string, unknown>;
  try {
    const doc = await args.payload.findGlobal({
      depth: 0,
      overrideAccess: false,
      req: args.req,
      slug: LINK_AUDIT_SLUG,
    });
    raw = doc as unknown as Record<string, unknown>;
  } catch {
    return { absence: 'forbidden', summary: null };
  }

  const startedAt = optionalTextOf(raw.startedAt);
  if (startedAt === null) {
    return { absence: 'never-run', summary: null };
  }

  const counts = (raw.counts ?? {}) as Record<string, unknown>;
  const crawl = (raw.crawl ?? {}) as Record<string, unknown>;
  const sitemap = (raw.sitemap ?? {}) as Record<string, unknown>;
  return {
    absence: null,
    summary: {
      broken: numberOf(counts.broken),
      finishedAt: optionalTextOf(raw.finishedAt),
      notMeasured: numberOf(counts.notMeasured),
      orphans: numberOf(counts.orphans),
      redirected: numberOf(counts.redirected),
      reliable: raw.reliable === true,
      sitemapIndexStatus: typeof sitemap.indexStatus === 'number' ? sitemap.indexStatus : null,
      sitemapUrls: typeof sitemap.urls === 'number' ? sitemap.urls : null,
      truncated: crawl.truncated === true,
      unhealthy: numberOf(counts.unhealthy),
    },
  };
}

/** Полная модель дашборда для одного смотрящего. */
export async function collectDashboardModel(args: {
  readonly now?: Date;
  readonly payload: Payload;
  readonly req: PayloadRequest;
}): Promise<DashboardModel> {
  const inventory = await collectDashboardRecords(args);
  const history = await collectHistory(args);
  const audit = await collectAudit(args);
  return buildDashboard({
    audit: audit.summary,
    auditAbsence: audit.absence,
    history,
    now: args.now ?? new Date(),
    records: inventory.records,
    scanTruncated: inventory.truncated,
  });
}
