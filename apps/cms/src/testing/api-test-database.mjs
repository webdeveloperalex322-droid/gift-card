/**
 * ОТДЕЛЬНАЯ БАЗА живых API-тестов (решение человека 2026-09-03).
 *
 * ЧТО РЕШЕНО И ПОЧЕМУ ИМЕННО ТАК. Фикстура Э6-02 обязана доводить карточку и
 * подборку до `published` — половина негативных сценариев проверяет поведение
 * ИМЕННО опубликованной записи (неизменяемый slug, запрет замены изображения,
 * запрет снятия с публикации сервисным аккаунтом). Значит, «просто не
 * публиковать» не годится: это снимает проверку, а не защищает базу. Но и
 * публиковать в КОНТЕНТНУЮ базу нельзя: замер 2026-09-03 показал, что
 * накопилось 5 карточек харнесса (4 из них `published`, они попадали в живой
 * каталог и попали бы в sitemap после открытия каталога в индекс), 13 подборок,
 * 9 изображений, 8 живых аккаунтов с API-ключами, 850 строк
 * `content_path_claims` из 1895 и 123 строки `seo-history`.
 *
 * Уборка «создал — удалил» в наборе БЫЛА и всё это накопила. Причина не в
 * забытом вызове: уборка живёт в `afterAll`, а он не выполняется, если прогон
 * оборвали (Ctrl+C, падение в `beforeAll` посреди создания фикстуры, обрыв
 * форка по таймауту). Опубликованная запись при этом остаётся в базе, из
 * которой сайт рендерит каталог и собирает sitemap. Механизм, который зависит
 * от того, ДОШЁЛ ли прогон до конца, для этого требования не подходит.
 *
 * Поэтому выбран ТРЕТИЙ вариант из названных человеком: отдельная база.
 * Опубликованное состояние существует целиком и настоящим образом — но в базе
 * `<контентная>_api_tests`, которую харнесс создаёт сам и КАЖДЫЙ прогон
 * начинает с чистой схемы. Запись, которой в контентной базе нет, надёжнее
 * записи, которую после прогона удаляют.
 *
 * ЧЕМ ЭТО СТОИЛО. Замерено на этой машине: полный накат схемы в пустую базу —
 * 3,0 с, повторный накат без изменений — 1,2 с, `DROP SCHEMA` + накат — 2,0 с.
 * То есть цена решения — около двух секунд на `pnpm test`; ради этого снимается
 * весь класс «тестовые записи в живом каталоге».
 *
 * ПОЧЕМУ СХЕМА СБРАСЫВАЕТСЯ ПЕРЕД КАЖДЫМ ПРОГОНОМ, А НЕ НАКАПЛИВАЕТСЯ. Накат
 * (`push` адаптера) на НЕПУСТОЙ базе, схема которой разошлась с кодом, задаёт
 * интерактивный вопрос про возможную потерю данных (`prompts` в
 * `@payloadcms/drizzle/pushDevSchema`) — в неинтерактивном прогоне это выглядит
 * как зависший тест. На пустой схеме вопрос не возникает никогда: сносить нечего.
 * Заодно прогон становится воспроизводимым: он не зависит от того, что оставил
 * предыдущий.
 *
 * ПОЧЕМУ ЭТОТ ФАЙЛ — ПЛОСКИЙ JS. Ему нужен пакет `pg` напрямую (создать базу и
 * сбросить схему нужно ДО того, как поднимется Payload), а `@types/pg` в
 * зависимостях `apps/cms` нет — тянуть его ради теста дороже, чем написать
 * бутстрап так же, как написан `src/env.mjs`, и по той же причине.
 *
 * СЕКРЕТОВ ЗДЕСЬ НЕТ: и хост, и пароль, и имя контентной базы приходят из
 * `DATABASE_URL`. Имя тестовой базы выводится из него суффиксом.
 */

import { rm } from 'node:fs/promises';
import path from 'node:path';

import pg from 'pg';

import { loadEnvFiles, requireEnv, workspaceRoot } from '../env.mjs';

/** Служебная база, из которой выполняется `CREATE DATABASE`. */
const MAINTENANCE_DATABASE = 'postgres';

/** Суффикс имени тестовой базы. Меняется только вместе с этим комментарием. */
export const API_TEST_DATABASE_SUFFIX = '_api_tests';

/**
 * Корни хранилища изображений на время прогона.
 *
 * Фикстура загружает настоящие PNG и получает настоящие производные. Писать их
 * в `media/` и `uploads/` рабочей машины нельзя по той же причине, по которой
 * записи не пишутся в контентную базу: файлы прогона оказывались бы в дереве,
 * которое сайт отдаёт по `/media/...`. Пути относительные — они разрешаются от
 * корня монорепозитория (см. `workspaceRoot`), а `.local/` уже в `.gitignore`.
 */
const TEST_IMAGE_ROOTS = {
  IMAGE_STORAGE_DERIVATIVES_ROOT: '.local/api-tests/media',
  IMAGE_STORAGE_ORIGINALS_ROOT: '.local/api-tests/uploads',
};

/**
 * Имя базы из строки подключения.
 *
 * @param {string} url
 * @returns {string}
 */
export function databaseNameOf(url) {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (name === '') {
    throw new Error(
      'DATABASE_URL не содержит имени базы: ожидается ' +
        'postgres://<user>:<password>@<host>:<port>/<database>. Без имени базы ' +
        'тестовую базу вывести не из чего, а угадывать её нельзя: промах означает ' +
        'запись тестовых данных в чужую базу.',
    );
  }
  return name;
}

/**
 * Строка подключения к КОНТЕНТНОЙ базе — той, из которой сайт рендерит каталог.
 * Живые API-тесты в неё не пишут; значение нужно только проверке остатков.
 *
 * @returns {string}
 */
export function contentDatabaseUrl() {
  loadEnvFiles();
  return requireEnv('DATABASE_URL');
}

/**
 * Строка подключения к базе живых API-тестов.
 *
 * @returns {string}
 */
export function apiTestDatabaseUrl() {
  const url = new URL(contentDatabaseUrl());
  const name = databaseNameOf(url.toString());
  url.pathname = `/${encodeURIComponent(`${name}${API_TEST_DATABASE_SUFFIX}`)}`;
  return url.toString();
}

/**
 * @param {string} url
 * @returns {string}
 */
function maintenanceUrlFor(url) {
  const maintenance = new URL(url);
  maintenance.pathname = `/${MAINTENANCE_DATABASE}`;
  return maintenance.toString();
}

/**
 * @param {string} url
 * @param {(client: import('pg').Client) => Promise<void>} run
 * @returns {Promise<void>}
 */
async function withClient(url, run) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await run(client);
  } finally {
    await client.end();
  }
}

/**
 * Создаёт тестовую базу, если её нет.
 *
 * ПОЧЕМУ НЕ ПОЛАГАЕМСЯ НА АДАПТЕР. У Payload есть автосоздание отсутствующей
 * базы, но оно опознаёт ошибку по английскому тексту
 * (`/database .* does not exist/i` в `@payloadcms/db-postgres/connect`), а на
 * русской локали сервера сообщение другое — проверено на этой машине: адаптер
 * просто падает. Создание базы поэтому делается явно, тем же способом, что в
 * `scripts/ensure-database.mjs`.
 *
 * @param {string} name
 * @param {string} url
 * @returns {Promise<void>}
 */
async function createDatabaseIfMissing(name, url) {
  await withClient(maintenanceUrlFor(url), async (client) => {
    const { rows } = await client.query('select 1 from pg_database where datname = $1', [name]);
    if (rows.length > 0) {
      return;
    }
    // Имя базы нельзя передать параметром: CREATE DATABASE не принимает
    // placeholder'ов. Идентификатор экранируется вручную.
    await client.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
  });
}

/**
 * Сносит схему тестовой базы целиком.
 *
 * @param {string} url
 * @returns {Promise<void>}
 */
async function resetSchema(url) {
  await withClient(url, async (client) => {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  });
}

/**
 * Ключ памятки о готовности базы.
 *
 * Хранится на `globalThis`, а не в переменной модуля, СОЗНАТЕЛЬНО: Vitest может
 * переоценивать модули для каждого файла набора в одном и том же процессе, и
 * тогда переменная модуля обнулилась бы, а `DROP SCHEMA` выполнился бы посреди
 * прогона — под уже поднятым Payload. `globalThis` живёт столько же, сколько
 * процесс, то есть ровно один прогон.
 */
const READY = Symbol.for('otkritka.api-test-database.ready');

/**
 * Готовит базу живых API-тестов: создаёт её при отсутствии, сбрасывает схему и
 * уводит хранилище изображений в отдельное дерево. Выполняется один раз на
 * процесс.
 *
 * @returns {Promise<{ contentDatabase: string, testDatabase: string, url: string }>}
 */
export async function ensureApiTestDatabase() {
  const store = /** @type {Record<symbol, unknown>} */ (globalThis);
  const existing = store[READY];
  if (existing) {
    return /** @type {Promise<{ contentDatabase: string, testDatabase: string, url: string }>} */ (
      existing
    );
  }

  const prepared = prepareApiTestDatabase();
  store[READY] = prepared;
  return prepared;
}

/**
 * @returns {Promise<{ contentDatabase: string, testDatabase: string, url: string }>}
 */
async function prepareApiTestDatabase() {
  const contentUrl = contentDatabaseUrl();
  const contentDatabase = databaseNameOf(contentUrl);
  const url = apiTestDatabaseUrl();
  const testDatabase = databaseNameOf(url);

  if (testDatabase === contentDatabase) {
    throw new Error(
      `Имя тестовой базы совпало с контентной (${contentDatabase}). Живые API-тесты ` +
        'публикуют записи по-настоящему, и в контентной базе им делать нечего: ' +
        'опубликованная запись прогона попадает в каталог и в sitemap. Прогон остановлен.',
    );
  }

  await createDatabaseIfMissing(testDatabase, url);
  await resetSchema(url);

  // Дерево файлов прогона сносится вместе со схемой: производные без записей —
  // мусор, а несовпадение «запись есть, файла нет» уже однажды дало битые
  // ссылки в обходе внутренних ссылок.
  await rm(path.resolve(workspaceRoot(), '.local/api-tests'), { force: true, recursive: true });

  for (const [key, value] of Object.entries(TEST_IMAGE_ROOTS)) {
    process.env[key] = value;
  }

  return { contentDatabase, testDatabase, url };
}

/**
 * Читает КОНТЕНТНУЮ базу напрямую, минуя Payload.
 *
 * Нужна ровно одному потребителю — проверке «после прогона в контентной базе не
 * осталось записей харнесса». Через Payload её не сделать: экземпляр Payload в
 * этом процессе подключён к тестовой базе, и вопрос «что лежит в контентной»
 * ему задать нельзя.
 *
 * Возвращает строки как `unknown`: разбор ответа делает вызывающий на
 * TypeScript, с явными проверками. Тип `QueryResultRow` у `pg` — индексная
 * подпись `any`, и он протащил бы `any` в типизированный код.
 *
 * @param {string} sql
 * @returns {Promise<unknown[]>}
 */
export async function queryContentDatabase(sql) {
  /** @type {unknown[]} */
  let rows = [];
  await withClient(contentDatabaseUrl(), async (client) => {
    const result = await client.query(sql);
    rows = result.rows;
  });
  return rows;
}
