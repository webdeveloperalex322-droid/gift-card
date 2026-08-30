/**
 * GraphQL Playground. Состав файла задан Payload 3.
 *
 * Обёртка `withApiRateLimit` (Э6-03, Ч-14) стоит и здесь — по той же причине, что
 * на REST и на GraphQL, и вопреки первому впечатлению «это же просто HTML-страница
 * с песочницей».
 *
 * ПОЧЕМУ ЭТО ПОЛНОЦЕННЫЙ ВХОД В PAYLOAD. `GRAPHQL_PLAYGROUND_GET` первым делом
 * зовёт `createPayloadRequest` (`@payloadcms/next/dist/routes/graphql/playground.js`),
 * а тот выполняет `executeAuthStrategies` (`payload/dist/utilities/createPayloadRequest.js`).
 * То есть запрос с заголовком `users API-Key <ключ>` уже на этом маршруте
 * означает ПОИСК ВЛАДЕЛЬЦА КЛЮЧА В POSTGRES. Решение о 404 (в production при
 * `disablePlaygroundInProduction`) принимается ПОСЛЕ этого — значит без обёртки
 * перебор ключей через этот адрес ходил бы в базу мимо квоты Ч-14, а ответ 404
 * скрывал бы это тем убедительнее, чем внимательнее смотреть только на код
 * ответа.
 *
 * Довод тот же, что записан в `../graphql/route.ts`: ограничение, поставленное не
 * на все входы одного API, обходится сменой транспорта. Счёт при этом общий —
 * бакет заводится на отпечаток ключа, а не на маршрут (см.
 * `src/http/api-rate-limit.ts`), поэтому три обёрнутых файла маршрутов дают один
 * счётчик на ключ, а не три независимых.
 */
import config from '@payload-config';
import { GRAPHQL_PLAYGROUND_GET } from '@payloadcms/next/routes';

import { withApiRateLimit } from '../../../../http/api-rate-limit';

export const GET = withApiRateLimit(GRAPHQL_PLAYGROUND_GET(config));
