import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { postgresAdapter } from '@payloadcms/db-postgres';
import { lexicalEditor } from '@payloadcms/richtext-lexical';
import { buildConfig } from 'payload';

import { Cards } from './collections/cards';
import { Redirects } from './collections/redirects';
import { Users } from './collections/users';
import { adminPath, loadEnvFiles, requireEnv } from './env.mjs';
import { seedFirstAdmin } from './seed-first-admin';

/**
 * Конфигурация Payload CMS (задача Э1-02, bootstrap).
 *
 * Отдельный API-слой не пишется: Payload сам отдаёт REST и GraphQL для всех
 * коллекций. Поэтому любое защитное правило проекта обязано жить в серверных
 * хуках и access control этого конфига — правило, реализованное в клиенте
 * админки, внешний AI-редактор обходит через API.
 *
 * Что здесь ЕСТЬ: подключение к PostgreSQL, секрет, путь админки из окружения,
 * создание первого администратора и коллекции `users` (Э1-03), `cards` (Э1-04),
 * `redirects` (Э1-06).
 *
 * Чего здесь НЕТ (отдельные задачи): коллекции `collections` (Э1-05) и
 * `seo-history` (Э1-07), хуки статусной модели (Э1-08) и неизменяемость slug
 * (Э1-09). Из этого следует практическое ограничение: у карточки пока нет ни
 * связи с подборками, ни атрибутов (повод, адресат, стиль, настроение) — по
 * ТЗ §5.4 это ссылки на подборки, то есть связь с коллекцией из Э1-05.
 */

loadEnvFiles();

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default buildConfig({
  admin: {
    importMap: {
      // Физический каталог маршрута админки — всегда `admin`, каким бы ни был
      // PAYLOAD_ADMIN_PATH (см. src/env.mjs). Автоопределение Payload ищет
      // каталог по значению routes.admin и при нестандартном пути не находит
      // ничего, поэтому путь задан явно.
      importMapFile: path.resolve(dirname, 'app/(payload)/admin/importMap.js'),
    },
    user: Users.slug,
  },

  // Порядок влияет только на меню админки: сверху то, с чем работают чаще.
  collections: [Cards, Redirects, Users],

  db: postgresAdapter({
    pool: {
      connectionString: requireEnv('DATABASE_URL'),
    },
  }),

  // Редактор объявлен явно: без него Payload не собирает текстовые поля, а
  // коллекции контента (Э1-04, Э1-05) состоят из них целиком.
  editor: lexicalEditor(),

  onInit: seedFirstAdmin,

  routes: {
    // Путь админки — параметр окружения, а не константа: то же значение вносит
    // админку в реестр зарезервированных маршрутов (packages/shared) и влияет
    // на robots.txt. Дефолта в коде нет намеренно — см. src/env.mjs.
    admin: adminPath(),
  },

  secret: requireEnv('PAYLOAD_SECRET'),

  // serverURL не задаётся сознательно: абсолютный URL сайта собирается
  // ЕДИНСТВЕННЫМ хелпером из SITE_URL (packages/shared), а админка живёт по
  // относительным путям. Второй источник хоста здесь означал бы, что canonical
  // и ссылки админки могут разойтись.

  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
});
