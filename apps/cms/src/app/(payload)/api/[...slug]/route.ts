/**
 * REST API Payload. Отдельный API-слой не пишется намеренно: правила проекта
 * живут в access control и хуках конфига, поэтому действуют и здесь.
 *
 * Состав файла задан Payload 3. Единственная добавка — `withApiRateLimit`
 * (задача Э6-03, решение Ч-14): ограничение частоты на API-ключ обязано стоять
 * на ВХОДЕ в Payload, до аутентификации и до разбора тела. Правило транспортное,
 * а не правило коллекции, поэтому в хуках его нет и быть не должно: хуки
 * выполняются и на Local API, то есть на каждом обращении рендера apps/web к
 * базе, и ограничение считало бы запросы собственного сайта. Разбор выбора — в
 * `src/http/api-rate-limit.ts`.
 */
import config from '@payload-config';
import {
  REST_DELETE,
  REST_GET,
  REST_OPTIONS,
  REST_PATCH,
  REST_POST,
  REST_PUT,
} from '@payloadcms/next/routes';

import { withApiRateLimit } from '../../../../http/api-rate-limit';

export const DELETE = withApiRateLimit(REST_DELETE(config));
export const GET = withApiRateLimit(REST_GET(config));
export const OPTIONS = withApiRateLimit(REST_OPTIONS(config));
export const PATCH = withApiRateLimit(REST_PATCH(config));
export const POST = withApiRateLimit(REST_POST(config));
export const PUT = withApiRateLimit(REST_PUT(config));
