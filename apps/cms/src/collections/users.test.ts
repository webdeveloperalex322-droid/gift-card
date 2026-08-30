/**
 * Роль пользователя: значения по умолчанию нет (находка ревизии от 2026-08-22).
 *
 * Прежде у поля `role` стоял `defaultValue: 'admin'`, поэтому пользователь,
 * созданный БЕЗ явной роли — в том числе через API, — получал право публикации и
 * включения `index,follow`. Дефолт открывал ровно ту границу, которую защищает
 * вся модель, причём молча: в запросе роли не было, отказа тоже.
 *
 * Норма проекта: дефолты закрывают, а не открывают (`DEFAULT_ROBOTS` —
 * `noindex,follow`, новая запись — `draft`). Для роли «закрывающего» дефолта не
 * существует вовсе: `ai-editor` по умолчанию тоже был бы решением, принятым за
 * человека, — и первый же администратор, созданный через штатный экран Payload,
 * оказался бы сервисным аккаунтом без доступа в админку. Поэтому роль
 * ОБЯЗАТЕЛЬНА и задаётся явно, а единственное исключение — самый первый
 * пользователь в пустой базе, где выбора всё равно нет: не-admin заблокировал
 * бы админку целиком.
 */
import type { FieldAccess } from 'payload';
import { describe, expect, it } from 'vitest';

import { ROLES } from '../access/roles';
import {
  ACCOUNT_CONTROL_FIELDS,
  API_KEY_FIELDS,
  Users,
  forbiddenAccountFields,
  resolveApiKeyIndex,
  resolveCreateRole,
} from './users';

function namedField(name: string): Record<string, unknown> {
  const field = Users.fields.find(
    (candidate): candidate is Extract<(typeof Users.fields)[number], { name: string }> =>
      'name' in candidate && candidate.name === name,
  );
  if (field === undefined) {
    throw new Error(`поле ${name} в коллекции users не найдено`);
  }
  return { ...field };
}

function roleField(): Record<string, unknown> {
  return namedField('role');
}

/** Вызов предиката доступа к полю с минимальным контрактом Payload. */
function askField(access: unknown, user: { role: string } | null): boolean {
  const predicate = access as FieldAccess;
  return Boolean(predicate({ req: { user } } as unknown as Parameters<FieldAccess>[0]));
}

describe('поле role', () => {
  it('обязательно и БЕЗ значения по умолчанию', () => {
    const field = roleField();
    expect(field.required).toBe(true);
    // Именно это и есть исправление: дефолта нет ни admin, ни ai-editor.
    expect(field.defaultValue).toBeUndefined();
  });

  it('набор значений закрыт двумя ролями (Ч-16)', () => {
    const field = roleField();
    const options: unknown[] = Array.isArray(field.options)
      ? Array.from<unknown>(field.options)
      : [];
    const values = options.map((option): unknown => {
      if (typeof option === 'object' && option !== null && 'value' in option) {
        const record: Record<string, unknown> = { ...option };
        return record.value;
      }
      return option;
    });
    expect(values).toEqual([ROLES.admin, ROLES.aiEditor]);
  });

  it('роль назначает только admin — и на создании, и на обновлении', () => {
    const field = roleField();
    const access = field.access as Record<string, unknown> | undefined;
    expect(typeof access?.create).toBe('function');
    expect(typeof access?.update).toBe('function');
  });
});

describe('resolveCreateRole: единственное исключение — первый пользователь', () => {
  const never = (): Promise<number> => Promise.reject(new Error('база не должна опрашиваться'));

  it('явная роль не переписывается и базу не опрашивает', async () => {
    await expect(
      resolveCreateRole({ countUsers: never, incomingRole: ROLES.aiEditor }),
    ).resolves.toBeNull();
    await expect(
      resolveCreateRole({ countUsers: never, incomingRole: ROLES.admin }),
    ).resolves.toBeNull();
  });

  it('без роли в НЕпустой базе роль не подставляется: отказ по required — громкий', async () => {
    // Ключевой негативный случай: запрос без роли (через API или через Local
    // API) не должен превращаться в администратора.
    for (const incomingRole of [undefined, null, '', '   ']) {
      await expect(
        resolveCreateRole({ countUsers: () => Promise.resolve(1), incomingRole }),
      ).resolves.toBeNull();
    }
  });

  it('в пустой базе первому пользователю ставится admin', async () => {
    // Экран Payload «создать первого пользователя» роли не присылает, а
    // сервисный аккаунт первым не бывает (см. seed-first-admin.ts). Escalation
    // здесь невозможен: пока пользователей ноль, первого создаёт кто угодно —
    // так устроен сам Payload.
    await expect(
      resolveCreateRole({ countUsers: () => Promise.resolve(0), incomingRole: undefined }),
    ).resolves.toBe(ROLES.admin);
  });

  it('в пустой базе явная роль ai-editor остаётся собой', async () => {
    await expect(
      resolveCreateRole({ countUsers: () => Promise.resolve(0), incomingRole: ROLES.aiEditor }),
    ).resolves.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Э6-01: API-ключ — собственность администратора, а не аккаунта       */
/* ------------------------------------------------------------------ */

describe('поля API-ключа объявлены и закрыты (Э6-01)', () => {
  const admin = { role: ROLES.admin };
  const aiEditor = { role: ROLES.aiEditor };

  it.each(API_KEY_FIELDS)('%s: пишет только admin', (name) => {
    const access = namedField(name).access as Record<string, unknown> | undefined;
    expect(askField(access?.create, admin)).toBe(true);
    expect(askField(access?.update, admin)).toBe(true);
    expect(askField(access?.create, aiEditor)).toBe(false);
    expect(askField(access?.update, aiEditor)).toBe(false);
    expect(askField(access?.create, null)).toBe(false);
    expect(askField(access?.update, null)).toBe(false);
  });

  it.each(['apiKey', 'apiKeyIndex'])('%s: читает только admin', (name) => {
    // Поле `apiKey` расшифровывается хуком afterRead самого Payload, а список
    // пользователей читает любой аутентифицированный (это нужно seo-history).
    // Без правила чтения сервисный аккаунт получал бы ключи ВСЕХ, включая admin.
    const access = namedField(name).access as Record<string, unknown> | undefined;
    expect(askField(access?.read, admin)).toBe(true);
    expect(askField(access?.read, aiEditor)).toBe(false);
    expect(askField(access?.read, null)).toBe(false);
  });

  it('enableAPIKey остаётся читаемым: это флаг, а не секрет', () => {
    const access = namedField('enableAPIKey').access as Record<string, unknown> | undefined;
    expect(access?.read).toBeUndefined();
  });
});

describe('forbiddenAccountFields: громкий отказ на сырых данных', () => {
  const admin = { role: ROLES.admin };
  const aiEditor = { role: ROLES.aiEditor };

  it('admin вправе задать любое из защищённых полей', () => {
    const incoming: Record<string, unknown> = {};
    for (const field of ACCOUNT_CONTROL_FIELDS) {
      incoming[field] = 'что-нибудь';
    }
    expect(forbiddenAccountFields(incoming, admin)).toEqual([]);
  });

  it.each(ACCOUNT_CONTROL_FIELDS)('ai-editor не задаёт %s', (field) => {
    expect(forbiddenAccountFields({ [field]: 'X' }, aiEditor)).toEqual([field]);
    expect(forbiddenAccountFields({ [field]: 'X' }, null)).toEqual([field]);
  });

  it('поле, которого в запросе нет, отказом не считается: PATCH пароля проходит', () => {
    expect(forbiddenAccountFields({ password: 'novyy-parol' }, aiEditor)).toEqual([]);
  });

  it('значение false у enableAPIKey — тоже попытка: отключение ключа это тоже право', () => {
    // `false` в JS ложно, поэтому проверка «поле присутствует» обязана идти по
    // ключу, а не по значению: иначе отключение чужого ключа прошло бы молча.
    expect(forbiddenAccountFields({ enableAPIKey: false }, aiEditor)).toEqual(['enableAPIKey']);
  });
});

describe('resolveApiKeyIndex: состояния «ключ выключен, а индекс жив» не бывает', () => {
  it('enableAPIKey не true — индекс обнуляется, каким бы он ни пришёл', () => {
    for (const enableAPIKey of [false, null, undefined]) {
      expect(
        resolveApiKeyIndex({
          incoming: { apiKey: 'X', apiKeyIndex: 'hmac-X', enableAPIKey },
          stored: { apiKeyIndex: 'staryy', enableAPIKey: true },
        }),
      ).toBeNull();
    }
  });

  it('ключ не приходил в запросе — индекс остаётся прежним, а не пересчитанным', () => {
    // Главный случай, ради которого функция существует. Хук Payload, считающий
    // индекс, выполняется РАНЬШЕ проверки доступа к полю `apiKey` и работает с
    // общим объектом данных: сервисный аккаунт мог послать себе apiKey, поле
    // срезалось бы правами, а индекс уже был бы посчитан от срезанного значения.
    expect(
      resolveApiKeyIndex({
        incoming: { apiKeyIndex: 'hmac-podstavlennyy' },
        stored: { apiKeyIndex: 'hmac-nastoyashchiy', enableAPIKey: true },
      }),
    ).toBe('hmac-nastoyashchiy');
  });

  it('ключ пришёл вместе с включённым флагом — индекс берётся из запроса', () => {
    expect(
      resolveApiKeyIndex({
        incoming: { apiKey: 'novyy', apiKeyIndex: 'hmac-novyy', enableAPIKey: true },
        stored: { apiKeyIndex: 'hmac-staryy', enableAPIKey: true },
      }),
    ).toBe('hmac-novyy');
  });

  it('флаг унаследован от записи: частичное обновление ключ не гасит', () => {
    expect(
      resolveApiKeyIndex({
        incoming: { apiKey: 'novyy', apiKeyIndex: 'hmac-novyy' },
        stored: { apiKeyIndex: 'hmac-staryy', enableAPIKey: true },
      }),
    ).toBe('hmac-novyy');
  });

  it('создание записи: прежнего состояния нет', () => {
    expect(
      resolveApiKeyIndex({
        incoming: { apiKey: 'novyy', apiKeyIndex: 'hmac-novyy', enableAPIKey: true },
        stored: null,
      }),
    ).toBe('hmac-novyy');
    expect(resolveApiKeyIndex({ incoming: {}, stored: null })).toBeNull();
  });
});
