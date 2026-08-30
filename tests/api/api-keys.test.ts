/**
 * Э6-01 — выпуск и отзыв API-ключа, привязка ключа к роли. Живой REST и GraphQL.
 *
 * Каждый негативный сценарий устроен одинаково и по-другому устроен быть не
 * может: (1) читаем состояние в базе ДО, (2) выполняем запрещённую операцию,
 * (3) читаем состояние ПОСЛЕ и доказываем, что оно не изменилось. Один код
 * ответа не доказывает ничего: отказ на уровне поля у Payload молчаливый —
 * поле вырезается, а ответ остаётся 200 с прежним значением.
 *
 * Отдельно проверяется САМОЕ ВАЖНОЕ следствие: ключ, который сервисный аккаунт
 * пытался себе назначить, не аутентифицирует. Совпадение сохранённых значений
 * без этой проверки оставляло бы открытым `apiKeyIndex` — поле, по которому
 * Payload и находит владельца ключа.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TRANSPORTS,
  type TestUser,
  createDoc,
  createUserWithKey,
  findDocs,
  getTestPayload,
  readStored,
  removeUsers,
  restRaw,
  snapshot,
  stamp,
  updateDoc,
  whoAmI,
} from '../../apps/cms/src/testing/api-harness';

const RUN = stamp();

/** Поля, по которым сверяется состояние ключа. */
const KEY_FIELDS = ['apiKey', 'apiKeyIndex', 'enableAPIKey', 'role'] as const;

let admin: TestUser;
let aiEditor: TestUser;
/** Аккаунт, на котором проверяются выпуск и отзыв: его ключ можно ломать. */
let victim: TestUser;

beforeAll(async () => {
  await getTestPayload();
  admin = await createUserWithKey({
    email: `e601-admin-${RUN}@otkritka.test`,
    label: 'admin',
    role: 'admin',
  });
  aiEditor = await createUserWithKey({
    email: `e601-ai-${RUN}@otkritka.test`,
    label: 'ai-editor',
    role: 'ai-editor',
  });
  victim = await createUserWithKey({
    email: `e601-target-${RUN}@otkritka.test`,
    label: 'подопытный ai-editor',
    role: 'ai-editor',
  });
});

afterAll(async () => {
  await removeUsers([admin.id, aiEditor.id, victim.id]);
});

/** Работает ли ключ: успех = запрос «кто я» вернул пользователя. */
async function keyWorks(apiKey: string): Promise<boolean> {
  const me = await whoAmI({ apiKey, label: 'проверка ключа' });
  return me.user !== null;
}

describe('Э6-01 дыра 1: сервисный аккаунт не управляет своим ключом', () => {
  it.each(TRANSPORTS)('%s: ai-editor не перевыпускает СВОЙ ключ', async (transport) => {
    const before = await snapshot('users', aiEditor.id, KEY_FIELDS);
    const podmena = `podmena-${RUN}-${transport}`;

    const result = await updateDoc({
      actor: aiEditor,
      collection: 'users',
      data: { apiKey: podmena, enableAPIKey: true },
      id: aiEditor.id,
      transport,
    });

    expect(result.applied, 'подмена ключа прошла').toBe(false);
    expect(result.errors.join(' ')).toMatch(/администратор/i);

    const after = await snapshot('users', aiEditor.id, KEY_FIELDS);
    expect(after).toEqual(before);

    // Ключевое: подставленное значение не аутентифицирует, а прежний ключ жив.
    expect(await keyWorks(podmena)).toBe(false);
    expect(await keyWorks(aiEditor.apiKey)).toBe(true);
  });

  it.each(TRANSPORTS)('%s: ai-editor не отключает свой ключ', async (transport) => {
    const before = await snapshot('users', aiEditor.id, KEY_FIELDS);

    const result = await updateDoc({
      actor: aiEditor,
      collection: 'users',
      data: { enableAPIKey: false },
      id: aiEditor.id,
      transport,
    });

    expect(result.applied).toBe(false);
    const after = await snapshot('users', aiEditor.id, KEY_FIELDS);
    expect(after).toEqual(before);
    expect(await keyWorks(aiEditor.apiKey)).toBe(true);
  });

  it.each(TRANSPORTS)('%s: ai-editor не трогает ЧУЖОЙ ключ', async (transport) => {
    const before = await snapshot('users', admin.id, KEY_FIELDS);

    const result = await updateDoc({
      actor: aiEditor,
      collection: 'users',
      data: { apiKey: `chuzhoy-${RUN}-${transport}`, enableAPIKey: false },
      id: admin.id,
      transport,
    });

    expect(result.applied).toBe(false);
    expect(await snapshot('users', admin.id, KEY_FIELDS)).toEqual(before);
    expect(await keyWorks(admin.apiKey)).toBe(true);
  });

  it.each(TRANSPORTS)('%s: ai-editor не назначает себе роль admin', async (transport) => {
    const before = await snapshot('users', aiEditor.id, KEY_FIELDS);

    const result = await updateDoc({
      actor: aiEditor,
      collection: 'users',
      data: { role: 'admin' },
      id: aiEditor.id,
      transport,
    });

    expect(result.applied).toBe(false);
    expect(await snapshot('users', aiEditor.id, KEY_FIELDS)).toEqual(before);
    expect((await readStored('users', aiEditor.id)).role).toBe('ai-editor');
  });

  it.each(TRANSPORTS)('%s: ai-editor не заводит нового администратора', async (transport) => {
    const payload = await getTestPayload();
    const before = await payload.count({ collection: 'users', overrideAccess: true });

    const result = await createDoc({
      actor: aiEditor,
      collection: 'users',
      data: {
        email: `e601-samozvanec-${RUN}-${transport}@otkritka.test`,
        password: `parol-${RUN}`,
        role: 'admin',
      },
      transport,
    });

    expect(result.applied).toBe(false);
    const after = await payload.count({ collection: 'users', overrideAccess: true });
    expect(after.totalDocs).toBe(before.totalDocs);
  });

  it('смена собственного пароля сервисному аккаунту по-прежнему доступна', async () => {
    // Положительный контроль: закрыты ключи и роль, а не запись целиком. Без
    // него зелёные негативы держались бы на том, что ai-editor не может ничего.
    const novyy = `parol-${RUN}-novyy`;
    const result = await updateDoc({
      actor: aiEditor,
      collection: 'users',
      data: { password: novyy },
      id: aiEditor.id,
      transport: 'rest',
    });
    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(true);
    expect(await keyWorks(aiEditor.apiKey)).toBe(true);
  });
});

describe('Э6-01 дыра 2: чужой ключ не читается в открытом виде', () => {
  it.each(TRANSPORTS)('%s: в списке пользователей ai-editor ключей нет', async (transport) => {
    const listed = await findDocs({
      actor: aiEditor,
      collection: 'users',
      fields: 'id email role apiKey',
      transport,
    });

    if (transport === 'graphql') {
      // У GraphQL отказ на уровне поля виден иначе, чем у REST: поле в выборке
      // есть, но значение приходит пустым. Пустой список документов тоже был бы
      // «отсутствием ключей», поэтому список обязан быть непустым.
      expect(listed.docs.length).toBeGreaterThan(0);
      for (const doc of listed.docs) {
        expect(doc.apiKey ?? null, `ключ виден у ${String(doc.email)}`).toBeNull();
      }
      return;
    }

    expect(listed.docs.length).toBeGreaterThan(0);
    for (const doc of listed.docs) {
      expect('apiKey' in doc, `ключ виден у ${String(doc.email)}`).toBe(false);
    }
  });

  it('свой собственный ключ сервисный аккаунт тоже не читает', async () => {
    // Ключ у него уже есть — он им и авторизовался; читать его из базы незачем,
    // а разрешение «свой можно» открыло бы поле и на чужих записях при первой
    // же ошибке в условии.
    const me = await whoAmI(aiEditor);
    expect(me.user).not.toBeNull();
    expect('apiKey' in (me.user ?? {})).toBe(false);
  });

  it('admin ключи читает: правило про роль, а не про то, что поле спрятано', async () => {
    const listed = await findDocs({
      actor: admin,
      collection: 'users',
      fields: 'id email apiKey',
      transport: 'rest',
      where: { id: { equals: victim.id } },
    });
    expect(listed.docs).toHaveLength(1);
    expect(listed.docs[0]?.apiKey).toBe(victim.apiKey);
  });
});

describe('Э6-01 дыра 3: отзыв ключа окончателен и проверяем', () => {
  it('ключ работал → admin отключил → тот же ключ получает отказ', async () => {
    expect(await keyWorks(victim.apiKey)).toBe(true);

    const revoked = await updateDoc({
      actor: admin,
      collection: 'users',
      data: { enableAPIKey: false },
      id: victim.id,
      transport: 'rest',
    });
    expect(revoked.errors).toEqual([]);

    expect((await readStored('users', victim.id)).apiKeyIndex ?? null).toBeNull();
    expect(await keyWorks(victim.apiKey)).toBe(false);

    // И самое главное: отозванным ключом не проходит рабочая операция, а не
    // только запрос «кто я».
    const attempt = await createDoc({
      actor: { apiKey: victim.apiKey, label: 'отозванный ключ' },
      collection: 'cards',
      data: {
        robots: 'noindex,follow',
        slug: `e601-otozvan-${RUN}`,
        status: 'draft',
        title: `Отозванный ключ ${RUN}`,
      },
      transport: 'rest',
    });
    expect(attempt.applied).toBe(false);
  });

  it('состояние «флаг выключен, а индекс жив» недостижимо даже для admin', async () => {
    // Стратегия аутентификации Payload ищет пользователя ТОЛЬКО по apiKeyIndex
    // и enableAPIKey не смотрит вовсе. Значит запрос, присылающий один apiKey
    // при выключенном флаге, воскрешал бы ключ в обход отзыва. Проверяется
    // именно этот запрос, и делает его admin — тот, кому поле разрешено.
    const voskreshenie = `voskreshenie-${RUN}`;
    const result = await updateDoc({
      actor: admin,
      collection: 'users',
      data: { apiKey: voskreshenie },
      id: victim.id,
      transport: 'rest',
    });
    expect(result.errors).toEqual([]);

    const stored = await readStored('users', victim.id);
    expect(stored.enableAPIKey ?? false).toBe(false);
    expect(stored.apiKeyIndex ?? null).toBeNull();
    expect(await keyWorks(voskreshenie)).toBe(false);
  });

  it('admin выпускает ключ заново — и он работает', async () => {
    // Положительный контроль отзыва: закрыт обход, а не сама возможность выдать
    // ключ. Без него «ключ не работает» ничего не значило бы.
    const svezhiy = `svezhiy-${RUN}`;
    const result = await updateDoc({
      actor: admin,
      collection: 'users',
      data: { apiKey: svezhiy, enableAPIKey: true },
      id: victim.id,
      transport: 'rest',
    });
    expect(result.errors).toEqual([]);
    expect(await keyWorks(svezhiy)).toBe(true);

    // Ключ наследует роль владельца (ТЗ §9): выданный сервисному аккаунту, он
    // остаётся сервисным — публиковать им нельзя. Это проверяется в Э6-02, здесь
    // достаточно того, что роль в ответе именно та.
    const me = await whoAmI({ apiKey: svezhiy, label: 'свежий ключ' });
    expect(me.user?.role).toBe('ai-editor');
  });

  it('через GraphQL ключ выпускается тем же admin и тоже работает', async () => {
    const gqlKey = `gql-${RUN}`;
    const result = await updateDoc({
      actor: admin,
      collection: 'users',
      data: { apiKey: gqlKey, enableAPIKey: true },
      id: victim.id,
      transport: 'graphql',
    });
    expect(result.errors).toEqual([]);
    expect(await keyWorks(gqlKey)).toBe(true);

    // Правка, не касающаяся ключа, ключ НЕ гасит. Проверка обязательна: правило
    // согласования индекса читает прежнее значение из документа, а `apiKeyIndex`
    // объявлен скрытым полем. Если бы прежнее значение до правила не доходило,
    // любое частичное обновление пользователя молча отзывало бы его ключ — и
    // заметили бы это по неработающей интеграции, а не по красному тесту.
    const renamed = await updateDoc({
      actor: admin,
      collection: 'users',
      data: { email: `e601-target-pereimenovan-${RUN}@otkritka.test` },
      id: victim.id,
      transport: 'rest',
    });
    expect(renamed.errors).toEqual([]);
    expect(await keyWorks(gqlKey)).toBe(true);
  });
});

describe('Э6-01: сам Payload перечисляет права сервисного аккаунта так же', () => {
  it('в отчёте /api/access у ai-editor нет ни чтения ключа, ни правки роли', async () => {
    // Перекрёстная проверка: отчёт о правах строит САМ Payload, прогоняя
    // предикаты доступа. Если бы правило поля было объявлено, но не применялось
    // (случай коллекции payload-jobs на этапе 5), негативные сценарии выше могли
    // бы проходить по другой причине — например, потому что ai-editor вообще не
    // видит записи. Здесь видно ровно то, что он видит и чего не может.
    const response = await restRaw({ actor: aiEditor, method: 'GET', segments: ['access'] });
    expect(response.status).toBe(200);

    const report = (await response.json()) as {
      collections?: Record<string, { fields?: Record<string, Record<string, unknown>> }>;
    };
    const users = report.collections?.users;
    const fields = users?.fields ?? {};

    // Ключ не читается вовсе: поля нет в отчёте.
    expect(Object.keys(fields)).not.toContain('apiKey');
    expect(Object.keys(fields)).not.toContain('apiKeyIndex');

    // Флаг и роль читаются, но не пишутся.
    expect(fields.enableAPIKey?.create ?? false).toBe(false);
    expect(fields.enableAPIKey?.update ?? false).toBe(false);
    expect(fields.role?.read).toBe(true);
    expect(fields.role?.create ?? false).toBe(false);
    expect(fields.role?.update ?? false).toBe(false);

    // Коллекция пользователей: читать можно, создавать и удалять — нет.
    const collectionPermissions = users as Record<string, unknown> | undefined;
    expect(collectionPermissions?.read).toBe(true);
    expect(collectionPermissions?.create ?? false).toBe(false);
    expect(collectionPermissions?.delete ?? false).toBe(false);
  });

  it('мусорный ключ не даёт ни пользователя, ни прав', async () => {
    const me = await whoAmI({ apiKey: `net-takogo-${RUN}`, label: 'мусор' });
    expect(me.user).toBeNull();
  });
});
