/**
 * Э6-04 — мутации через API прослеживаются в `seo-history` с указанием ключа
 * (ТЗ §9, §8.1, §11).
 *
 * ЧТО УЖЕ БЫЛО И ЧЕГО НЕ ХВАТАЛО. Разбор автора — чистая функция
 * `describeHistoryAuthor` (`apps/cms/src/collections/seo-history-diff.ts`), и она
 * покрыта юнит-тестом: пользователь со стратегией `api-key` даёт
 * `viaApiKey: true`. Но признак `_strategy` проставляет САМ Payload при
 * аутентификации по ключу, и юнит-тест подаёт его на вход руками — то есть
 * проверяет разбор, а не то, что до разбора вообще доходит нужное значение.
 * Здесь мутация выполняется НАСТОЯЩИМ запросом с настоящим ключом, а журнал
 * читается из базы.
 *
 * КОНТРОЛЬНАЯ ПОЛОВИНА ОБЯЗАТЕЛЬНА. Утверждение «по ключу отмечено как по ключу»
 * зелёное и в том случае, если признак жёстко выставлен в `true` всегда. Поэтому
 * ниже один и тот же администратор правит одну и ту же запись двумя способами —
 * своим API-ключом и сессией-cookie, — и признак обязан различаться. Роль при
 * этом проверяется вторым измерением: `ai-editor` по ключу против `admin` по
 * ключу.
 *
 * ОБЪЁМ ЖУРНАЛА — УЗКОЕ ЧТЕНИЕ §11, И ЭТО НАЗВАНО ЗДЕСЬ, А НЕ УМОЛЧАНО.
 * Формулировка ТЗ §11 говорит о «логировании всех мутаций». `seo-history` в этом
 * проекте — журнал ОТСЛЕЖИВАЕМЫХ SEO-полей (`TRACKED_SEO_FIELDS`: title, h1,
 * metaDescription, slug, path, canonical, robots, status), а не общий аудит-лог
 * всех операций: правка `alt`, подписи, привязка к подборкам и загрузка
 * изображения в него не попадают. Это осознанный выбор до ответа человека, а не
 * недосмотр; тест «неотслеживаемое поле в журнал не попадает» ниже фиксирует
 * границу явно — расширение объёма обязано начаться с его падения, а не с
 * молчаливого разрастания схемы. Само расхождение заведено вопросом человеку
 * (`docs/otkrytye-voprosy.md`, раздел этапа 6, строка Э6-04-A): комментарий в
 * тесте — это не способ закрыть вопрос, а способ не потерять его до ответа.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ANONYMOUS,
  TRANSPORTS,
  type TestUser,
  assertRemoved,
  createDoc,
  createUserWithKey,
  getTestPayload,
  openSession,
  readStored,
  removeContent,
  removeUsers,
  restRaw,
  stamp,
  updateDoc,
} from '../../apps/cms/src/testing/api-harness';
import type { SeoHistory } from '../../apps/cms/src/payload-types';

const RUN = stamp();

let aiEditor: TestUser;
let admin: TestUser;
let adminCookie: string;

const createdCards: (number | string)[] = [];

/**
 * Журнал по карточке — правами системы и в порядке появления.
 *
 * `depth: 0` намеренно: связь `changedBy` нужна идентификатором, а не
 * развёрнутым документом, иначе сравнение с идентификатором аккаунта пришлось бы
 * писать через свойство объекта и оно молча стало бы `undefined`. Тип записи —
 * сгенерированный `SeoHistory`, а не ручной дубль: Payload и так возвращает
 * типизированные документы.
 */
async function historyOf(cardId: number | string): Promise<readonly SeoHistory[]> {
  const payload = await getTestPayload();
  const { docs } = await payload.find({
    collection: 'seo-history',
    depth: 0,
    limit: 200,
    overrideAccess: true,
    sort: 'createdAt',
    where: {
      and: [
        { documentCollection: { equals: 'cards' } },
        { documentId: { equals: String(cardId) } },
      ],
    },
  });
  return docs;
}

/** Последняя запись журнала по конкретному полю. */
async function lastEntry(
  cardId: number | string,
  field: string,
): Promise<SeoHistory | undefined> {
  const entries = (await historyOf(cardId)).filter((entry) => entry.field === field);
  return entries.at(-1);
}

beforeAll(async () => {
  await getTestPayload();
  aiEditor = await createUserWithKey({
    email: `e604-ai-${RUN}@otkritka.test`,
    label: 'ai-editor',
    role: 'ai-editor',
  });
  admin = await createUserWithKey({
    email: `e604-admin-${RUN}@otkritka.test`,
    label: 'admin',
    role: 'admin',
  });
  adminCookie = await openSession(admin);
});

afterAll(async () => {
  await removeContent('cards', createdCards);
  await assertRemoved('cards', createdCards);
  await removeUsers([aiEditor.id, admin.id]);
});

describe.each(TRANSPORTS)('Э6-04 (%s): трасса изменений от сервисного аккаунта', (transport) => {
  let cardId: number | string;
  const slug = `e604-audit-${RUN}-${transport}`;

  beforeAll(async () => {
    const created = await createDoc({
      actor: aiEditor,
      collection: 'cards',
      data: {
        metaDescription: `Э6-04: описание карточки аудита ${RUN} (${transport})`,
        robots: 'noindex,follow',
        slug,
        status: 'draft',
        title: `Э6-04: карточка аудита ${RUN} (${transport})`,
      },
      transport,
    });
    if (created.doc?.id === undefined) {
      throw new Error(
        `Э6-04 (${transport}): карточка не создалась (${created.errors.join('; ')}), ` +
          'проверять журнал не на чем.',
      );
    }
    cardId = created.doc.id as number | string;
    createdCards.push(cardId);
  });

  it('создание записи ключом уже оставляет след с указанием ключа и роли', async () => {
    const entries = await historyOf(cardId);
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      expect(entry.operation).toBe('create');
      expect(entry.authorRole).toBe('ai-editor');
      expect(entry.viaApiKey).toBe(true);
      expect(entry.changedBy).toBe(aiEditor.id);
    }

    // Начало трассы URL: первый slug зафиксирован как «пусто → значение».
    const slugEntry = entries.find((entry) => entry.field === 'slug');
    expect(slugEntry?.previousValue ?? null).toBeNull();
    expect(slugEntry?.nextValue).toBe(slug);

    // Статус тоже отслеживаемое поле: без него в журнале не было бы момента, с
    // которого запись стала черновиком.
    expect(entries.some((entry) => entry.field === 'status')).toBe(true);
  });

  it('правка SEO-поля ключом фиксируется старым и новым значением', async () => {
    const before = (await readStored('cards', cardId)).title;
    const title = `Э6-04: правленый заголовок ${RUN} (${transport})`;

    const result = await updateDoc({
      actor: aiEditor,
      collection: 'cards',
      data: { title },
      id: cardId,
      transport,
    });
    expect(result.errors).toEqual([]);
    expect((await readStored('cards', cardId)).title).toBe(title);

    const entry = await lastEntry(cardId, 'title');
    expect(entry?.operation).toBe('update');
    expect(entry?.previousValue).toBe(before);
    expect(entry?.nextValue).toBe(title);
    expect(entry?.viaApiKey).toBe(true);
    expect(entry?.authorRole).toBe('ai-editor');
    expect(entry?.changedBy).toBe(aiEditor.id);
  });

  it('одна мутация с двумя SEO-полями даёт две записи, и обе помечены ключом', async () => {
    const beforeCount = (await historyOf(cardId)).length;
    const title = `Э6-04: второй заголовок ${RUN} (${transport})`;
    const metaDescription = `Э6-04: второе описание ${RUN} (${transport})`;

    const result = await updateDoc({
      actor: aiEditor,
      collection: 'cards',
      data: { metaDescription, title },
      id: cardId,
      transport,
    });
    expect(result.errors).toEqual([]);

    const entries = await historyOf(cardId);
    // Журнал ведётся по ПОЛЯМ, а не по запросам: одна правка двух полей — две
    // строки. Иначе разбор «что именно изменилось» упирался бы в чтение
    // документа целиком.
    expect(entries.length).toBe(beforeCount + 2);

    const added = entries.slice(beforeCount);
    expect(new Set(added.map((entry) => entry.field))).toEqual(
      new Set(['metaDescription', 'title']),
    );
    for (const entry of added) {
      expect(entry.operation).toBe('update');
      expect(entry.viaApiKey).toBe(true);
      expect(entry.authorRole).toBe('ai-editor');
      expect(entry.changedBy).toBe(aiEditor.id);
    }
    expect(added.find((entry) => entry.field === 'title')?.nextValue).toBe(title);
    expect(added.find((entry) => entry.field === 'metaDescription')?.nextValue).toBe(
      metaDescription,
    );
  });

  it('неотслеживаемое поле в журнал не попадает: объём §11 прочитан узко', async () => {
    const beforeCount = (await historyOf(cardId)).length;

    const result = await updateDoc({
      actor: aiEditor,
      collection: 'cards',
      data: { caption: `Э6-04: правленая подпись ${RUN} (${transport})` },
      id: cardId,
      transport,
    });
    expect(result.errors).toEqual([]);

    // Подпись изменилась, а журнал не вырос: `seo-history` — журнал
    // отслеживаемых SEO-полей, а не общий аудит-лог всех операций. Граница
    // зафиксирована тестом, чтобы её расширение начиналось с осознанной правки.
    expect((await historyOf(cardId)).length).toBe(beforeCount);
  });
});

describe('Э6-04: признак ключа различает СПОСОБ обращения, а не человека', () => {
  let cardId: number | string;

  beforeAll(async () => {
    const created = await createDoc({
      actor: aiEditor,
      collection: 'cards',
      data: {
        metaDescription: `Э6-04: описание карточки контроля ${RUN}`,
        robots: 'noindex,follow',
        slug: `e604-kontrol-${RUN}`,
        status: 'draft',
        title: `Э6-04: карточка контроля ${RUN}`,
      },
      transport: 'rest',
    });
    if (created.doc?.id === undefined) {
      throw new Error(`Э6-04: карточка контроля не создалась (${created.errors.join('; ')}).`);
    }
    cardId = created.doc.id as number | string;
    createdCards.push(cardId);
  });

  it('администратор своим API-ключом: viaApiKey = true, роль admin', async () => {
    const title = `Э6-04: заголовок от админа по ключу ${RUN}`;
    const result = await updateDoc({
      actor: admin,
      collection: 'cards',
      data: { title },
      id: cardId,
      transport: 'rest',
    });
    expect(result.errors).toEqual([]);

    const entry = await lastEntry(cardId, 'title');
    expect(entry?.nextValue).toBe(title);
    expect(entry?.viaApiKey).toBe(true);
    expect(entry?.authorRole).toBe('admin');
    expect(entry?.changedBy).toBe(admin.id);
  });

  it('тот же администратор сессией-cookie: viaApiKey = false', async () => {
    const title = `Э6-04: заголовок от админа из админки ${RUN}`;
    const response = await restRaw({
      actor: ANONYMOUS,
      body: { title },
      headers: { Cookie: adminCookie },
      method: 'PATCH',
      segments: ['cards', String(cardId)],
    });
    expect(response.status).toBe(200);
    // Правка действительно применилась: иначе «признак не поднят» объяснялось бы
    // тем, что записи в журнале просто нет.
    expect((await readStored('cards', cardId)).title).toBe(title);

    const entry = await lastEntry(cardId, 'title');
    expect(entry?.nextValue).toBe(title);
    // Тот же аккаунт, та же запись, то же поле — и другой признак. Значит
    // `viaApiKey` отмечает способ обращения, а не роль и не константу.
    expect(entry?.viaApiKey).toBe(false);
    expect(entry?.authorRole).toBe('admin');
    expect(entry?.changedBy).toBe(admin.id);
  });
});

/**
 * Полный состав полей записи журнала.
 *
 * Список ЗАКРЫТЫЙ и в этом весь смысл: он превращает «в журнале нет отпечатка
 * ключа» из наблюдения в правило. Проверка «в записи нет поля `apiKeyIndex`»,
 * стоявшая здесь раньше, не могла покраснеть никогда — такого поля в схеме нет и
 * взяться ему было неоткуда, то есть тест не фиксировал ничего. Сравнение с
 * полным списком краснеет на ЛЮБОМ новом поле `seo-history`: и на отпечатке
 * ключа, и на чём угодно ещё, что кто-то добавит в аудит между делом. Список
 * обновляют вместе со схемой — осознанно, а не задним числом.
 */
const HISTORY_ENTRY_FIELDS: readonly string[] = [
  'authorRole',
  'changedAt',
  'changedBy',
  'createdAt',
  'documentCollection',
  'documentId',
  'documentPath',
  'field',
  'id',
  'nextValue',
  'operation',
  'previousValue',
  'updatedAt',
  'viaApiKey',
];

describe('Э6-04: что журнал НЕ различает', () => {
  it('перевыпуск ключа у того же аккаунта в журнале неотличим', async () => {
    const created = await createDoc({
      actor: aiEditor,
      collection: 'cards',
      data: {
        metaDescription: `Э6-04: описание карточки перевыпуска ${RUN}`,
        robots: 'noindex,follow',
        slug: `e604-perevypusk-${RUN}`,
        status: 'draft',
        title: `Э6-04: карточка перевыпуска ${RUN}`,
      },
      transport: 'rest',
    });
    if (created.doc?.id === undefined) {
      throw new Error(
        `Э6-04: карточка перевыпуска не создалась (${created.errors.join('; ')}), ` +
          'состав полей журнала проверять не на чем.',
      );
    }
    const cardId = created.doc.id as number | string;
    createdCards.push(cardId);

    const entry = await lastEntry(cardId, 'title');
    expect(entry, 'записи журнала по полю title нет — проверять состав полей не на чем').toBeDefined();

    // Ограничение модели, названное прямо: журнал хранит АККАУНТ автора и
    // признак «пришло по ключу», но не отпечаток конкретного ключа. Отпечаток
    // существует — Payload держит его в `users.apiKeyIndex`, и при перевыпуске
    // он меняется, — однако в записи журнала его нет. Пока действует модель
    // «один пользователь = один ключ» (Ч-16: ровно два аккаунта), различать
    // перевыпуски нечем и незачем.
    //
    // Проверяется это составом полей записи ЦЕЛИКОМ, а не отсутствием одного
    // угаданного имени: набор полей — и есть то, что журнал способен различать.
    const actual = Object.keys(entry ?? {}).sort();
    const unexpected = actual.filter((field) => !HISTORY_ENTRY_FIELDS.includes(field));
    expect(
      unexpected,
      'в записи seo-history появилось поле, которого нет в HISTORY_ENTRY_FIELDS. Если это ' +
        'осознанное расширение аудита — обновите список; если поле принесло с собой новую ' +
        'сущность в журнале (например отпечаток ключа), это меняет ответ на вопрос «что ' +
        'журнал различает», и такой ответ даёт человек (docs/otkrytye-voprosy.md, Э6-04-A).',
    ).toEqual([]);
    // Обратная половина: список не должен молча похудеть. Исчезнувшее поле —
    // это исчезнувший столбец аудита, и заметить его нечем, если сравнивать
    // только «нет лишнего».
    const missing = HISTORY_ENTRY_FIELDS.filter((field) => !actual.includes(field));
    expect(missing, 'поле из состава записи seo-history пропало из ответа').toEqual([]);

    expect(entry?.changedBy).toBe(aiEditor.id);
    expect(entry?.viaApiKey).toBe(true);
  });
});
