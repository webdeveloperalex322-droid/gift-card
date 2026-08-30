/**
 * Ограничение частоты запросов на API-ключ (задача Э6-03, ТЗ §9, решение Ч-14).
 *
 * ТОЧКА ПРИМЕНЕНИЯ — ОБЁРТКА НАД ФАЙЛАМИ МАРШРУТОВ. `withApiRateLimit`
 * навешивается на экспорты ВСЕХ файлов маршрутов под `src/app/(payload)/api`, а
 * их ровно три:
 *
 *   1. `api/[...slug]/route.ts` — REST;
 *   2. `api/graphql/route.ts` — GraphQL;
 *   3. `api/graphql-playground/route.ts` — песочница GraphQL. Она попала сюда не
 *      «за компанию»: `GRAPHQL_PLAYGROUND_GET` зовёт `createPayloadRequest`, а тот
 *      — `executeAuthStrategies`, то есть запрос с заголовком `users API-Key
 *      <ключ>` ищет владельца ключа в Postgres ЕЩЁ ДО решения о том, отдавать ли
 *      страницу или 404. Вход, который стоит денег базе, обязан считаться, каким
 *      бы ни был его конечный ответ.
 *
 * Полнота списка проверяется живым набором (`tests/api/rate-limit.test.ts`:
 * «счёт общий для всех трёх маршрутов»), а не этим перечислением: ограничение,
 * поставленное не на все входы одного API, обходится сменой транспорта — и это
 * ровно тот дефект, который перечисление в комментарии скрывает лучше всего.
 *
 * Две отвергнутые альтернативы, и обе отвергнуты по существу:
 *
 *   - **хук коллекции.** Хуки выполняются и на Local API, а Local API — это
 *     рендер сайта: `apps/web` спрашивает Payload на каждый запрос страницы.
 *     Ограничение в хуке считало бы не запросы внешнего клиента, а обращения
 *     собственного фронтенда, и первым бы отвалился сайт. Кроме того, хук
 *     срабатывает уже после аутентификации и разбора тела, то есть после самой
 *     дорогой части работы;
 *   - **middleware Next.** В `apps/cms` его нет вовсе (проверено: файла
 *     `middleware.ts` в приложении не существует), а заводить его ради этого
 *     означало бы вторую точку правды о том, какие пути считаются API.
 *
 * СЧИТАЮТСЯ ТОЛЬКО ЗАПРОСЫ С API-КЛЮЧОМ. Ч-14 говорит «на ключ», и это выбор, а
 * не побочный эффект: сессия-cookie администратора в браузере админки НЕ
 * ограничивается. Админка на одном экране делает десятки запросов (списки,
 * счётчики, поля связей), и общий счётчик с сервисным аккаунтом означал бы, что
 * человек блокирует сам себя обычной работой в интерфейсе. Анонимные запросы
 * этим ограничением тоже не считаются — у них нет «ключа», к которому его можно
 * привязать; защита от анонимного потока — это задача обратного прокси, а не
 * коллекции.
 *
 * КЛЮЧ БАКЕТА — ОТПЕЧАТОК, А НЕ САМ КЛЮЧ. В памяти процесса не лежит ни одного
 * API-ключа в открытом виде: считается тот же HMAC, которым сам Payload
 * заполняет `users.apiKeyIndex` (см. {@link apiKeyFingerprint}). Отпечаток
 * берётся с ПРЕДЪЯВЛЕННОГО значения и не требует обращения к базе — это
 * принципиально: проверка «есть ли такой ключ» стоит запроса к Postgres, и
 * ограничение, срабатывающее после него, не защищало бы как раз то, что дороже
 * всего. Побочное следствие названо прямо: перебор несуществующих ключей тоже
 * попадает под ограничение, каждый — в свой бакет, и поэтому хранилище бакетов
 * обязано быть ограниченным по размеру (см. `createRateLimitStore`).
 */
import { createHash, createHmac } from 'node:crypto';

import { type SharedEnv, currentEnv } from '@otkritka/shared';

import { Users } from '../collections/users';
import { loadEnvFiles, requireEnv } from '../env.mjs';
import {
  type RateLimitStore,
  type TokenBucketSettings,
  createRateLimitStore,
} from './token-bucket';

/* ------------------------------------------------------------------ */
/* Параметры из окружения                                              */
/* ------------------------------------------------------------------ */

/** Устойчивая частота: сколько запросов выдаётся ключу за окно. Ч-14: 60. */
export const RATE_LIMIT_QUOTA_ENV_KEY = 'API_RATE_LIMIT_PER_MINUTE';

/** Всплеск: сколько запросов подряд принимается после простоя. Ч-14: 120. */
export const RATE_LIMIT_BURST_ENV_KEY = 'API_RATE_LIMIT_BURST';

/** Длительность окна выдачи квоты в секундах. Ч-14: 60. */
export const RATE_LIMIT_WINDOW_ENV_KEY = 'API_RATE_LIMIT_WINDOW_SECONDS';

/** Предел числа бакетов в памяти процесса. */
export const RATE_LIMIT_MAX_KEYS_ENV_KEY = 'API_RATE_LIMIT_MAX_KEYS';

/**
 * Утверждённые значения Ч-14 (2026-08-21) и предел размера хранилища.
 *
 * Дефолты здесь — НЕ «значения по умолчанию вместо решения человека», как у
 * `SITE_URL`, где дефолт запрещён. Это записанное в код решение Ч-14: пустая
 * переменная означает «как решено», а мусорная — ошибку, а не молчаливый возврат
 * к решению (тот, кто настраивал предел, обязан узнать, что настройка не
 * применилась). Отключить ограничение переменной нельзя: ноль и отрицательные
 * значения отвергаются, «выключателя» у защиты нет.
 */
export const RATE_LIMIT_DEFAULTS = {
  burst: 120,
  /**
   * Бакетов в памяти. Предел взят с большим запасом к реальному числу ключей
   * (Ч-16: ровно два аккаунта) — он существует не для них, а для потока
   * несуществующих ключей: без предела перебор превратил бы карту бакетов в
   * канал исчерпания памяти.
   */
  maxKeys: 10_000,
  quotaPerWindow: 60,
  windowSeconds: 60,
} as const;

export interface ApiRateLimitConfig {
  readonly maxKeys: number;
  readonly settings: TokenBucketSettings;
}

function readPositiveInt(env: SharedEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim() ?? '';
  if (raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `${key} должен быть целым числом от 1, получено: «${raw}». Утверждённое значение — ` +
        `${String(fallback)} (решение Ч-14); некорректная настройка не подменяется им ` +
        'молча. Ноль недопустим: выключателя у ограничения частоты нет — снятие защиты ' +
        'переменной окружения было бы решением, принятым за человека.',
    );
  }
  return parsed;
}

/**
 * Разбирает параметры ограничения.
 *
 * ЗОВЁТСЯ ПРИ СТАРТЕ, а не только из {@link activeLimiter}: `payload.config.ts`
 * выполняет её на верхнем уровне рядом с `reservedRoutes()`. Мусорное значение
 * `API_RATE_LIMIT_*` обязано валить ЗАПУСК CMS — при ленивом разборе оно
 * дожидалось бы первого запроса с ключом и приходило бы к внешнему клиенту, а на
 * установке, где ключом за смену никто не сходил, не проявлялось бы вовсе.
 *
 * ПРО ИМЯ `API_RATE_LIMIT_PER_MINUTE`. Квота выдаётся за ОКНО, а окно — тоже
 * параметр; при утверждённом окне в 60 с имя буквально верно, и оно оставлено
 * именно поэтому: так `.env` читается теми же словами, которыми записано решение
 * Ч-14. Меняя окно и не меняя квоту, вы меняете фактическую частоту в минуту —
 * это названо здесь и в `.env.example`, чтобы никто не вывел из имени, что окно
 * ни на что не влияет.
 *
 * @throws Error при некорректном значении или при всплеске меньше квоты.
 */
export function resolveApiRateLimit(env: SharedEnv = currentEnv()): ApiRateLimitConfig {
  const quota = readPositiveInt(env, RATE_LIMIT_QUOTA_ENV_KEY, RATE_LIMIT_DEFAULTS.quotaPerWindow);
  const burst = readPositiveInt(env, RATE_LIMIT_BURST_ENV_KEY, RATE_LIMIT_DEFAULTS.burst);
  const windowSeconds = readPositiveInt(
    env,
    RATE_LIMIT_WINDOW_ENV_KEY,
    RATE_LIMIT_DEFAULTS.windowSeconds,
  );
  const maxKeys = readPositiveInt(env, RATE_LIMIT_MAX_KEYS_ENV_KEY, RATE_LIMIT_DEFAULTS.maxKeys);

  if (burst < quota) {
    throw new Error(
      `${RATE_LIMIT_BURST_ENV_KEY} (${String(burst)}) меньше, чем ` +
        `${RATE_LIMIT_QUOTA_ENV_KEY} (${String(quota)}). По смыслу Ч-14 всплеск — это ` +
        'допуск СВЕРХ устойчивой частоты (120 при 60 в минуту), поэтому значение ниже ' +
        'квоты означает переставленные местами параметры: настройщик задал частоту в поле ' +
        'всплеска. Настройка отвергается, а не выправляется молча — иначе фактический ' +
        'предел отличался бы от объявленного, и заметить это было бы нечем.',
    );
  }

  return {
    maxKeys,
    settings: {
      capacity: burst,
      refillTokens: quota,
      refillWindowMs: windowSeconds * 1000,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Отпечаток ключа                                                     */
/* ------------------------------------------------------------------ */

/**
 * Секрет в том виде, в каком его держит сам Payload.
 *
 * Payload не использует `PAYLOAD_SECRET` напрямую: в конструкторе он берёт
 * `sha256` от значения конфига и оставляет первые 32 символа шестнадцатеричной
 * записи (`payload/dist/index.js`). Тем же значением он подписывает
 * `users.apiKeyIndex`, поэтому шаг воспроизведён здесь — без него отпечаток
 * совпал бы «почти».
 */
export function payloadSecretDigest(configSecret: string): string {
  return createHash('sha256').update(configSecret).digest('hex').slice(0, 32);
}

/**
 * Отпечаток API-ключа — ровно тот, который Payload хранит в `users.apiKeyIndex`.
 *
 * ПОЧЕМУ ИМЕННО ЭТОТ, А НЕ СВОЙ ХЕШ. Отпечаток — это идентификатор, по которому
 * ключ различается в памяти процесса, и он же связывает эпизод ограничения с
 * записью в `users`: администратор, увидев в журнале предупреждение, находит
 * владельца ключа запросом по `apiKeyIndex`. Свой отдельный хеш такой связи не
 * дал бы, а второй способ считать одно и то же — это второй способ ошибиться.
 *
 * ПОВТОРЕНИЕ ЧУЖОЙ ФОРМУЛЫ ЗДЕСЬ ОСОЗНАННО: `payload` не выпускает эту функцию
 * наружу (она записана прямо в хуке базового поля `apiKeyIndex`). Расхождение с
 * оригиналом ловится не чтением, а живым тестом `tests/api/rate-limit.test.ts`:
 * он сравнивает результат с тем, что Payload РЕАЛЬНО положил в базу.
 *
 * Сам ключ в памяти не остаётся: HMAC необратим, а в журнал уходит только начало
 * отпечатка.
 */
export function apiKeyFingerprint(apiKey: string, configSecret: string): string {
  return createHmac('sha256', payloadSecretDigest(configSecret)).update(apiKey).digest('hex');
}

/**
 * Заголовок авторизации по API-ключу в форме, заданной самим Payload
 * (`auth/strategies/apiKey.js`): `<slug коллекции> API-Key <ключ>`.
 *
 * Слаг берётся из конфига коллекции, а не пишется строкой: переименование
 * коллекции пользователей иначе оставило бы ограничение включённым, но
 * недостижимым — заголовок перестал бы распознаваться, и все запросы считались
 * бы анонимными.
 */
export const API_KEY_AUTH_PREFIX = `${Users.slug} API-Key `;

/**
 * Ключ, предъявленный в заголовке, либо `null`.
 *
 * Значение берётся ДОСЛОВНО, ровно так, как его вырезает стратегия Payload:
 * своей обрезки здесь нет. Крайние пробелы снимает сам HTTP-слой (`Headers`
 * нормализует значение по спецификации Fetch), поэтому обрезка ничего не
 * исправила бы, зато была бы вторым разбором одного заголовка — и однажды
 * разошлась бы с первым.
 *
 * Пустое значение после префикса — это `null`: такой запрос Payload считает
 * неаутентифицированным, и ограничивать его как «ключ» значило бы завести один
 * общий бакет для всех анонимов, который выключал бы им доступ целиком.
 */
export function presentedApiKey(headers: Headers): string | null {
  const authorization = headers.get('Authorization');
  if (authorization === null || !authorization.startsWith(API_KEY_AUTH_PREFIX)) {
    return null;
  }
  const key = authorization.slice(API_KEY_AUTH_PREFIX.length);
  return key === '' ? null : key;
}

/* ------------------------------------------------------------------ */
/* Состояние процесса                                                  */
/* ------------------------------------------------------------------ */

interface Limiter {
  readonly configSecret: string;
  readonly store: RateLimitStore;
}

let limiter: Limiter | null = null;

/**
 * Счётчики процесса. Создаются при первом запросе с ключом — но ПРИГОДНОСТЬ
 * параметров к этому моменту уже проверена при старте (`payload.config.ts`),
 * поэтому здесь остаётся только построение хранилища, а не единственный шанс
 * узнать об опечатке в `.env`.
 */
function activeLimiter(): Limiter {
  if (limiter === null) {
    loadEnvFiles();
    const { maxKeys, settings } = resolveApiRateLimit();
    limiter = {
      configSecret: requireEnv('PAYLOAD_SECRET'),
      store: createRateLimitStore({ maxKeys, settings }),
    };
  }
  return limiter;
}

/**
 * Сбрасывает счётчики и перечитывает окружение.
 *
 * Нужна тестам: параметры читаются один раз при первом запросе, и без сброса
 * тест на «конфигурация берётся из env» проверял бы состояние, сложившееся до
 * него. Зовёт её ровно один файл — `tests/api/rate-limit.test.ts`, и он же
 * возвращает окружение на место.
 *
 * Остальные файлы `tests/api/**` под боевой предел Ч-14 не ставятся вовсе:
 * vitest-проект `api` задаёт им заведомо больший предел через те же переменные
 * окружения (см. `vitest.config.ts`). Иначе бюджет в 120 запросов делился бы
 * между всеми файлами набора, и следующий добавленный сценарий ронял бы ЧУЖОЙ
 * ответом 429 — отказом, у которого нет никакого отношения к проверяемому
 * правилу.
 */
export function resetApiRateLimit(): void {
  limiter = null;
}

/* ------------------------------------------------------------------ */
/* Ответ 429                                                           */
/* ------------------------------------------------------------------ */

/**
 * Отказ по превышению.
 *
 * Тело — в форме ошибок Payload (`{ errors: [{ message }] }`), одинаковой для
 * REST и GraphQL: клиент, уже умеющий читать отказ по правам, читает и этот, а
 * не получает HTML или пустое тело.
 *
 * `Retry-After` — обязательная часть решения Ч-14: без него клиент не знает,
 * когда повторить, и повторяет немедленно. `Cache-Control: no-store` стоит
 * рядом, потому что кешированный 429 продолжал бы отказывать после того, как
 * квота восстановилась.
 */
export function tooManyRequestsResponse(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({
      errors: [
        {
          message:
            'Превышен предел частоты запросов для этого API-ключа (решение Ч-14). ' +
            `Повторите запрос через ${String(retryAfterSeconds)} с — значение в заголовке ` +
            'Retry-After. Предел считается на ключ и не зависит от того, какие коллекции ' +
            'запрашиваются.',
        },
      ],
    }),
    {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterSeconds),
      },
      status: 429,
    },
  );
}

/**
 * Решение по запросу: `null` — пропустить, `Response` — отказать.
 *
 * Отделено от обёртки, чтобы проверяться тестом без поднятия Payload.
 */
export function checkApiRateLimit(request: Request, nowMs: number = Date.now()): Response | null {
  const key = presentedApiKey(request.headers);
  if (key === null) {
    return null;
  }

  const { configSecret, store } = activeLimiter();
  const fingerprint = apiKeyFingerprint(key, configSecret);
  const decision = store.consume(fingerprint, nowMs);

  if (decision.allowed) {
    return null;
  }

  if (decision.firstDenial) {
    // Одна строка на эпизод, а не на каждый отклонённый запрос: журнал не должен
    // усиливать всплеск, ради которого он ведётся. В строке — начало отпечатка:
    // по нему администратор находит владельца ключа
    // (`where apiKeyIndex like '<префикс>%'` в коллекции users), а сам ключ по
    // нему не восстанавливается.
    console.warn(
      `[api-rate-limit] Ключ с отпечатком ${fingerprint.slice(0, 12)}… превысил предел ` +
        `частоты; запросы отклоняются с 429, Retry-After ${String(decision.retryAfterSeconds)} с.`,
    );
  }

  return tooManyRequestsResponse(decision.retryAfterSeconds);
}

/**
 * Обёртка над обработчиком маршрута Next.
 *
 * Сигнатура сохраняется целиком (`request` плюс всё остальное, что передаёт
 * Next), поэтому обёрнутый экспорт остаётся законным маршрутом, а тип проверяет
 * компилятор.
 */
export function withApiRateLimit<Args extends unknown[]>(
  handler: (request: Request, ...rest: Args) => Promise<Response>,
): (request: Request, ...rest: Args) => Promise<Response> {
  return async (request: Request, ...rest: Args): Promise<Response> => {
    const denial = checkApiRateLimit(request);
    return denial ?? (await handler(request, ...rest));
  };
}
