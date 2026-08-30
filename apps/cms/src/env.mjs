/**
 * Слой окружения Payload CMS (задача Э1-02).
 *
 * Файл намеренно остаётся ПЛОСКИМ JavaScript, а не TypeScript: его импортирует
 * `next.config.mjs`, который выполняется до какой-либо TypeScript-компиляции.
 * Тот же приём и по той же причине применяет сам Payload в
 * `@payloadcms/next/withPayload`. Иначе правило разбора `PAYLOAD_ADMIN_PATH`
 * пришлось бы написать дважды — в конфиге Next и в конфиге Payload, — и две
 * копии со временем разошлись бы.
 *
 * Что здесь есть и почему:
 *   - `loadEnvFiles()` — единственный `.env` на монорепозиторий лежит в корне
 *     (шаблон — `.env.example`). Next сам поднимает только `apps/cms/.env`, а
 *     CLI Payload ищет вверх по дереву: поведение разное, поэтому загрузка
 *     делается явно и одинаково для обоих входов.
 *   - `resolveAdminPath()` — путь админки берётся из env, а не хардкодится: на
 *     это значение опирается реестр зарезервированных маршрутов в
 *     `packages/shared` и генерация robots.txt. Сам РАЗБОР значения живёт в
 *     `packages/shared` (`parseAdminPath`) и вызывается отсюда: два разбора
 *     одного параметра уже разошлись однажды.
 *   - `adminPathRewrites()` — Payload 3 привязывает админку к ФИЗИЧЕСКОМУ
 *     каталогу `src/app/(payload)/admin/[[...segments]]`, а `routes.admin`
 *     влияет только на генерацию ссылок. Без переписывания запросов
 *     нестандартный `PAYLOAD_ADMIN_PATH` дал бы админку, все ссылки которой
 *     ведут в 404.
 *
 * Секретов в файле нет и быть не может: значения приходят только из окружения.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAdminPath } from '@otkritka/shared';

/**
 * Значение `PAYLOAD_ADMIN_PATH`, которое лежит в `.env.example`.
 *
 * Это НЕ значение по умолчанию: в коде дефолта нет (см. `resolveAdminPath`).
 * Константа существует только для теста «значение из шаблона проходит
 * валидацию» — иначе шаблон и код могли бы разойтись незамеченными.
 */
export const ENV_EXAMPLE_ADMIN_PATH = '/admin';

/**
 * Физический маршрут Next, по которому реально живёт админка Payload.
 * Меняется только вместе с каталогом `src/app/(payload)/admin`.
 */
export const PHYSICAL_ADMIN_PATH = '/admin';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Каталог монорепозитория: ищется вверх по дереву по `pnpm-workspace.yaml`.
 * Привязки к глубине вложенности нет — переезд каталога приложения не ломает
 * загрузку `.env`.
 *
 * @returns {string | null}
 */
function findWorkspaceRoot() {
  let dir = moduleDir;
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * Каталог монорепозитория как обязательное значение.
 *
 * Нужен там, где путь задаётся относительным значением окружения (корни
 * хранилища изображений, задача Э2-04): разрешать такие пути от `process.cwd()`
 * нельзя — у CMS два входа (`next dev` из `apps/cms` и `payload run` оттуда же,
 * но скрипты и тесты запускаются из корня), и одно значение дало бы два разных
 * дерева файлов.
 *
 * @returns {string}
 */
export function workspaceRoot() {
  const root = findWorkspaceRoot();
  if (!root) {
    throw new Error(
      'Не найден корень монорепозитория: вверх по дереву от apps/cms нет ни одного ' +
        'pnpm-workspace.yaml. Относительные пути из окружения разрешать не от чего.',
    );
  }
  return root;
}

let envLoaded = false;

/**
 * Загружает корневой `.env` в `process.env`. Идемпотентна.
 *
 * `process.loadEnvFile` (Node >= 22) НЕ перезаписывает уже заданные
 * переменные — значения из настоящего окружения (CI, docker, shell)
 * приоритетнее файла. Отсутствие файла ошибкой не является: на CI и в
 * production переменные приходят из окружения, а не из файла.
 *
 * @returns {void}
 */
export function loadEnvFiles() {
  if (envLoaded) {
    return;
  }
  envLoaded = true;

  const root = findWorkspaceRoot();
  if (!root) {
    return;
  }
  const envFile = path.join(root, '.env');
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
}

/**
 * Обязательная переменная окружения. Пустое значение — ошибка запуска, а не
 * повод подставить дефолт: Payload с пустым секретом поднимается и молча выдаёт
 * нерабочие сессии, а с пустой строкой подключения падает уже в рантайме, на
 * первом запросе редактора.
 *
 * @param {string} name
 * @param {Record<string, string | undefined>} [source] срез окружения; аргумент
 *   существует, чтобы тест не мутировал `process.env`
 * @returns {string}
 */
export function requireEnv(name, source) {
  const env = source ?? process.env;
  const raw = env[name];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(
      `Переменная окружения ${name} не задана. Заполните её в .env ` +
        '(шаблон — .env.example в корне репозитория). ' +
        'Значения по умолчанию для этого параметра в коде запрещены.',
    );
  }
  return raw.trim();
}

/**
 * Название параметра, которым включается и выключается авто-накат схемы в БД.
 *
 * Это НЕ значение по умолчанию для пути или хоста — это выключатель поведения
 * самого адаптера, и дефолт у него есть намеренно (см. {@link databasePush}).
 */
export const DB_PUSH_ENV_KEY = 'PAYLOAD_DB_PUSH';

/**
 * Накатывать ли схему в БД при подключении (`push` адаптера Postgres).
 *
 * ЗАЧЕМ ПАРАМЕТР. При `push` не равном `false` Payload в неproduction-окружении
 * зовёт `pushDevSchema`, а тот подтягивает `drizzle-kit/api` (проверено по
 * `@payloadcms/db-postgres/dist/connect.js`). Из процесса CMS модуль
 * разрешается, из СОБРАННОГО сервера `apps/web` — нет: тот же конфиг Payload
 * поднимается там через Local API, и первый запрос к базе падает с
 * `Cannot find module 'drizzle-kit/api'`. Найдено `url-guard` на стенде,
 * поднятом не через смоук.
 *
 * ПОЧЕМУ ДЕФОЛТ — «накатывать». Миграций в проекте пока нет, и авто-накат это
 * единственный способ, которым база получает таблицы: выключить его по
 * умолчанию значило бы сломать и `pnpm dev`, и все смоуки. Поэтому дефолт
 * сохраняет текущее поведение, а стенд, поднимающий собранный `apps/web` без
 * `NODE_ENV=production`, ставит `PAYLOAD_DB_PUSH=false` и получает внятную
 * работу вместо падения на первом запросе.
 *
 * Переход на миграции (и вместе с ним смена дефолта на «не накатывать») — задача
 * этапа 7, а не побочный эффект этой правки.
 *
 * @param {Record<string, string | undefined>} [source] срез окружения
 * @returns {boolean}
 */
export function databasePush(source) {
  const env = source ?? process.env;
  const raw = env[DB_PUSH_ENV_KEY];
  if (typeof raw !== 'string' || raw.trim() === '') {
    return true;
  }
  const value = raw.trim().toLowerCase();
  if (value === 'false' || value === '0' || value === 'off') {
    return false;
  }
  if (value === 'true' || value === '1' || value === 'on') {
    return true;
  }
  throw new Error(
    `Переменная окружения ${DB_PUSH_ENV_KEY} принимает только true/false ` +
      `(допустимы 1/0, on/off), получено: «${raw}». Непонятное значение не трактуется ` +
      'как «накатывать»: тогда опечатка молча включала бы правку схемы БД.',
  );
}

/**
 * Разбирает и нормализует путь админки.
 *
 * Тело функции — ОДИН вызов `parseAdminPath` из `@otkritka/shared`, и это
 * принципиально. Раньше правила разбора были написаны здесь заново «по образцу»
 * реестра зарезервированных маршрутов, и копии успели разойтись: сегмент
 * пагинации отклоняла только эта (находка ревизии от 2026-08-22). Из одного
 * значения выводятся два адреса одного и того же — путь, который обслуживает
 * Next, и запись резерва, — поэтому разбор обязан быть один. Обёртка остаётся,
 * потому что `next.config.mjs` зовёт её до какой-либо TypeScript-компиляции, и
 * потому что имя параметра `PAYLOAD_ADMIN_PATH` привязано именно к слою
 * окружения.
 *
 * Значения по умолчанию НЕТ намеренно: дефолт означал бы, что при незаданной
 * переменной CMS обслуживает один путь, а реестр резервирует другой.
 *
 * @param {string | undefined} raw значение `PAYLOAD_ADMIN_PATH`
 * @returns {string} путь от корня без завершающего слеша
 */
export function resolveAdminPath(raw) {
  return parseAdminPath(raw);
}

/**
 * Путь админки из окружения. Побочно подгружает корневой `.env`.
 *
 * @returns {string}
 */
export function adminPath() {
  loadEnvFiles();
  return resolveAdminPath(process.env.PAYLOAD_ADMIN_PATH);
}

/**
 * @typedef {{ destination: string, source: string }} AdminRewrite
 * @typedef {{ destination: string, permanent: boolean, source: string }} AdminRedirect
 * @typedef {{ redirects: AdminRedirect[], rewrites: AdminRewrite[] }} AdminRouting
 */

/**
 * Правила Next, связывающие настроенный путь админки с её физическим маршрутом.
 *
 * Порядок обработки в Next: `redirects` → `rewrites.beforeFiles` → файловые
 * маршруты. Результат rewrite повторно через `redirects` НЕ проходит, поэтому
 * пара «redirect с /admin» + «rewrite на /admin» петли не образует.
 *
 * `permanent: false` (307) выбран намеренно: это маршрут админки, а не страница
 * сайта. 301 браузеры и краулеры кешируют надолго, и последующая смена
 * `PAYLOAD_ADMIN_PATH` осталась бы незаметной для тех, кто уже заходил. Правило
 * «одиночный 301» из CLAUDE.md относится к индексируемым страницам сайта;
 * админка не индексируется никогда.
 *
 * @param {string} configuredAdminPath результат {@link resolveAdminPath}
 * @returns {AdminRouting}
 */
export function adminPathRewrites(configuredAdminPath) {
  if (configuredAdminPath === PHYSICAL_ADMIN_PATH) {
    return { redirects: [], rewrites: [] };
  }

  return {
    redirects: [
      {
        destination: `${configuredAdminPath}/:segments*`,
        permanent: false,
        source: `${PHYSICAL_ADMIN_PATH}/:segments*`,
      },
    ],
    rewrites: [
      {
        destination: `${PHYSICAL_ADMIN_PATH}/:segments*`,
        source: `${configuredAdminPath}/:segments*`,
      },
    ],
  };
}
