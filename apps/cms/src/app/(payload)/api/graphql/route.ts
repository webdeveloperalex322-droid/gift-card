/**
 * GraphQL API Payload. Состав файла задан Payload 3.
 *
 * Обёртка `withApiRateLimit` (Э6-03, Ч-14) стоит здесь по той же причине, что и
 * на REST и на песочнице (`../graphql-playground/route.ts`): три файла маршрутов
 * — это три входа в ОДИН И ТОТ ЖЕ API, и ограничение, поставленное не на все,
 * обходится сменой транспорта. Счёт при этом общий: бакет заводится на отпечаток
 * ключа, а не на маршрут.
 */
import config from '@payload-config';
import { GRAPHQL_POST, REST_OPTIONS } from '@payloadcms/next/routes';

import { withApiRateLimit } from '../../../../http/api-rate-limit';

export const OPTIONS = withApiRateLimit(REST_OPTIONS(config));
export const POST = withApiRateLimit(GRAPHQL_POST(config));
