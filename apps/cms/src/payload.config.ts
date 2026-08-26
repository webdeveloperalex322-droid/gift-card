import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { postgresAdapter } from '@payloadcms/db-postgres';
import { lexicalEditor } from '@payloadcms/richtext-lexical';
import { buildConfig } from 'payload';

import { reservedRoutes } from '@otkritka/shared';

import { CardImages } from './collections/card-images';
import { Cards } from './collections/cards';
import { Collections } from './collections/collections';
import { ImageNameClaims } from './collections/image-name-claims';
import { Redirects } from './collections/redirects';
import { SeoHistory } from './collections/seo-history';
import { Users } from './collections/users';
import { adminPath, databasePush, loadEnvFiles, requireEnv } from './env.mjs';
import { SiteSettings } from './globals/site-settings';
import { MAX_UPLOAD_BYTES } from './images/upload-validation';
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
 * `collections` (Э1-05), `redirects` (Э1-06), `seo-history` (Э1-07),
 * `card-images` и `image-name-claims` (Э2-04).
 *
 * Про изображения здесь ровно два решения, остальное — в самих коллекциях:
 * предел размера тела запроса (иначе многогигабайтный файл читался бы в память
 * до первой проверки) и отсутствие `sharp` в конфиге. Второе — сознательно:
 * встроенные преобразования Payload (`imageSizes`, кроп, фокальная точка) не
 * используются, производные считает `@otkritka/images`, а два независимых
 * пайплайна давали бы два разных набора файлов для одного изображения.
 *
 * Хуки статусной модели (Э1-08) и неизменяемости URL (Э1-09) живут в самих
 * коллекциях: конфиг о них не знает и знать не должен — правило принадлежит
 * коллекции, а не точке сборки.
 */

loadEnvFiles();

/**
 * Реестр зарезервированных маршрутов собирается ПРИ СТАРТЕ, а не при первой
 * записи.
 *
 * `reservedRoutes` бросает, если `PAYLOAD_ADMIN_PATH` спорит с наполнением
 * реестра (совпадает с контейнером или поглощает служебный маршрут). Такая
 * конфигурация нерабочая целиком: админка и часть путей сайта претендуют на один
 * префикс. Поймать это на первой попытке сохранить подборку — значит узнать об
 * ошибке развёртывания из формы редактора; поэтому CMS не поднимается вовсе, и
 * с тем же самым текстом ошибки.
 */
reservedRoutes();

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
  collections: [Cards, Collections, CardImages, Redirects, SeoHistory, ImageNameClaims, Users],

  db: postgresAdapter({
    pool: {
      connectionString: requireEnv('DATABASE_URL'),
    },
    // Авто-накат схемы — ПАРАМЕТР, а не поведение по умолчанию адаптера. При
    // незаданном `push` Payload в неproduction-окружении зовёт `pushDevSchema`, а
    // тот подтягивает `drizzle-kit/api`; из собранного сервера `apps/web`, где
    // этот же конфиг поднимается через Local API, модуль не разрешается, и первый
    // запрос к базе падает с `Cannot find module 'drizzle-kit/api'`. Значение по
    // умолчанию оставлено «накатывать» (миграций в проекте пока нет — этап 7),
    // выключается `PAYLOAD_DB_PUSH=false`. Подробности — в src/env.mjs.
    push: databasePush(),
  }),

  // Редактор объявлен явно: без него Payload не собирает текстовые поля, а
  // коллекции контента (Э1-04, Э1-05) состоят из них целиком.
  editor: lexicalEditor(),

  // Глобалы. «Настройки сайта» (Э3-00) — единственное место, где живут значения,
  // вынесенные решениями человека из кода в админку: данные организации (Ч-17),
  // лицензия изображений (Ч-10), тексты служебных страниц (Ч-19) и рекламные
  // места (Ч-11). Все поля пустые по умолчанию: пустое поле — команда шаблону
  // промолчать, а не повод подставить правдоподобную заглушку.
  globals: [SiteSettings],

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

  upload: {
    limits: {
      // Тот же предел, что проверяет хук загрузки. Здесь он режет тело запроса
      // ДО чтения файла в память, поэтому значение обязано совпадать: два
      // разных предела дали бы либо необъяснимый обрыв загрузки, либо проверку,
      // до которой дело не доходит.
      fileSize: MAX_UPLOAD_BYTES,
    },
  },

  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
});
