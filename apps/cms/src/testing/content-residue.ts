/**
 * Остатки живых API-тестов в КОНТЕНТНОЙ базе.
 *
 * ЗАЧЕМ. Начиная с 2026-09-03 набор `tests/api` работает на отдельной базе
 * (см. `api-test-database.mjs`), и в контентную базу не пишет ничего. Но
 * «не пишет» — это утверждение о коде, а требование человека — о СОСТОЯНИИ
 * базы: записей харнесса в ней нет, и опубликованных тем более. Утверждение о
 * состоянии проверяется запросом к состоянию, поэтому здесь живёт ровно один
 * запрос и ни одного правила.
 *
 * ЧТО СЧИТАЕТСЯ ЗАПИСЬЮ ХАРНЕССА. Все записи, которые создают файлы `tests/api`
 * и фикстуры, начинаются с маркера задачи: `p0-` (каркас) и `e601-`…`e604-`
 * (задачи этапа 6), у изображений — транслитерация заголовка `Э6-02: …` в
 * `e6-02-…`. Маркер и есть машинный признак: реальный контент — это
 * транслитерация русских названий (`otkrytka-mame-…`, `8-marta`), она не может
 * начаться с `e60` или `p0-`. Проверено на живой базе 2026-09-03: фильтр отобрал
 * 5 карточек и 13 подборок харнесса, оставив 1021 реальную карточку и 24
 * реальные подборки — те же числа, что в независимом замере `reviewer`.
 */
import { queryContentDatabase } from './api-test-database.mjs';

/** Маркер в начале slug карточки или подборки. */
export const HARNESS_SLUG_PATTERN = '^(p0-|e60[0-9])';

/** Маркер в любом сегменте пути: путь подборки собирается из slug родителей. */
export const HARNESS_PATH_PATTERN = '/(p0-|e60[0-9])';

/** Маркер в имени файла изображения: заголовок `Э6-02: …` даёт стем `e6-02-…`. */
export const HARNESS_IMAGE_PATTERN = '^e6-0[0-9]';

/** Маркер в адресе почты тестового аккаунта. */
export const HARNESS_EMAIL_PATTERN = '^(p0-|e60[0-9])';

export interface ResidueGroup {
  /** Сколько строк с маркером харнесса нашлось. */
  readonly count: number;
  /** Сколько из них в статусе `published` (у таблиц без статуса — 0). */
  readonly published: number;
  /** Первые значения — чтобы отчёт называл записи, а не только числа. */
  readonly samples: readonly string[];
  /** Таблица контентной базы. */
  readonly table: string;
}

/**
 * Один запрос на все таблицы: соединение открывается и закрывается один раз, а
 * числа получаются согласованными между собой.
 */
const RESIDUE_SQL = `
select 'cards' as "table", count(*)::int as count,
       count(*) filter (where status = 'published')::int as published,
       coalesce((array_agg(slug order by id))[1:5], '{}') as samples
  from cards where slug ~ '${HARNESS_SLUG_PATTERN}'
union all
select 'collections', count(*)::int,
       count(*) filter (where status = 'published')::int,
       coalesce((array_agg(slug order by id))[1:5], '{}')
  from collections where slug ~ '${HARNESS_SLUG_PATTERN}'
union all
select 'card_images', count(*)::int, 0,
       coalesce((array_agg(name_stem order by id))[1:5], '{}')
  from card_images where name_stem ~ '${HARNESS_IMAGE_PATTERN}'
union all
select 'users', count(*)::int, 0,
       coalesce((array_agg(email order by id))[1:5], '{}')
  from users where email ~ '${HARNESS_EMAIL_PATTERN}'
union all
select 'redirects', count(*)::int, 0,
       coalesce((array_agg("from" order by id))[1:5], '{}')
  from redirects where "from" ~ '${HARNESS_PATH_PATTERN}' or "to" ~ '${HARNESS_PATH_PATTERN}'
union all
select 'content_path_claims', count(*)::int, 0,
       coalesce((array_agg(path order by id))[1:5], '{}')
  from content_path_claims where path ~ '${HARNESS_PATH_PATTERN}'
union all
select 'image_name_claims', count(*)::int, 0,
       coalesce((array_agg(stem order by id))[1:5], '{}')
  from image_name_claims where stem ~ '${HARNESS_IMAGE_PATTERN}'
union all
select 'seo_history', count(*)::int, 0,
       coalesce((array_agg(document_path order by id))[1:5], '{}')
  from seo_history where document_path ~ '${HARNESS_PATH_PATTERN}'
`;

function readNumber(value: unknown, what: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  throw new Error(`Ответ базы не содержит числа в поле ${what}: ${JSON.stringify(value)}`);
}

function readSamples(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function readGroup(row: unknown): ResidueGroup {
  if (typeof row !== 'object' || row === null) {
    throw new Error(`Ответ базы не является строкой результата: ${JSON.stringify(row)}`);
  }
  const record = row as Record<string, unknown>;
  const table = record.table;
  if (typeof table !== 'string') {
    throw new Error(`Строка результата без имени таблицы: ${JSON.stringify(row)}`);
  }
  return {
    count: readNumber(record.count, `count у ${table}`),
    published: readNumber(record.published, `published у ${table}`),
    samples: readSamples(record.samples),
    table,
  };
}

/**
 * Что осталось в контентной базе от прогонов `tests/api`.
 *
 * @returns группы с непустым числом строк; пустой массив означает «чисто».
 */
export async function findContentDatabaseResidue(): Promise<readonly ResidueGroup[]> {
  const rows = await queryContentDatabase(RESIDUE_SQL);
  return rows.map(readGroup).filter((group) => group.count > 0);
}

/** Человекочитаемое описание остатков — для сообщения упавшего теста и отчёта. */
export function describeResidue(groups: readonly ResidueGroup[]): string {
  return groups
    .map(
      (group) =>
        `${group.table}: ${String(group.count)} стр., из них published ${String(group.published)}` +
        ` (например: ${group.samples.join(', ')})`,
    )
    .join('; ');
}
