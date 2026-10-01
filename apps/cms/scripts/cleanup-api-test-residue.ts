/**
 * РАЗОВАЯ уборка остатков живых API-тестов из КОНТЕНТНОЙ базы.
 *
 * ОТКУДА ОСТАТКИ. До 2026-09-03 набор `tests/api` работал на контентной базе и
 * публиковал в ней записи фикстуры Э6-02 по-настоящему. Уборка в наборе была, но
 * жила в `afterAll`, а он не выполняется у оборванного прогона — так в рабочей
 * базе накопились карточки (часть в `published`, они попадали в живой каталог),
 * подборки, изображения, аккаунты с действующими API-ключами, строки реестра
 * путей, реестра имён файлов и журнала `seo-history`. С 2026-09-03 набор
 * работает на отдельной базе (`apps/cms/src/testing/api-test-database.mjs`),
 * поэтому новых остатков не появляется, и этот скрипт — разовый.
 *
 * Запуск (по умолчанию только считает и ничего не меняет):
 *   pnpm --filter @otkritka/cms exec payload run ./scripts/cleanup-api-test-residue.ts
 * Удаление требует явного флага:
 *   pnpm --filter @otkritka/cms exec payload run ./scripts/cleanup-api-test-residue.ts -- --apply
 *
 * ЧТО СЧИТАЕТСЯ ОСТАТКОМ. Записи с маркером задачи в начале slug, имени файла
 * или адреса почты: `p0-` (каркас набора) и `e601-`…`e604-` (задачи этапа 6);
 * у изображений заголовок `Э6-02: …` даёт стем `e6-02-…`. Реальный контент —
 * транслитерация русских названий (`otkrytka-mame-…`, `8-marta`, `den-materi`),
 * он не начинается ни с `e60`, ни с `p0-`. Скрипт не верит этому на слово:
 * перед удалением он печатает отобранные записи поимённо и примеры оставшихся, и
 * ОТКАЗЫВАЕТСЯ работать, если маркер отобрал больше половины таблицы
 * ({@link MAX_HARNESS_SHARE}) — так выглядел бы маркер, начавший задевать
 * реальный контент.
 *
 * ПОЧЕМУ ФИЛЬТР ЗАПИСАН ЗДЕСЬ ЗАНОВО, А НЕ ВЗЯТ ИЗ ГАРНИЗОНА. Тот же маркер
 * живёт в `src/testing/content-residue.ts` (им проверяется, что база чистая), но
 * импортировать `src/testing/**` из продуктового кода и служебных скриптов
 * запрещено правилом `no-restricted-imports`: этот каталог ходит с
 * `overrideAccess: true`. Скрипт разовый, и это единственное место, где
 * дублирование условия дешевле снятия запрета.
 *
 * ПОЧЕМУ УДАЛЕНИЕ ЧЕРЕЗ LOCAL API, А НЕ SQL. У карточек и изображений есть
 * хуки удаления: у изображения — снятие файлов с диска, у подборки — запрет
 * удаления узла с потомками (поэтому порядок: сначала карточки, потом подборки
 * от самых глубоких, потом изображения). SQL снёс бы строки и оставил файлы.
 *
 * ЧЕГО СКРИПТ НЕ УДАЛЯЕТ (исправление ревью от 2026-10-01). Реестр путей
 * (`content_path_claims`), реестр имён файлов (`image_name_claims`) и журнал
 * `seo_history` скрипт только СЧИТАЕТ. Claim по правилу CLAUDE.md «не
 * освобождается и не переиспользуется», а журнал намеренно переживает удаление
 * документа — это след аудита. Первая версия скрипта удаляла строки всех трёх
 * таблиц SQL-запросом и успела отработать с `--apply`; законность того
 * освобождения — вопрос человеку (`docs/otkrytye-voprosy.md`), а не решение
 * скрипта.
 */
import type { Payload } from 'payload';

import { type CleanupMode, cleanupMode } from '../src/scripts/cleanup-mode';

/** Маркер записи харнесса в начале slug, стема файла или адреса почты. */
const SLUG_MARKER = /^(p0-|e60\d)/;
const IMAGE_MARKER = /^e6-0\d/;

/** Тот же маркер для SQL — служебные таблицы только читаются запросом. */
const SQL_PATH_MARKER = "'/(p0-|e60[0-9])'";
const SQL_IMAGE_MARKER = "'^e6-0[0-9]'";

/**
 * Доля таблицы, выше которой отбор считается сломанным маркером, а не остатками.
 * Остатков харнесса в любой таблице — единицы процентов; половина и больше
 * означает, что маркер задевает реальный контент.
 */
const MAX_HARNESS_SHARE = 0.5;

interface Doc {
  readonly email?: unknown;
  readonly id: number | string;
  readonly nameStem?: unknown;
  readonly path?: unknown;
  readonly slug?: unknown;
  readonly status?: unknown;
}

async function readAll(payload: Payload, collection: 'card-images' | 'cards' | 'collections' | 'users'): Promise<Doc[]> {
  const docs: Doc[] = [];
  let page = 1;
  let hasNextPage = true;
  while (hasNextPage) {
    const result = await payload.find({
      collection,
      depth: 0,
      limit: 500,
      overrideAccess: true,
      page,
      sort: 'id',
    });
    docs.push(...result.docs.map((doc): Doc => ({ ...doc })));
    hasNextPage = result.hasNextPage;
    page += 1;
  }
  return docs;
}

function marked(doc: Doc): boolean {
  const slug = typeof doc.slug === 'string' ? doc.slug : '';
  const stem = typeof doc.nameStem === 'string' ? doc.nameStem : '';
  const email = typeof doc.email === 'string' ? doc.email : '';
  return SLUG_MARKER.test(slug) || IMAGE_MARKER.test(stem) || SLUG_MARKER.test(email);
}

function describe(doc: Doc): string {
  const label =
    typeof doc.slug === 'string'
      ? doc.slug
      : typeof doc.nameStem === 'string'
        ? doc.nameStem
        : typeof doc.email === 'string'
          ? doc.email
          : '—';
  const status = typeof doc.status === 'string' ? ` [${doc.status}]` : '';
  return `#${String(doc.id)} ${label}${status}`;
}

/**
 * Доказательство, что фильтр отбирает ровно записи харнесса.
 *
 * Печатает обе части выборки и останавливает уборку, если маркер отобрал
 * подозрительно большую долю таблицы. Если маркер однажды начнёт задевать
 * реальный контент, это увидит человек, а не узнает после удаления.
 */
function report(what: string, docs: readonly Doc[]): readonly Doc[] {
  const harness = docs.filter(marked);
  const real = docs.filter((doc) => !marked(doc));
  console.log(
    `${what}: всего ${String(docs.length)}, харнесса ${String(harness.length)}, ` +
      `реальных ${String(real.length)}`,
  );
  if (docs.length > 0 && harness.length / docs.length > MAX_HARNESS_SHARE) {
    throw new Error(
      `${what}: маркер харнесса отобрал ${String(harness.length)} из ${String(docs.length)} ` +
        'записей — больше половины таблицы. Так выглядит маркер, задевающий реальный ' +
        'контент; уборка остановлена.',
    );
  }
  const published = harness.filter((doc) => doc.status === 'published');
  if (published.length > 0) {
    console.log(`  из них published: ${published.map(describe).join(', ')}`);
  }
  for (const doc of harness) {
    console.log(`  к удалению: ${describe(doc)}`);
  }
  console.log(`  примеры реальных (не тронутся): ${real.slice(0, 3).map(describe).join(', ')}`);
  return harness;
}

/**
 * Глубина пути подборки: удалять нужно от листьев, иначе `beforeDelete`
 * подборки справедливо откажет — у узла есть потомки.
 */
function depthOf(doc: Doc): number {
  return typeof doc.path === 'string' ? doc.path.split('/').length : 0;
}

async function countRows(payload: Payload, sql: string): Promise<number> {
  const pool = (payload.db as unknown as {
    pool: {
      query: <R extends Record<string, unknown>>(sql: string) => Promise<{ rows: R[] }>;
    };
  }).pool;
  const { rows } = await pool.query<{ count: string }>(sql);
  return Number(rows.at(0)?.count ?? '0');
}

const SERVICE_TABLES: readonly { readonly sql: string; readonly what: string }[] = [
  {
    sql: `from content_path_claims where path ~ ${SQL_PATH_MARKER}`,
    what: 'content_path_claims',
  },
  { sql: `from image_name_claims where stem ~ ${SQL_IMAGE_MARKER}`, what: 'image_name_claims' },
  { sql: `from seo_history where document_path ~ ${SQL_PATH_MARKER}`, what: 'seo_history' },
];

async function reportServiceTables(payload: Payload): Promise<void> {
  for (const table of SERVICE_TABLES) {
    const harness = await countRows(payload, `select count(*) ${table.sql}`);
    const total = await countRows(payload, `select count(*) from ${table.what}`);
    console.log(
      `${table.what}: всего ${String(total)}, харнесса ${String(harness)}, ` +
        `реальных ${String(total - harness)}`,
    );
  }
}

export async function runCleanup(payload: Payload, mode: CleanupMode): Promise<void> {
  console.log(`=== ДО (${mode}) ===`);
  const cards = report('cards', await readAll(payload, 'cards'));
  const collections = report('collections', await readAll(payload, 'collections'));
  const images = report('card-images', await readAll(payload, 'card-images'));
  const users = report('users', await readAll(payload, 'users'));
  await reportServiceTables(payload);

  if (mode === 'dry-run') {
    console.log('DRY RUN: ничего не удалено. Для применения повторите с --apply.');
    return;
  }

  // Карточки первыми: они ссылаются на изображения, а опубликованную запись
  // поштучно удалять правила разрешают (см. `assertBulkDeleteAllowed` — запрет
  // касается ПАКЕТНОГО удаления по условию, где решение о судьбе URL нельзя
  // принять по каждому адресу).
  for (const doc of cards) {
    await payload.delete({ collection: 'cards', id: doc.id, overrideAccess: true });
  }
  for (const doc of [...collections].sort((a, b) => depthOf(b) - depthOf(a))) {
    await payload.delete({ collection: 'collections', id: doc.id, overrideAccess: true });
  }
  for (const doc of images) {
    await payload.delete({ collection: 'card-images', id: doc.id, overrideAccess: true });
  }

  // Реестры и журнал не трогаются (см. шапку). Аккаунты прогонов последними:
  // это действующие API-ключи, то есть доступ, а не мусор в таблице. Их записи
  // в `seo_history` остаются, связь с автором обнулится (`ON DELETE SET NULL`),
  // роль автора в журнале хранится отдельным полем и сохраняется.
  for (const doc of users) {
    await payload.delete({ collection: 'users', id: doc.id, overrideAccess: true });
  }

  console.log('=== ПОСЛЕ ===');
  report('cards', await readAll(payload, 'cards'));
  report('collections', await readAll(payload, 'collections'));
  report('card-images', await readAll(payload, 'card-images'));
  report('users', await readAll(payload, 'users'));
  await reportServiceTables(payload);
}

// `payload run` исполняет модуль напрямую; в тестовом процессе конфиг и база не
// поднимаются. Разбор аргументов вынесен в `src/scripts/cleanup-mode.ts` и
// покрыт тестом там.
if (process.env.VITEST !== 'true') {
  const [{ getPayload }, { default: config }] = await Promise.all([
    import('payload'),
    import('../src/payload.config'),
  ]);
  const payload = await getPayload({ config });
  await runCleanup(payload, cleanupMode(process.argv.slice(2)));
  process.exit(0);
}
