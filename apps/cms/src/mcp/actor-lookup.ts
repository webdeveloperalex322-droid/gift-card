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
 *   - `select` перечисляет четыре поля. Поля `apiKey` среди них НЕТ намеренно: у
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
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PayloadRequest } from 'payload';

import { apiKeyFingerprint } from '../http/api-rate-limit';

/** Причина отказа. Наружу она НЕ уходит: ответ `401` одинаков для всех трёх. */
export type AuthFailure = 'missing' | 'revoked' | 'unknown';

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
 * Сравнение отпечатков постоянного времени.
 *
 * Поиск по индексу выполняет база, но сравнение повторяется здесь и намеренно:
 * равенство, в котором участвует секрет, не должно зависеть от того, как работает
 * оператор `===` на строках. Разная длина — сразу `false`, иначе `timingSafeEqual`
 * бросает.
 */
export function fingerprintsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Отпечаток ключа — тот же HMAC, что Payload хранит в `users.apiKeyIndex`. */
export function fingerprintOf(args: {
  readonly presentedKey: string;
  readonly secret: string;
}): string {
  return apiKeyFingerprint(args.presentedKey, args.secret);
}

interface UserRow {
  readonly apiKeyIndex?: string | null;
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
    select: { apiKeyIndex: true, email: true, enableAPIKey: true, role: true },
    where: { apiKeyIndex: { equals: fingerprint } },
  });

  const user = page.docs[0] as UserRow | undefined;
  if (user === undefined) {
    return { outcome: 'unknown' };
  }

  const stored = typeof user.apiKeyIndex === 'string' ? user.apiKeyIndex : '';
  if (!fingerprintsEqual(stored, fingerprint)) {
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

  return {
    actor: { email: typeof user.email === 'string' ? user.email : null, id: user.id, role },
    outcome: 'ok',
  };
}

/** HMAC-отпечаток произвольной строки для журнала: ни ключ, ни IP в логи не попадают. */
export function logFingerprint(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('hex').slice(0, 16);
}
