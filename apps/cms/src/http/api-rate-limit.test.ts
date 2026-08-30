/**
 * Ограничение частоты на API-ключ: разбор окружения, отпечаток и обёртка
 * (задача Э6-03, решение Ч-14).
 *
 * Что здесь НЕ проверяется и почему. Что обёртка реально стоит на маршрутах
 * Payload — это утверждение о проводке, и доказывается оно запросом по тому же
 * пути, которым ходит внешний клиент: `tests/api/rate-limit.test.ts`. Юнит-тест
 * на обёртке зелёный и тогда, когда её забыли навесить, — ровно та подмена, из-за
 * которой в проекте вообще появился живой набор.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  API_KEY_AUTH_PREFIX,
  RATE_LIMIT_BURST_ENV_KEY,
  RATE_LIMIT_DEFAULTS,
  RATE_LIMIT_MAX_KEYS_ENV_KEY,
  RATE_LIMIT_QUOTA_ENV_KEY,
  RATE_LIMIT_WINDOW_ENV_KEY,
  apiKeyFingerprint,
  payloadSecretDigest,
  presentedApiKey,
  resetApiRateLimit,
  resolveApiRateLimit,
  withApiRateLimit,
} from './api-rate-limit';

const ENV_KEYS = [
  RATE_LIMIT_BURST_ENV_KEY,
  RATE_LIMIT_MAX_KEYS_ENV_KEY,
  RATE_LIMIT_QUOTA_ENV_KEY,
  RATE_LIMIT_WINDOW_ENV_KEY,
  'PAYLOAD_SECRET',
] as const;

const saved = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]] as const),
);

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  resetApiRateLimit();
  vi.restoreAllMocks();
});

describe('Э6-03: параметры из окружения', () => {
  it('пустое окружение даёт значения Ч-14: 60 за окно, всплеск 120, окно 60 с', () => {
    const { maxKeys, settings } = resolveApiRateLimit({});

    expect(settings.refillTokens).toBe(60);
    expect(settings.capacity).toBe(120);
    expect(settings.refillWindowMs).toBe(60_000);
    expect(maxKeys).toBe(RATE_LIMIT_DEFAULTS.maxKeys);
  });

  it('значения читаются из окружения, а не зашиты в код', () => {
    const { maxKeys, settings } = resolveApiRateLimit({
      [RATE_LIMIT_BURST_ENV_KEY]: '9',
      [RATE_LIMIT_MAX_KEYS_ENV_KEY]: '32',
      [RATE_LIMIT_QUOTA_ENV_KEY]: '5',
      [RATE_LIMIT_WINDOW_ENV_KEY]: '30',
    });

    expect(settings.capacity).toBe(9);
    expect(settings.refillTokens).toBe(5);
    expect(settings.refillWindowMs).toBe(30_000);
    expect(maxKeys).toBe(32);
  });

  it.each([
    ['мусор', 'шестьдесят'],
    ['ноль — выключателя у защиты нет', '0'],
    ['дробное', '60.5'],
    ['отрицательное', '-1'],
  ])('%s: значение отвергается, а не подменяется утверждённым', (_case, value) => {
    expect(() => resolveApiRateLimit({ [RATE_LIMIT_QUOTA_ENV_KEY]: value })).toThrow(
      RATE_LIMIT_QUOTA_ENV_KEY,
    );
  });

  it('всплеск меньше квоты отвергается: это переставленные местами параметры', () => {
    expect(() =>
      resolveApiRateLimit({
        [RATE_LIMIT_BURST_ENV_KEY]: '10',
        [RATE_LIMIT_QUOTA_ENV_KEY]: '60',
      }),
    ).toThrow(RATE_LIMIT_BURST_ENV_KEY);
  });
});

describe('Э6-03: отпечаток ключа', () => {
  const SECRET = 'секрет-конфига-для-теста';

  it('секрет свёрнут так же, как это делает сам Payload: 32 символа hex', () => {
    const digest = payloadSecretDigest(SECRET);
    expect(digest).toMatch(/^[0-9a-f]{32}$/);
  });

  it('отпечаток устойчив, не содержит ключа и различает ключи', () => {
    const key = 'ai-editor-9f2c1a';
    const fingerprint = apiKeyFingerprint(key, SECRET);

    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(apiKeyFingerprint(key, SECRET)).toBe(fingerprint);
    expect(fingerprint).not.toContain(key);
    expect(apiKeyFingerprint(`${key}0`, SECRET)).not.toBe(fingerprint);
    // Другой секрет — другой отпечаток: значение привязано к установке.
    expect(apiKeyFingerprint(key, `${SECRET}!`)).not.toBe(fingerprint);
  });
});

describe('Э6-03: распознавание ключа в заголовке', () => {
  const headers = (value?: string): Headers =>
    new Headers(value === undefined ? {} : { Authorization: value });

  it('заголовка нет — ключа нет (это путь сессии-cookie и анонима)', () => {
    expect(presentedApiKey(headers())).toBeNull();
  });

  it('чужая схема авторизации ключом не считается', () => {
    expect(presentedApiKey(headers('Bearer eyJhbGciOi'))).toBeNull();
    expect(presentedApiKey(headers('JWT eyJhbGciOi'))).toBeNull();
  });

  it('пустое значение после префикса ключом не считается', () => {
    expect(presentedApiKey(headers(API_KEY_AUTH_PREFIX))).toBeNull();
  });

  it('ключ вынимается целиком', () => {
    expect(presentedApiKey(headers(`${API_KEY_AUTH_PREFIX}ai-editor-abc-123`))).toBe(
      'ai-editor-abc-123',
    );
  });

  it('крайние пробелы снимает сам HTTP-слой, поэтому расхождения с Payload нет', () => {
    // Значение заголовка нормализует `Headers` по спецификации Fetch: крайние
    // пробелы в него не попадают вовсе. Значит, «ключ с хвостовым пробелом» не
    // доходит ни до этого кода, ни до стратегии Payload — оба видят одну и ту же
    // строку. Своей обрезки здесь поэтому нет: она была бы правилом, которое
    // ничего не исправляет, но может разойтись с чужим разбором.
    expect(presentedApiKey(headers(`${API_KEY_AUTH_PREFIX}ai-editor-abc-123 `))).toBe(
      'ai-editor-abc-123',
    );
    // Один пробел после префикса нормализуется в пустоту, и заголовок перестаёт
    // начинаться с префикса — для Payload это тоже «ключа нет».
    expect(presentedApiKey(headers(`${API_KEY_AUTH_PREFIX} `))).toBeNull();
  });
});

describe('Э6-03: обёртка маршрута', () => {
  /** Обработчик-пустышка: считает, сколько запросов до него дошло. */
  function countingHandler(): {
    readonly calls: () => number;
    readonly handler: (request: Request) => Promise<Response>;
  } {
    let calls = 0;
    return {
      calls: () => calls,
      handler: () => {
        calls += 1;
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    };
  }

  function tighten(quota: number, burst: number): void {
    process.env.PAYLOAD_SECRET = 'секрет-обёртки-для-теста';
    process.env[RATE_LIMIT_QUOTA_ENV_KEY] = String(quota);
    process.env[RATE_LIMIT_BURST_ENV_KEY] = String(burst);
    process.env[RATE_LIMIT_WINDOW_ENV_KEY] = '60';
    resetApiRateLimit();
  }

  const withKey = (key: string): Request =>
    new Request('http://cms.test/api/cards', {
      headers: { Authorization: `${API_KEY_AUTH_PREFIX}${key}` },
    });

  it('запрос сверх всплеска получает 429 с целым Retry-After', async () => {
    // Предупреждение об эпизоде уходит в журнал; в выводе теста оно только шум.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    tighten(2, 3);
    const { calls, handler } = countingHandler();
    const wrapped = withApiRateLimit(handler);

    for (let request = 0; request < 3; request += 1) {
      expect((await wrapped(withKey('kluch-a'))).status).toBe(200);
    }

    const denied = await wrapped(withKey('kluch-a'));
    expect(denied.status).toBe(429);
    expect(calls()).toBe(3);

    const retryAfter = denied.headers.get('Retry-After');
    expect(retryAfter).not.toBeNull();
    expect(Number.isInteger(Number(retryAfter))).toBe(true);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);

    const body: unknown = await denied.json();
    const errors = (body as { errors?: { message?: string }[] }).errors ?? [];
    expect(errors[0]?.message).toContain('Ч-14');
  });

  it('предел считается НА КЛЮЧ: соседний ключ не задет', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    tighten(2, 3);
    const wrapped = withApiRateLimit(countingHandler().handler);

    for (let request = 0; request < 4; request += 1) {
      await wrapped(withKey('kluch-a'));
    }
    expect((await wrapped(withKey('kluch-b'))).status).toBe(200);
  });

  it('запрос без API-ключа не считается вовсе: сессия админки не троттлится', async () => {
    tighten(2, 3);
    const { calls, handler } = countingHandler();
    const wrapped = withApiRateLimit(handler);

    for (let request = 0; request < 20; request += 1) {
      const response = await wrapped(
        new Request('http://cms.test/api/cards', {
          // Так ходит браузер админки: сессия в cookie, заголовка авторизации нет.
          headers: { Cookie: 'payload-token=eyJhbGciOi' },
        }),
      );
      expect(response.status).toBe(200);
    }
    expect(calls()).toBe(20);
  });

  it('журнал пишет одну строку на эпизод, а не на каждый отклонённый запрос', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    tighten(2, 2);
    const wrapped = withApiRateLimit(countingHandler().handler);

    for (let request = 0; request < 12; request += 1) {
      await wrapped(withKey('kluch-shumnyy'));
    }

    expect(warn.mock.calls.length).toBe(1);
  });

  it('в журнал уходит отпечаток, а НЕ сам ключ', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const secret = 'секрет-обёртки-для-теста';
    tighten(1, 1);
    const wrapped = withApiRateLimit(countingHandler().handler);

    // Ключ намеренно узнаваем: подстрока, которую невозможно получить случайно.
    const key = 'ai-editor-SEKRETNYY-KLUCH-9f2c1a';
    await wrapped(withKey(key));
    await wrapped(withKey(key));

    expect(warn.mock.calls.length).toBe(1);
    const line = String(warn.mock.calls[0]?.[0]);

    // Главное утверждение: строка журнала не является способом узнать ключ.
    // Журнал читают в инциденте, пересылают и складывают в системы, к которым
    // доступ шире, чем к `.env`, — плейнтекст ключа там означал бы, что защита
    // ключа держится на том, кто именно читает лог.
    expect(line).not.toContain(key);
    expect(line).not.toContain('SEKRETNYY');

    // И то, ЧТО в строке есть: начало настоящего отпечатка — 12 шестнадцатеричных
    // символов, по которым администратор находит владельца запросом
    // `where apiKeyIndex like '<префикс>%'`. Без этой половины утверждение «ключа
    // нет» выполнялось бы и пустой строкой, из которой нельзя узнать вообще
    // ничего.
    const prefix = apiKeyFingerprint(key, secret).slice(0, 12);
    expect(prefix).toMatch(/^[0-9a-f]{12}$/);
    expect(line).toContain(prefix);
    // Отпечаток обрезан: полное значение — тоже идентификатор, и в журнале ему
    // делать нечего.
    expect(line).not.toContain(apiKeyFingerprint(key, secret));
  });
});
