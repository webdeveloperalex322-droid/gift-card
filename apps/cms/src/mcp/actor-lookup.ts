/**
 * Поиск владельца предъявленного API-ключа. ВТОРОЕ И ПОСЛЕДНЕЕ место слоя,
 * которое касается Payload, и ЕДИНСТВЕННОЕ, где стоит `overrideAccess: true`.
 *
 * ═══ ПОЧЕМУ ЭТО НЕ ДЫРА, А НЕИЗБЕЖНОСТЬ ═══
 *
 * На момент проверки токена аутентифицированного пользователя ещё НЕТ — его как
 * раз и устанавливают. А коллекция `users` закрыта от анонима
 * (`read: authenticatedAccess`). Значит один системный запрос неизбежен: без него
 * аутентификацию по ключу выполнить нечем.
 *
 * Поэтому запрос здесь ровно один, и он сужен до предела:
 *
 *   - одна операция (`find`) и ни одной записывающей. Создать, изменить или
 *     удалить что-либо этот модуль не может технически;
 *   - `limit: 1` и поиск по `apiKeyIndex` — не по email, не по роли, не по id;
 *   - `select` перечисляет три поля. Поля `apiKey` среди них НЕТ намеренно: у
 *     него есть хук `afterRead`, расшифровывающий значение, и выбрать его значило
 *     бы поднять ключи в память процесса в открытом виде;
 *   - результат наружу не отдаётся: функция возвращает актора (id, роль, email)
 *     или причину отказа, но не запись пользователя.
 *
 * `gateway-isolation.test.ts` знает про это исключение и проверяет перечисленное
 * списком — то есть расширить исключение молча нельзя.
 *
 * ═══ ПОЧЕМУ ПРОВЕРЯЕТСЯ `enableAPIKey`, ХОТЯ ИСКАЛИ ПО ИНДЕКСУ ═══
 *
 * Своя стратегия аутентификации Payload флаг `enableAPIKey` НЕ смотрит вовсе —
 * она ищет пользователя только по `apiKeyIndex` (разбор в шапке
 * `src/collections/users.ts`, дыра № 3 задачи Э6-01). Если бы MCP повторил это
 * поведение, «отозванный» ключ продолжал бы работать через MCP, и отзыв кнопкой в
 * админке — главный довод решения Ч-35f — перестал бы что-либо значить.
 */
import { createHmac } from 'node:crypto';
import type { PayloadRequest } from 'payload';

import { apiKeyFingerprint } from '../http/api-rate-limit';

/** Причина отказа. Наружу она НЕ уходит: ответ `401` одинаков для всех причин. */
export type AuthFailure = 'forbidden-role' | 'missing' | 'revoked' | 'unknown';

/**
 * Единственная роль, которой открыт MCP-канал.
 *
 * Решение Ч-35f называет токеном «API-ключ существующего аккаунта `ai-editor`», и
 * это ограничение, а не пример. Сначала здесь принимался ключ ЛЮБОГО аккаунта с
 * доводом «права принадлежат аккаунту, а не каналу» — то есть формулировка решения
 * человека была подогнана под реализацию. Находка ревью 2026-10-03.
 *
 * Цена допуска `admin` была не теоретической: его ключом внешняя модель правила бы
 * тексты уже опубликованных индексируемых страниц и меняла изображение
 * опубликованной карточки, минуя `review`, — потому что для роли `admin` эти
 * правила прав не запрещают. Расширение канала до других ролей — отдельное решение
 * человека со своим номером, а не вывод из кода.
 */
export const MCP_ALLOWED_ROLE = 'ai-editor';

export interface McpActorRecord {
  readonly email: string | null;
  readonly id: number | string;
  readonly role: string;
}

export type ActorLookup =
  | { readonly actor: McpActorRecord; readonly outcome: 'ok' }
  | { readonly outcome: AuthFailure };

const BEARER_PREFIX = 'Bearer ';

/** Предъявленный токен из заголовка, или `null`. Схема только Bearer. */
export function readBearerToken(header: string | null): string | null {
  if (header === null || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token === '' ? null : token;
}

/**
 * ═══ ГДЕ СРАВНИВАЮТСЯ ОТПЕЧАТКИ — И ПОЧЕМУ НЕ ЗДЕСЬ ═══
 *
 * Сначала здесь стояла дополнительная сверка: прочитать `apiKeyIndex` из записи и
 * сравнить его с вычисленным отпечатком через `timingSafeEqual`. Выяснилось живым
 * прогоном, что Payload НЕ ОТДАЁТ это поле в чтении вовсе — ни `findByID`, ни
 * `find` с явным `select` его не возвращают (замер: ключи ответа —
 * `id, role, enableAPIKey, email, collection`). Сверка не могла пройти никогда и
 * ломала аутентификацию целиком: любой действующий ключ получал `401`.
 *
 * Сравнение отпечатков выполняет САМ ЗАПРОС: `where` ищет точное равенство по
 * индексированной колонке, в которой лежит HMAC. Это и есть сравнение, и оно
 * выполняется в базе. Вычислять его повторно в процессе было нечем — значения
 * второй стороны у нас нет.
 *
 * Про постоянное время. Опасность утечки по времени возникает там, где с секретом
 * сравнивают посимвольно. Здесь в запрос уходит не ключ, а его HMAC: подобрать по
 * времени ответа базы можно только отпечаток, а чтобы его вычислить, нужен уже
 * сам ключ вместе с секретом установки.
 */

/** Отпечаток ключа — тот же HMAC, что Payload хранит в `users.apiKeyIndex`. */
export function fingerprintOf(args: {
  readonly presentedKey: string;
  readonly secret: string;
}): string {
  return apiKeyFingerprint(args.presentedKey, args.secret);
}

interface UserRow {
  readonly email?: string | null;
  readonly enableAPIKey?: boolean | null;
  readonly id: number | string;
  readonly role?: string | null;
}

export async function findActorByApiKey(args: {
  readonly presentedKey: string;
  readonly req: PayloadRequest;
  readonly secret: string;
}): Promise<ActorLookup> {
  const { presentedKey, req, secret } = args;
  const fingerprint = fingerprintOf({ presentedKey, secret });

  const page = await req.payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    // ЕДИНСТВЕННОЕ место слоя с обходом прав. Обоснование — в шапке файла:
    // коллекция users закрыта от анонима, а пользователь на этот момент ещё не
    // установлен. Операция только чтение, по одному индексированному полю.
    overrideAccess: true,
    req,
    select: { email: true, enableAPIKey: true, role: true },
    where: { apiKeyIndex: { equals: fingerprint } },
  });

  const user = page.docs[0] as UserRow | undefined;
  if (user === undefined) {
    return { outcome: 'unknown' };
  }

  if (user.enableAPIKey !== true) {
    return { outcome: 'revoked' };
  }

  const role = typeof user.role === 'string' && user.role !== '' ? user.role : null;
  if (role === null) {
    // Роль обязательна и значения по умолчанию у неё нет (см. users.ts). Аккаунт
    // без роли — повреждённые данные, и прав у него быть не должно никаких.
    return { outcome: 'unknown' };
  }

  if (role !== MCP_ALLOWED_ROLE) {
    // Ключ действующий, но канал открыт только роли `ai-editor` (Ч-35f).
    // Причина различается в ЖУРНАЛЕ, а не в ответе: администратору, который
    // по ошибке предъявил свой ключ, нужна диагностика, но ответ остаётся тем же
    // `401` — различимые ответы были бы оракулом для перебора.
    return { outcome: 'forbidden-role' };
  }

  return {
    actor: { email: typeof user.email === 'string' ? user.email : null, id: user.id, role },
    outcome: 'ok',
  };
}

/** HMAC-отпечаток произвольной строки для журнала: ни ключ, ни IP в логи не попадают. */
export function logFingerprint(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('hex').slice(0, 16);
}
