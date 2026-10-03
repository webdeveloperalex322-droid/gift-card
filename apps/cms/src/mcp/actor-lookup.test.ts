import type { PayloadRequest } from 'payload';
import { describe, expect, it } from 'vitest';

import { apiKeyFingerprint } from '../http/api-rate-limit';
import { findActorByApiKey, logFingerprint, readBearerToken } from './actor-lookup';

const SECRET = 'test-secret-value';
const KEY = 'a4f1c0de-0000-4000-8000-000000000001';

interface FakeUser {
  readonly apiKeyIndex?: string | null;
  readonly email?: string | null;
  readonly enableAPIKey?: boolean | null;
  readonly id: number;
  readonly role?: string | null;
}

function fakeRequest(users: readonly FakeUser[]): {
  findArgs: Record<string, unknown>[];
  req: PayloadRequest;
} {
  const findArgs: Record<string, unknown>[] = [];
  const req = {
    payload: {
      find: (args: Record<string, unknown>) => {
        findArgs.push(args);
        const where = args.where as { apiKeyIndex?: { equals?: string } };
        const wanted = where.apiKeyIndex?.equals ?? '';
        return Promise.resolve({
          docs: users.filter((user) => user.apiKeyIndex === wanted),
          totalDocs: 1,
        });
      },
    },
  } as unknown as PayloadRequest;
  return { findArgs, req };
}

describe('readBearerToken', () => {
  it('читает токен схемы Bearer', () => {
    expect(readBearerToken('Bearer abc')).toBe('abc');
  });

  it('Basic не принимается: Basic Auth занимает тот же заголовок и токеном не является', () => {
    expect(readBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
  });

  it('заголовка нет или он пуст', () => {
    expect(readBearerToken(null)).toBeNull();
    expect(readBearerToken('Bearer    ')).toBeNull();
  });

  it('заголовок Payload «users API-Key ...» этой ручкой не принимается', () => {
    expect(readBearerToken('users API-Key abc')).toBeNull();
  });
});

describe('findActorByApiKey', () => {
  const index = apiKeyFingerprint(KEY, SECRET);

  it('находит владельца действующего ключа и отдаёт его роль', async () => {
    const { req } = fakeRequest([
      { apiKeyIndex: index, email: 'bot@test', enableAPIKey: true, id: 42, role: 'ai-editor' },
    ]);
    const result = await findActorByApiKey({ presentedKey: KEY, req, secret: SECRET });
    expect(result).toEqual({
      actor: { email: 'bot@test', id: 42, role: 'ai-editor' },
      outcome: 'ok',
    });
  });

  it('ключ администратора каналом НЕ принимается (Ч-35f)', async () => {
    // Канал открыт одной роли. Ключом admin внешняя модель правила бы тексты уже
    // опубликованных индексируемых страниц и меняла изображение опубликованной
    // карточки мимо review: для роли admin правила прав этого не запрещают.
    const { req } = fakeRequest([
      { apiKeyIndex: index, enableAPIKey: true, id: 1, role: 'admin' },
    ]);
    expect(await findActorByApiKey({ presentedKey: KEY, req, secret: SECRET })).toEqual({
      outcome: 'forbidden-role',
    });
  });

  it('неизвестная роль тоже не принимается', async () => {
    const { req } = fakeRequest([
      { apiKeyIndex: index, enableAPIKey: true, id: 1, role: 'editor' },
    ]);
    expect(await findActorByApiKey({ presentedKey: KEY, req, secret: SECRET })).toEqual({
      outcome: 'forbidden-role',
    });
  });

  it('неизвестный ключ', async () => {
    const { req } = fakeRequest([]);
    expect(await findActorByApiKey({ presentedKey: KEY, req, secret: SECRET })).toEqual({
      outcome: 'unknown',
    });
  });

  it('отозванный ключ не работает, хотя индекс совпал', async () => {
    const { req } = fakeRequest([
      { apiKeyIndex: index, enableAPIKey: false, id: 42, role: 'ai-editor' },
    ]);
    expect(await findActorByApiKey({ presentedKey: KEY, req, secret: SECRET })).toEqual({
      outcome: 'revoked',
    });
  });

  it('аккаунт без роли прав не получает', async () => {
    const { req } = fakeRequest([{ apiKeyIndex: index, enableAPIKey: true, id: 42, role: null }]);
    expect(await findActorByApiKey({ presentedKey: KEY, req, secret: SECRET })).toEqual({
      outcome: 'unknown',
    });
  });

  it('ищет по отпечатку, одной записью и без поля apiKey в выборке', async () => {
    const { findArgs, req } = fakeRequest([
      { apiKeyIndex: index, enableAPIKey: true, id: 42, role: 'ai-editor' },
    ]);
    await findActorByApiKey({ presentedKey: KEY, req, secret: SECRET });

    const args = findArgs[0] ?? {};
    expect(args.collection).toBe('users');
    expect(args.limit).toBe(1);
    expect(args.where).toEqual({ apiKeyIndex: { equals: index } });
    expect(args.select).toEqual({ email: true, enableAPIKey: true, role: true });
    // `apiKeyIndex` в выборке НЕ запрашивается: Payload его в чтении не отдаёт
    // (замер живым прогоном), и запрос поля, которого не будет в ответе, означал
    // бы проверку, которая не может пройти.
    expect(args.select).not.toHaveProperty('apiKeyIndex');
    expect(args.select).not.toHaveProperty('apiKey');
  });

  it('другой секрет даёт другой отпечаток, то есть ключ чужой установки не подойдёт', async () => {
    const { req } = fakeRequest([
      { apiKeyIndex: index, enableAPIKey: true, id: 42, role: 'ai-editor' },
    ]);
    expect(
      await findActorByApiKey({ presentedKey: KEY, req, secret: 'other-secret' }),
    ).toEqual({ outcome: 'unknown' });
  });
});

describe('logFingerprint', () => {
  it('не содержит исходного значения', () => {
    const value = '203.0.113.7';
    const fingerprint = logFingerprint(value, SECRET);
    expect(fingerprint).not.toContain(value);
    expect(fingerprint).toHaveLength(16);
  });

  it('устойчив: одно значение — один отпечаток', () => {
    expect(logFingerprint('x', SECRET)).toBe(logFingerprint('x', SECRET));
  });
});
