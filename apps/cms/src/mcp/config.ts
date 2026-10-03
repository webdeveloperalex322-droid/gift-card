/**
 * Параметры MCP-слоя (решение Ч-35, спека
 * `docs/superpowers/specs/2026-10-03-mcp-vneshniy-redaktor-design.md`).
 *
 * ПОЧЕМУ ВЫКЛЮЧАТЕЛЬ ЕСТЬ, А У ОГРАНИЧЕНИЯ ЧАСТОТЫ ЕГО НЕТ. У `API_RATE_LIMIT_*`
 * выключателя нет намеренно: снятие защиты переменной окружения было бы решением,
 * принятым за человека. Здесь наоборот — выключатель и есть защита. Ручка
 * `/api/mcp` открывает сетевой вход, который на проде закрыт Basic Auth на всём
 * `server`-блоке (`deploy/nginx/dobrye-otkrytki.ru.conf`), и появление её кода в
 * репозитории не должно означать её появление на проде. Поэтому значение по
 * умолчанию — ВЫКЛЮЧЕНО, и включается оно одним явным `MCP_ENABLED=true`.
 *
 * ПОЧЕМУ `MCP_ENABLED=1` ОТВЕРГАЕТСЯ. Принимаются ровно `true` и `false`.
 * Соблазн принять `1`, `yes`, `on` ведёт к обратному: любое НЕузнанное значение
 * пришлось бы к чему-то приводить, а единственное безопасное приведение —
 * «выключено», то есть настройщик, написавший `MCP_ENABLED=enabled`, получил бы
 * молча выключенную ручку и искал бы причину в сети. Громкий отказ на старте
 * дешевле.
 *
 * ПРО `MCP_ALLOWED_ORIGINS` И ПУСТОЙ СПИСОК. Спека MCP требует проверять
 * `Origin` (защита от DNS rebinding) и отвечать `403`, если заголовок есть и
 * недопустим. Пустой список означает «ни один `Origin` не разрешён», а не «любой»:
 * обратное прочтение превратило бы незаполненную настройку в открытые двери.
 * Запрос БЕЗ заголовка `Origin` при этом проходит — так ходят все серверные
 * клиенты (CLI-агенты, скрипты), а браузерного клиента у этой ручки нет вовсе.
 */
import { type SharedEnv, currentEnv } from '@otkritka/shared';

/** Включение ручки целиком. Без значения — выключено. */
export const MCP_ENABLED_ENV_KEY = 'MCP_ENABLED';

/** Белый список `Origin` через запятую. Пусто = запрос с `Origin` отвергается. */
export const MCP_ALLOWED_ORIGINS_ENV_KEY = 'MCP_ALLOWED_ORIGINS';

/** Сколько ответов `401` на один IP допускается в окне. */
export const MCP_AUTH_FAILURE_LIMIT_ENV_KEY = 'MCP_AUTH_FAILURE_LIMIT';

/** Длительность окна подсчёта неудачных попыток, секунды. */
export const MCP_AUTH_FAILURE_WINDOW_ENV_KEY = 'MCP_AUTH_FAILURE_WINDOW_SECONDS';

/** Предел числа IP-бакетов в памяти процесса. */
export const MCP_AUTH_FAILURE_MAX_KEYS_ENV_KEY = 'MCP_AUTH_FAILURE_MAX_KEYS';

/**
 * Значения по умолчанию для лимита неудачных попыток.
 *
 * Это не «решение, принятое за человека»: отдельного решения по числу попыток
 * человек не принимал, а защита от перебора обязана существовать с первой
 * минуты. Значения настраиваемые; выключателя у них нет — ноль и отрицательные
 * отвергаются, как и у Ч-14.
 */
export const MCP_DEFAULTS = {
  failureLimit: 10,
  failureMaxKeys: 10_000,
  failureWindowSeconds: 60,
} as const;

export interface McpConfig {
  readonly allowedOrigins: readonly string[];
  readonly enabled: boolean;
  readonly failureLimit: number;
  readonly failureMaxKeys: number;
  readonly failureWindowSeconds: number;
}

function readPositiveInt(env: SharedEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim() ?? '';
  if (raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `${key} должен быть целым числом от 1, получено: «${raw}». Значение по умолчанию — ` +
        `${String(fallback)}; некорректная настройка не подменяется им молча. Ноль ` +
        'недопустим: выключателя у защиты от перебора токена нет, выключается вся ручка ' +
        `переменной ${MCP_ENABLED_ENV_KEY}.`,
    );
  }
  return parsed;
}

function readEnabled(env: SharedEnv): boolean {
  const raw = env[MCP_ENABLED_ENV_KEY]?.trim() ?? '';
  if (raw === '' || raw === 'false') {
    return false;
  }
  if (raw === 'true') {
    return true;
  }
  throw new Error(
    `${MCP_ENABLED_ENV_KEY} принимает только «true» или «false», получено: «${raw}». ` +
      'Неузнанное значение не приводится к «выключено»: тогда опечатка в настройке ' +
      'выглядела бы как исправно выключенная ручка, и причину искали бы в сети, а не в ' +
      'переменной окружения.',
  );
}

/**
 * Разбирает `MCP_*`. ЗОВЁТСЯ ПРИ СТАРТЕ из `payload.config.ts` — по той же
 * причине, что `resolveApiRateLimit`: мусорное значение обязано валить запуск, а
 * не дожидаться первого запроса внешнего клиента.
 *
 * @throws Error при некорректном значении любой из переменных.
 */
export function resolveMcpConfig(env: SharedEnv = currentEnv()): McpConfig {
  const allowedOrigins = (env[MCP_ALLOWED_ORIGINS_ENV_KEY] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');

  return {
    allowedOrigins,
    enabled: readEnabled(env),
    failureLimit: readPositiveInt(
      env,
      MCP_AUTH_FAILURE_LIMIT_ENV_KEY,
      MCP_DEFAULTS.failureLimit,
    ),
    failureMaxKeys: readPositiveInt(
      env,
      MCP_AUTH_FAILURE_MAX_KEYS_ENV_KEY,
      MCP_DEFAULTS.failureMaxKeys,
    ),
    failureWindowSeconds: readPositiveInt(
      env,
      MCP_AUTH_FAILURE_WINDOW_ENV_KEY,
      MCP_DEFAULTS.failureWindowSeconds,
    ),
  };
}

/**
 * Допустим ли предъявленный `Origin`.
 *
 * `null` (заголовка нет) — допустим: так ходят серверные клиенты, а спека MCP
 * требует отвечать `403` только когда заголовок ПРИСУТСТВУЕТ и недопустим.
 */
export function isOriginAllowed(origin: string | null, allowed: readonly string[]): boolean {
  if (origin === null || origin === '') {
    return true;
  }
  return allowed.includes(origin);
}
