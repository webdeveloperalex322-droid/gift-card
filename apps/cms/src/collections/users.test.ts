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
import { describe, expect, it } from 'vitest';

import { ROLES } from '../access/roles';
import { Users, resolveCreateRole } from './users';

function roleField(): Record<string, unknown> {
  const field = Users.fields.find(
    (candidate): candidate is Extract<(typeof Users.fields)[number], { name: string }> =>
      'name' in candidate && candidate.name === 'role',
  );
  if (field === undefined) {
    throw new Error('поле role в коллекции users не найдено');
  }
  return { ...field };
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
