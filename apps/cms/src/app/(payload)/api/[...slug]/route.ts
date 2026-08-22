/**
 * REST API Payload. Отдельный API-слой не пишется намеренно: правила проекта
 * живут в access control и хуках конфига, поэтому действуют и здесь.
 *
 * Состав файла задан Payload 3.
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

export const DELETE = REST_DELETE(config);
export const GET = REST_GET(config);
export const OPTIONS = REST_OPTIONS(config);
export const PATCH = REST_PATCH(config);
export const POST = REST_POST(config);
export const PUT = REST_PUT(config);
