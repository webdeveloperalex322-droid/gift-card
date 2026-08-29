/**
 * Модель дашборда SEO-здоровья (задача Э5-04, ТЗ §8.4) — чистое ядро.
 *
 * Здесь нет ни Payload, ни React, ни запросов: на вход приходят уже прочитанные
 * записи, журнал и отчёт проверки ссылок, на выходе — то, что рисует экран.
 * Разделение сделано ради одного: КАЖДОЕ число дашборда обязано быть проверено
 * тестом. Дашборд — это единственный экран, по которому редактор судит о
 * состоянии сайта; уверенно соврать он может ровно один раз.
 *
 * ═══ ДВА ИСТОЧНИКА ПРО ДУБЛИ МЕТАТЕГОВ, И ИХ НЕЛЬЗЯ ПУТАТЬ ═══
 *
 *   1. **Ключи** `titleKey` и `metaDescriptionKey` — нормализованные значения,
 *      которые хук пишет при каждом сохранении. Совпадение ключей ВСЕГДА
 *      актуально: оно считается по текущим данным здесь и сейчас. Это главный
 *      источник блока «дубли метатегов»;
 *   2. **Снимок** `metaConflict` — то, что проверка нашла В МОМЕНТ последнего
 *      сохранения записи (`checkedAt`), вместе с выданным подтверждением
 *      (`confirmedFor`, `confirmedBy`). Снимок верен на `checkedAt`, а не на
 *      момент просмотра: конфликтующую страницу с тех пор могли переименовать
 *      или удалить. Поэтому дашборд показывает дату снимка рядом с числом, а не
 *      выдаёт его за сегодняшнее состояние.
 *
 * Смешать их в одну цифру нельзя: первая отвечает «есть ли дубли сейчас», вторая
 * — «что редактор видел и что подтвердил».
 *
 * ═══ ПРО «СТАТУС ПОСЛЕДНЕЙ ГЕНЕРАЦИИ SITEMAP» ═══
 *
 * ТЗ §8.4 требует показать статус последней генерации карты сайта. Генерации не
 * существует: карта собирается НА ЗАПРОСЕ (решение этапа 4), файла на диске нет,
 * хуков перегенерации нет. Показать дату, которой нет, значило бы соврать
 * уверенно, поэтому блок показывает то, что действительно измерено, — ответ
 * `/sitemap.xml` во время последнего обхода (Э5-03), и прямо говорит, что это
 * наблюдение, а не генерация. Расхождение формы с формулировкой `CLAUDE.md`
 * заведено вопросом Э4-04-A и ждёт решения человека.
 */
import { isSeasonalAlert, type SeasonalDeadline, seasonalDeadline } from '../collections/seasonal';

/**
 * Сколько записей читается для счётчиков за один заход.
 *
 * ПРОВЕНАНС: выбор агента (тот же список кандидатов в реестр, что
 * `MAX_INVENTORY_ROWS` и `LINK_AUDIT_MAX_REQUESTS`). Дашборд — стартовый экран,
 * он обязан открываться быстро; полный проход по каталогу на каждом открытии
 * админки этому противоречит. Упёрлись в предел — числа помечаются как НИЖНЯЯ
 * ГРАНИЦА, а не выдаются за полные.
 */
export const DASHBOARD_SCAN_LIMIT = 2000;

/** Сколько строк показывается в каждом списке. Остальное — в счётчике. */
export const DASHBOARD_LIST_LIMIT = 10;

/** Сколько последних изменений показывается из `seo-history`. */
export const DASHBOARD_HISTORY_LIMIT = 10;

export type DashboardCollection = 'cards' | 'collections';

/** Ссылка на запись — минимум, которым её называют в любом блоке. */
export interface RecordRef {
  readonly collection: DashboardCollection;
  readonly id: string;
  readonly path: string | null;
  readonly status: string;
  readonly title: string;
}

/** Запись в объёме, который нужен дашборду. */
export interface DashboardRecord extends RecordRef {
  readonly metaConflict: {
    readonly checkedAt: string | null;
    readonly confirmedBy: string | null;
    readonly confirmedFor: string | null;
    readonly total: number;
  } | null;
  readonly metaDescriptionKey: string | null;
  readonly robots: string | null;
  readonly seasonal: {
    readonly holidayDate: unknown;
    readonly readyBy: unknown;
    readonly showFrom: unknown;
    readonly showUntil: unknown;
  } | null;
  readonly titleKey: string | null;
  readonly updatedAt: string | null;
  readonly visualDuplicate: {
    readonly closest: number | null;
    readonly scanTruncated: boolean;
    readonly similar: number;
  } | null;
}

/** Одна строка журнала для блока «последние изменения». */
export interface HistoryEntry {
  readonly authorRole: string;
  readonly changedAt: string | null;
  readonly changedBy: string | null;
  readonly documentPath: string | null;
  readonly field: string;
  readonly operation: string;
}

/** Отчёт проверки ссылок в объёме, который показывает дашборд. */
export interface AuditSummary {
  readonly broken: number;
  readonly finishedAt: string | null;
  readonly notMeasured: number;
  readonly orphans: number;
  readonly redirected: number;
  readonly reliable: boolean;
  readonly sitemapIndexStatus: number | null;
  readonly sitemapUrls: number | null;
  readonly truncated: boolean;
  readonly unhealthy: number;
}

/** Почему отчёта проверки ссылок нет. */
export type AuditAbsence = 'forbidden' | 'never-run';

/* ------------------------------------------------------------------ */
/* Чтение сырых документов                                             */
/* ------------------------------------------------------------------ */

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function group(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** Идентификатор записи в виде строки: Payload отдаёт число или строку. */
function identifier(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  return typeof value === 'number' ? String(value) : null;
}

/**
 * Как назвать связанного пользователя. На глубине 0 приходит идентификатор, на
 * большей — документ; дашборд обязан прочитать обе формы, иначе автор
 * подтверждения то виден, то нет в зависимости от параметра запроса.
 */
function relationLabel(value: unknown): string | null {
  const direct = identifier(value);
  if (direct !== null) {
    return direct;
  }
  const record = group(value);
  if (record === null) {
    return null;
  }
  return optionalText(record.email) ?? identifier(record.id);
}

/**
 * Приводит документ Payload к записи дашборда.
 *
 * Читатель терпим к отсутствию полей НАМЕРЕННО: часть групп (`metaConflict`,
 * `visualDuplicate`) закрыта доступом на уровне поля, и у смотрящего без прав
 * их в документе просто нет. Это не ошибка и не повод показать ноль как факт —
 * ниже такие записи просто не попадают в блок.
 */
export function toDashboardRecord(
  collection: DashboardCollection,
  doc: Record<string, unknown>,
  path: string | null,
): DashboardRecord {
  const conflict = group(doc.metaConflict);
  const visual = group(doc.visualDuplicate);
  const similar = Array.isArray(visual?.similar) ? visual.similar : [];
  const distances = similar
    .map((item) => group(item)?.distance)
    .filter((distance): distance is number => typeof distance === 'number');

  return {
    collection,
    id: identifier(doc.id) ?? '',
    metaConflict:
      conflict === null
        ? null
        : {
            checkedAt: optionalText(conflict.checkedAt),
            confirmedBy: relationLabel(conflict.confirmedBy),
            confirmedFor: optionalText(conflict.confirmedFor),
            total: typeof conflict.total === 'number' ? conflict.total : 0,
          },
    metaDescriptionKey: optionalText(doc.metaDescriptionKey),
    path,
    robots: optionalText(doc.robots),
    seasonal: (() => {
      const seasonal = group(doc.seasonal);
      return seasonal === null
        ? null
        : {
            holidayDate: seasonal.holidayDate,
            readyBy: seasonal.readyBy,
            showFrom: seasonal.showFrom,
            showUntil: seasonal.showUntil,
          };
    })(),
    status: text(doc.status),
    title: text(doc.title),
    titleKey: optionalText(doc.titleKey),
    updatedAt: optionalText(doc.updatedAt),
    visualDuplicate:
      visual === null
        ? null
        : {
            closest: distances.length === 0 ? null : Math.min(...distances),
            scanTruncated: visual.scanTruncated === true,
            similar: similar.length,
          },
  };
}

/* ------------------------------------------------------------------ */
/* Блоки дашборда                                                      */
/* ------------------------------------------------------------------ */

export interface StatusCounts {
  readonly collection: DashboardCollection;
  readonly draft: number;
  readonly other: number;
  readonly published: number;
  readonly review: number;
  readonly total: number;
}

/** Счётчики по статусам — по коллекциям, без свода в одно число. */
export function countStatuses(records: readonly DashboardRecord[]): StatusCounts[] {
  const collections: DashboardCollection[] = ['cards', 'collections'];
  return collections.map((collection) => {
    const own = records.filter((record) => record.collection === collection);
    const of = (status: string): number => own.filter((record) => record.status === status).length;
    const draft = of('draft');
    const review = of('review');
    const published = of('published');
    return {
      collection,
      draft,
      other: own.length - draft - review - published,
      published,
      review,
      total: own.length,
    };
  });
}

export type MetaKeyField = 'metaDescription' | 'title';

export interface MetaKeyGroup {
  readonly field: MetaKeyField;
  readonly key: string;
  readonly records: readonly RecordRef[];
}

export interface MetaKeySummary {
  readonly groups: readonly MetaKeyGroup[];
  readonly groupCount: number;
  /** Сколько записей участвует в совпадениях. */
  readonly recordCount: number;
}

/**
 * Совпадения нормализованных ключей — источник «всегда актуально».
 *
 * Круг тот же, что у калитки перевода в `review`: `published` и `review`
 * ({@link META_KEY_STATUSES}). Черновики не считаются намеренно — иначе дашборд
 * показывал бы дубли, о которых сами хуки молчат, и число на экране спорило бы с
 * поведением системы.
 */
export const META_KEY_STATUSES: readonly string[] = ['published', 'review'];

export function findMetaKeyDuplicates(records: readonly DashboardRecord[]): MetaKeySummary {
  const buckets = new Map<string, { field: MetaKeyField; key: string; records: DashboardRecord[] }>();
  for (const record of records) {
    if (!META_KEY_STATUSES.includes(record.status)) {
      continue;
    }
    const pairs: readonly [MetaKeyField, string | null][] = [
      ['title', record.titleKey],
      ['metaDescription', record.metaDescriptionKey],
    ];
    for (const [field, key] of pairs) {
      if (key === null) {
        continue;
      }
      const id = `${field} ${key}`;
      const bucket = buckets.get(id) ?? { field, key, records: [] };
      bucket.records.push(record);
      buckets.set(id, bucket);
    }
  }

  const groups = [...buckets.values()].filter((bucket) => bucket.records.length > 1);
  const involved = new Set<string>();
  for (const bucketGroup of groups) {
    for (const record of bucketGroup.records) {
      involved.add(`${record.collection} ${record.id}`);
    }
  }
  return {
    groupCount: groups.length,
    groups: groups.slice(0, DASHBOARD_LIST_LIMIT).map((bucket) => ({
      field: bucket.field,
      key: bucket.key,
      records: bucket.records.map((record) => recordRef(record)),
    })),
    recordCount: involved.size,
  };
}

function recordRef(record: DashboardRecord): RecordRef {
  return {
    collection: record.collection,
    id: record.id,
    path: record.path,
    status: record.status,
    title: record.title,
  };
}

export interface MetaSnapshotRow extends RecordRef {
  readonly checkedAt: string | null;
  readonly confirmed: boolean;
  readonly confirmedBy: string | null;
  readonly total: number;
}

export interface MetaSnapshotSummary {
  readonly confirmedCount: number;
  readonly count: number;
  /** Самый старый `checkedAt` среди показанных: докуда снимок вообще стар. */
  readonly oldestCheckedAt: string | null;
  readonly rows: readonly MetaSnapshotRow[];
}

/**
 * Снимки конфликтов — источник «что редактор видел и что подтвердил».
 *
 * Дата снимка идёт РЯДОМ с числом, а не отдельной строчкой мелким шрифтом:
 * снимок верен на `checkedAt`, и без даты он читается как сегодняшнее состояние.
 */
export function collectMetaSnapshots(records: readonly DashboardRecord[]): MetaSnapshotSummary {
  const rows: MetaSnapshotRow[] = [];
  for (const record of records) {
    const conflict = record.metaConflict;
    if (conflict === null || conflict.total <= 0) {
      continue;
    }
    rows.push({
      ...recordRef(record),
      checkedAt: conflict.checkedAt,
      confirmed: conflict.confirmedFor !== null,
      confirmedBy: conflict.confirmedBy,
      total: conflict.total,
    });
  }
  const dates = rows
    .map((row) => row.checkedAt)
    .filter((date): date is string => date !== null)
    .sort();
  return {
    confirmedCount: rows.filter((row) => row.confirmed).length,
    count: rows.length,
    oldestCheckedAt: dates[0] ?? null,
    rows: rows.slice(0, DASHBOARD_LIST_LIMIT),
  };
}

export interface VisualRow extends RecordRef {
  readonly closest: number | null;
  readonly similar: number;
}

export interface VisualSummary {
  /** Записи, у которых обход каталога был НЕПОЛНЫМ: «не найдено» ничего не значит. */
  readonly truncated: readonly RecordRef[];
  readonly truncatedCount: number;
  readonly rows: readonly VisualRow[];
  readonly withSimilarCount: number;
}

/**
 * Визуальные дубли.
 *
 * Второй счётчик — `scanTruncated` — ценнее первого и потому не спрятан: у таких
 * карточек «похожих не найдено» означает «дальше не искали». Показывать только
 * число найденных дублей значило бы выдавать неполную проверку за чистый
 * результат.
 */
export function collectVisualDuplicates(records: readonly DashboardRecord[]): VisualSummary {
  const rows: VisualRow[] = [];
  const truncated: RecordRef[] = [];
  for (const record of records) {
    const visual = record.visualDuplicate;
    if (visual === null) {
      continue;
    }
    if (visual.similar > 0) {
      rows.push({ ...recordRef(record), closest: visual.closest, similar: visual.similar });
    }
    if (visual.scanTruncated) {
      truncated.push(recordRef(record));
    }
  }
  return {
    rows: rows.slice(0, DASHBOARD_LIST_LIMIT),
    truncated: truncated.slice(0, DASHBOARD_LIST_LIMIT),
    truncatedCount: truncated.length,
    withSimilarCount: rows.length,
  };
}

export interface SeasonalRow extends RecordRef {
  readonly deadline: SeasonalDeadline;
}

export interface SeasonalSummary {
  /** Приближающиеся и сорванные дедлайны, ближайший первым. */
  readonly alerts: readonly SeasonalRow[];
  readonly overdueCount: number;
  readonly upcomingCount: number;
  /** Узлы с окном показа, заданным наполовину или перевёрнутым. */
  readonly windowIssues: readonly SeasonalRow[];
}

/**
 * Сезонные дедлайны подборок (ТЗ §8.6, Э5-07).
 *
 * Только подборки: даты праздника у карточки нет, и не должно быть — сезон
 * принадлежит посадочной странице, а не открытке.
 */
export function collectSeasonal(
  records: readonly DashboardRecord[],
  now: Date,
): SeasonalSummary {
  const alerts: SeasonalRow[] = [];
  const windowIssues: SeasonalRow[] = [];
  for (const record of records) {
    if (record.collection !== 'collections' || record.seasonal === null) {
      continue;
    }
    const deadline = seasonalDeadline({ ...record.seasonal, status: record.status }, now);
    if (isSeasonalAlert(deadline)) {
      alerts.push({ ...recordRef(record), deadline });
    }
    if (deadline.showWindow !== null) {
      windowIssues.push({ ...recordRef(record), deadline });
    }
  }
  alerts.sort((left, right) => (left.deadline.daysLeft ?? 0) - (right.deadline.daysLeft ?? 0));
  return {
    alerts: alerts.slice(0, DASHBOARD_LIST_LIMIT),
    overdueCount: alerts.filter((row) => row.deadline.state === 'overdue').length,
    upcomingCount: alerts.filter((row) => row.deadline.state === 'upcoming').length,
    windowIssues: windowIssues.slice(0, DASHBOARD_LIST_LIMIT),
  };
}

export interface ReviewSummary {
  readonly count: number;
  readonly rows: readonly RecordRef[];
}

/** Записи в `review` — то, что ждёт решения человека. */
export function collectReview(records: readonly DashboardRecord[]): ReviewSummary {
  const waiting = records
    .filter((record) => record.status === 'review')
    .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''));
  return { count: waiting.length, rows: waiting.slice(0, DASHBOARD_LIST_LIMIT).map(recordRef) };
}

/* ------------------------------------------------------------------ */
/* Сборка модели                                                       */
/* ------------------------------------------------------------------ */

export interface DashboardModel {
  readonly audit: AuditSummary | null;
  readonly auditAbsence: AuditAbsence | null;
  readonly history: readonly HistoryEntry[];
  readonly metaKeys: MetaKeySummary;
  readonly metaSnapshots: MetaSnapshotSummary;
  readonly review: ReviewSummary;
  readonly scanTruncated: boolean;
  readonly seasonal: SeasonalSummary;
  readonly statuses: readonly StatusCounts[];
  readonly visual: VisualSummary;
}

export function buildDashboard(input: {
  readonly audit: AuditSummary | null;
  readonly auditAbsence: AuditAbsence | null;
  readonly history: readonly HistoryEntry[];
  readonly now: Date;
  readonly records: readonly DashboardRecord[];
  /** Записей больше, чем прочитано: числа — нижняя граница. */
  readonly scanTruncated: boolean;
}): DashboardModel {
  return {
    audit: input.audit,
    auditAbsence: input.auditAbsence,
    history: input.history.slice(0, DASHBOARD_HISTORY_LIMIT),
    metaKeys: findMetaKeyDuplicates(input.records),
    metaSnapshots: collectMetaSnapshots(input.records),
    review: collectReview(input.records),
    scanTruncated: input.scanTruncated,
    seasonal: collectSeasonal(input.records, input.now),
    statuses: countStatuses(input.records),
    visual: collectVisualDuplicates(input.records),
  };
}
