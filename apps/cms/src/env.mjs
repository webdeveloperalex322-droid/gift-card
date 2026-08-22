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
 *     `packages/shared` и генерация robots.txt.
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

import { PAGINATION_SEGMENT, isValidSlug } from '@otkritka/shared';

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
 * @param {string} value
 * @param {string} reason
 * @returns {never}
 */
function rejectAdminPath(value, reason) {
  throw new Error(
    `PAYLOAD_ADMIN_PATH задан некорректно: «${value}» — ${reason}. ` +
      'Ожидается путь из сегментов [a-z0-9-], например /admin или /cms/upravlenie. ' +
      'Дефолта у этого параметра нет: путь админки участвует в реестре ' +
      'зарезервированных маршрутов (packages/shared), и подстановка дефолта ' +
      'зарезервировала бы не тот путь, что обслуживает CMS.',
  );
}

/**
 * Разбирает и нормализует путь админки.
 *
 * Значения по умолчанию НЕТ намеренно — ровно как у `resolveAdminRoute` в
 * `packages/shared/src/reserved-routes.ts`. Дефолт здесь означал бы, что при
 * незаданной переменной CMS обслуживает `/admin`, а реестр отказывает (или
 * резервирует другой путь): рассинхронизация двух источников одного адреса.
 * Правила нормализации повторяют реестр буквально — та функция в
 * `packages/shared` не экспортируется; вынести её в общий пакет и убрать это
 * повторение стоит владельцу `packages/shared` (см. отчёт Э1-02).
 *
 * @param {string | undefined} raw значение `PAYLOAD_ADMIN_PATH`
 * @returns {string} путь от корня без завершающего слеша
 */
export function resolveAdminPath(raw) {
  const trimmed = (raw ?? '').trim();

  if (trimmed === '') {
    throw new Error(
      'PAYLOAD_ADMIN_PATH не задан, поэтому путь админки неизвестен. Значения по ' +
        'умолчанию у него нет намеренно: тот же параметр вносит путь админки в ' +
        'реестр зарезервированных маршрутов (packages/shared), и дефолт в одном из ' +
        'двух мест развёл бы реальный адрес админки с зарезервированным. ' +
        'Заполните .env по шаблону .env.example.',
    );
  }

  if (trimmed.includes('?') || trimmed.includes('#')) {
    rejectAdminPath(trimmed, 'путь не может содержать параметров и фрагмента');
  }

  const segments = trimmed.split('/').filter((segment) => segment !== '');

  if (segments.length === 0) {
    rejectAdminPath(trimmed, 'админка не может занимать корень сайта');
  }

  for (const segment of segments) {
    if (segment === PAGINATION_SEGMENT) {
      rejectAdminPath(
        trimmed,
        `сегмент «${PAGINATION_SEGMENT}» зарезервирован под пагинацию /${PAGINATION_SEGMENT}/N`,
      );
    }
    if (!isValidSlug(segment)) {
      rejectAdminPath(trimmed, `сегмент «${segment}» не проходит правила slug`);
    }
  }

  return `/${segments.join('/')}`;
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
