/**
 * Э6-02, отрицательная половина: что сервисный аккаунт НЕ может — доказано
 * живым REST и живым GraphQL.
 *
 * УСТРОЙСТВО КАЖДОГО СЦЕНАРИЯ ОДИНАКОВО и другим быть не может:
 *   1. читаем состояние в базе ДО операции (правами системы, а не ключом
 *      проверяемой роли — иначе обе половины теста ошиблись бы согласованно);
 *   2. выполняем запрещённую операцию через API;
 *   3. читаем состояние ПОСЛЕ и требуем, чтобы оно не изменилось.
 *
 * Код ответа сам по себе не доказывает НИЧЕГО: у Payload отказ на уровне поля
 * молчаливый — поле вырезается из входных данных, на его место встаёт прежнее
 * значение, ответ 200. Поэтому запреты делятся на два вида, и вид указан у
 * каждого ЯВНО, параметром {@link Outcome}, а не комментарием:
 *   - `loud` — правило живёт в хуке `beforeOperation` или в access control
 *     операции, запрос отклонён целиком;
 *   - `silent` — правило живёт только в access control ПОЛЯ, ответ 200 с прежним
 *     значением. Защита работает, внятного отказа нет.
 *
 * ПОЧЕМУ ВИД ОТКАЗА ОБЯЗАТЕЛЕН, А НЕ НЕОБЯЗАТЕЛЕН. У тихого отказа единственное
 * доказательство — совпадение снимков «до» и «после». Но снимки совпадают и
 * тогда, когда операция не выполнялась ВООБЩЕ: отвалилась база, опечатка в
 * идентификаторе, запрос не прошёл разбор GraphQL. Такой сценарий зелёный при
 * полностью открытых правах. Поэтому у тихого отказа сверх равенства снимков
 * требуется, чтобы операция реально ВЫПОЛНИЛАСЬ (`applied === true`), а у
 * громкого — чтобы отказ был именно отказом Payload, а не ошибкой запроса
 * (последнее ловит сам гарнизон: `graphqlRaw` падает на ошибке, у которой нет
 * `path`, то есть на запросе, не дошедшем до резолвера).
 *
 * Пакетные операции проверяются только через REST: мутации «обновить по where»
 * в схеме GraphQL Payload не выпускает вовсе. Это свойство фреймворка, а не
 * пробел набора.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type PublishedFixture,
  createPublishedFixture,
  removePublishedFixture,
} from '../../apps/cms/src/testing/api-fixtures';
import {
  TRANSPORTS,
  type ApiResult,
  type CollectionSlug,
  type TestUser,
  type Transport,
  assertRemoved,
  bulkUpdate,
  createDoc,
  createUserWithKey,
  deleteDoc,
  findDocs,
  getTestPayload,
  readStored,
  removeContent,
  removeUsers,
  snapshot,
  stamp,
  updateDoc,
  updateGlobal,
} from '../../apps/cms/src/testing/api-harness';

const RUN = stamp();

/**
 * Вид отказа. Не украшение: от него зависит, ЧТО именно требуется доказать сверх
 * равенства снимков (см. шапку файла).
 */
type Outcome = 'loud' | 'silent';

/** Поля карточки, по которым сверяется «до» и «после». */
const CARD_FIELDS = [
  'canonical',
  'image',
  'pHash',
  'publishedAt',
  'robots',
  'slug',
  'status',
  'updatedContentAt',
] as const;

/**
 * Поля редиректа для снимка.
 *
 * `code` здесь ОБЯЗАТЕЛЕН: подмена 301 → 410 превращает перенос в удаление,
 * то есть меняет ответ сайта на живом URL. Раньше на его месте стояло `status` —
 * поля с таким именем у коллекции нет вовсе, и снимок сравнивал `null` с `null`,
 * не замечая ни подмены кода, ни чего-либо ещё в этом поле.
 */
const REDIRECT_FIELDS = ['code', 'from', 'to'] as const;

/** Поля подборки: к тем же добавлены те, что формируют путь. */
const COLLECTION_FIELDS = [
  'canonical',
  'nodeKind',
  'parent',
  'path',
  'publishedAt',
  'robots',
  'slug',
  'status',
  'updatedContentAt',
] as const;

let admin: TestUser;
let aiEditor: TestUser;
let fixture: PublishedFixture;
let redirectId: number;

beforeAll(async () => {
  const payload = await getTestPayload();
  admin = await createUserWithKey({
    email: `e602n-admin-${RUN}@otkritka.test`,
    label: 'admin',
    role: 'admin',
  });
  aiEditor = await createUserWithKey({
    email: `e602n-ai-${RUN}@otkritka.test`,
    label: 'ai-editor',
    role: 'ai-editor',
  });
  fixture = await createPublishedFixture({
    adminId: admin.id,
    editorId: aiEditor.id,
    run: RUN,
  });

  // Редирект, который сервисный аккаунт будет пытаться переписать. Создаёт его
  // система: право создавать проверяется отдельным сценарием.
  const redirect = await payload.create({
    collection: 'redirects',
    data: {
      from: `/e602n-staryy-${RUN}`,
      code: '301',
      comment: `Э6-02: контрольный редирект ${RUN}`,
      to: `/e602n-novyy-${RUN}`,
    },
    overrideAccess: true,
  });
  redirectId = redirect.id;
}, 240_000);

/**
 * Уборка НЕ глушит ошибки: прогон идёт на рабочей базе, и оставленный в ней
 * редирект — это HTTP-поведение сайта, а не мусор в таблице.
 */
afterAll(async () => {
  const payload = await getTestPayload();
  await removePublishedFixture(fixture);

  // Одним условием, а не «по id и на всякий случай ещё по шаблону»: второй
  // вызов с проглоченной ошибкой раньше маскировал неудачу первого.
  const removed = await payload.delete({
    collection: 'redirects',
    overrideAccess: true,
    where: { from: { like: 'e602n-' } },
  });
  expect(removed.errors, 'редиректы прогона остались в базе').toEqual([]);
  await assertRemoved('redirects', [redirectId]);

  await removeUsers([admin.id, aiEditor.id]);
});

/**
 * Требует, чтобы операция действительно ВЫПОЛНИЛАСЬ или была отклонена — ровно
 * так, как обещано видом отказа.
 *
 * Это вторая половина доказательства, без которой первая (равенство снимков)
 * ничего не стоит: не выполнившийся запрос тоже оставляет состояние прежним.
 */
function expectOutcome(result: ApiResult, outcome: Outcome, what: string): void {
  if (outcome === 'silent') {
    expect(
      result.applied,
      `${what}: тихий отказ обязан быть УСПЕШНЫМ ответом с прежним значением — ` +
        'Payload вырезает поле и отвечает 200. Здесь операция не выполнилась вовсе, ' +
        'то есть совпадение снимков «до» и «после» доказывает не защиту, а то, что ' +
        `запрос не дошёл. Ответ ${String(result.status)}, ошибки: ${result.errors.join(' | ')}`,
    ).toBe(true);
    return;
  }
  expect(result.applied, `${what}: громкий отказ не сработал, операция принята`).toBe(false);
  expect(
    result.errors.length,
    `${what}: отказ обещан громким, но текста отказа нет`,
  ).toBeGreaterThan(0);
}

/**
 * Общий каркас негативного сценария: снимок до → попытка → снимок после.
 *
 * Возвращает результат операции, чтобы вызывающий мог дополнительно потребовать
 * КОНКРЕТНОЙ формулировки отказа там, где важна причина, а не только факт.
 */
async function attemptUpdate(args: {
  readonly collection: CollectionSlug;
  readonly data: Record<string, unknown>;
  readonly fields: readonly string[];
  readonly id: number | string;
  readonly outcome: Outcome;
  readonly transport: Transport;
  readonly what: string;
}): Promise<ApiResult> {
  const before = await snapshot(args.collection, args.id, args.fields);
  const result = await updateDoc({
    actor: aiEditor,
    collection: args.collection,
    data: args.data,
    id: args.id,
    transport: args.transport,
  });
  const after = await snapshot(args.collection, args.id, args.fields);
  expect(after, `${args.what}: состояние изменилось, а не должно было`).toEqual(before);
  expectOutcome(result, args.outcome, args.what);
  return result;
}

describe.each(TRANSPORTS)('Э6-02 (%s): границы сервисного аккаунта', (transport) => {
  /* ---------------------------------------------------------------- */
  /* Публикация                                                        */
  /* ---------------------------------------------------------------- */

  it('не публикует карточку, готовую к публикации (громкий отказ)', async () => {
    // Карточка в `review`: перевод в `published` для неё законен по модели
    // переходов и упирается ровно в роль. С черновиком тест был бы ложным —
    // `draft → published` не предусмотрен ни для кого, и зелёный результат
    // держался бы на запрете перескока, а не на границе автоматизации.
    const result = await attemptUpdate({
      collection: 'cards',
      data: { status: 'published' },
      fields: CARD_FIELDS,
      id: fixture.reviewCardId,
      outcome: 'loud',
      transport,
      what: 'публикация карточки из review',
    });
    expect(result.errors.join(' ')).toMatch(/admin/i);
    expect((await readStored('cards', fixture.reviewCardId)).status).toBe('review');
  });

  it('не публикует подборку, готовую к публикации (громкий отказ)', async () => {
    const result = await attemptUpdate({
      collection: 'collections',
      data: { status: 'published' },
      fields: COLLECTION_FIELDS,
      id: fixture.reviewNodeId,
      outcome: 'loud',
      transport,
      what: 'публикация подборки из review',
    });
    expect(result.errors.join(' ')).toMatch(/admin/i);
    expect((await readStored('collections', fixture.reviewNodeId)).status).toBe('review');
  });

  it('не перескакивает из draft сразу в published: правило действует и на роль admin', async () => {
    // Отдельный сценарий, а не побочный эффект предыдущего: перескок запрещён
    // МОДЕЛЬЮ, поэтому проверяется на черновике и текстом отказа про модель.
    const payload = await getTestPayload();
    const draft = await payload.create({
      collection: 'cards',
      data: {
        metaDescription: `Э6-02: описание черновика перескока ${RUN}-${transport}`,
        robots: 'noindex,follow',
        slug: `e602n-pereskok-${RUN}-${transport}`,
        status: 'draft',
        title: `Э6-02: черновик перескока ${RUN}-${transport}`,
      },
      overrideAccess: true,
    });

    const result = await attemptUpdate({
      collection: 'cards',
      data: { status: 'published' },
      fields: CARD_FIELDS,
      id: draft.id,
      outcome: 'loud',
      transport,
      what: 'перескок draft → published',
    });
    expect(result.errors.join(' ')).toMatch(/не предусмотрен моделью/);

    await removeContent('cards', [draft.id]);
  });

  it('не снимает опубликованную карточку с публикации (громкий отказ)', async () => {
    await attemptUpdate({
      collection: 'cards',
      data: { status: 'draft', withdrawal: { mode: '404' } },
      fields: CARD_FIELDS,
      id: fixture.cardId,
      outcome: 'loud',
      transport,
      what: 'снятие с публикации',
    });
  });

  /* ---------------------------------------------------------------- */
  /* Индексация                                                        */
  /* ---------------------------------------------------------------- */

  it('не открывает опубликованную карточку в index,follow (громкий отказ)', async () => {
    const result = await attemptUpdate({
      collection: 'cards',
      data: { robots: 'index,follow' },
      fields: CARD_FIELDS,
      id: fixture.cardId,
      outcome: 'loud',
      transport,
      what: 'index,follow у карточки',
    });
    expect(result.errors.join(' ')).toMatch(/index,follow/);
  });

  it('не открывает опубликованную подборку в index,follow (громкий отказ)', async () => {
    await attemptUpdate({
      collection: 'collections',
      data: { robots: 'index,follow' },
      fields: COLLECTION_FIELDS,
      id: fixture.nodeId,
      outcome: 'loud',
      transport,
      what: 'index,follow у подборки',
    });
  });

  it('не ставит noindex,nofollow опубликованной карточке (тихий отказ)', async () => {
    // Не всякая смена директивы «открывает индексацию»: закрыть страницу
    // сильнее — тоже решение об индексации, и оно тоже за человеком.
    await attemptUpdate({
      collection: 'cards',
      data: { robots: 'noindex,nofollow' },
      fields: CARD_FIELDS,
      id: fixture.cardId,
      outcome: 'silent',
      transport,
      what: 'смена robots на noindex,nofollow',
    });
  });

  /* ---------------------------------------------------------------- */
  /* canonical                                                         */
  /* ---------------------------------------------------------------- */

  it('не переопределяет canonical опубликованной карточки (тихий отказ)', async () => {
    // Успешный ответ — не противоречие: правило живёт в access control поля,
    // Payload вырезает поле и возвращает прежний документ. Доказательств два, и
    // оба обязательны: совпадение снимков (значение не изменилось) и успешность
    // операции (запрос дошёл и выполнился) — их обеспечивает `attemptUpdate`.
    await attemptUpdate({
      collection: 'cards',
      data: { canonical: `/otkrytki/chuzhaya-${RUN}` },
      fields: CARD_FIELDS,
      id: fixture.cardId,
      outcome: 'silent',
      transport,
      what: 'canonical карточки',
    });
  });

  it('не переопределяет canonical опубликованной подборки (тихий отказ)', async () => {
    await attemptUpdate({
      collection: 'collections',
      data: { canonical: `/podborki/chuzhaya-${RUN}` },
      fields: COLLECTION_FIELDS,
      id: fixture.nodeId,
      outcome: 'silent',
      transport,
      what: 'canonical подборки',
    });
  });

  /* ---------------------------------------------------------------- */
  /* URL после публикации                                              */
  /* ---------------------------------------------------------------- */

  it('не меняет slug опубликованной карточки (громкий отказ)', async () => {
    const result = await attemptUpdate({
      collection: 'cards',
      data: { slug: `e602n-pereezd-${RUN}-${transport}` },
      fields: CARD_FIELDS,
      id: fixture.cardId,
      outcome: 'loud',
      transport,
      what: 'slug карточки',
    });
    expect(result.errors.join(' ')).toMatch(/301|admin/i);
  });

  it('не меняет slug опубликованной подборки (громкий отказ)', async () => {
    await attemptUpdate({
      collection: 'collections',
      data: { slug: `e602n-pereezd-uzla-${RUN}-${transport}` },
      fields: COLLECTION_FIELDS,
      id: fixture.nodeId,
      outcome: 'loud',
      transport,
      what: 'slug подборки',
    });
  });

  it('не переносит опубликованную подборку к другому родителю (громкий отказ)', async () => {
    // parent меняет ИТОГОВЫЙ путь узла и всех его потомков, то есть это смена
    // URL — правило то же, что у slug.
    await attemptUpdate({
      collection: 'collections',
      data: { parent: fixture.otherGroupId },
      fields: COLLECTION_FIELDS,
      id: fixture.nodeId,
      outcome: 'loud',
      transport,
      what: 'parent подборки',
    });
  });

  it('не меняет nodeKind опубликованной подборки (громкий отказ)', async () => {
    await attemptUpdate({
      collection: 'collections',
      data: { nodeKind: 'recipient' },
      fields: COLLECTION_FIELDS,
      id: fixture.nodeId,
      outcome: 'loud',
      transport,
      what: 'nodeKind подборки',
    });
  });

  /* ---------------------------------------------------------------- */
  /* Редиректы                                                         */
  /* ---------------------------------------------------------------- */

  it('не создаёт редирект', async () => {
    const payload = await getTestPayload();
    const before = await payload.count({ collection: 'redirects', overrideAccess: true });

    const result = await createDoc({
      actor: aiEditor,
      collection: 'redirects',
      // `code` передаётся ЯВНО и это не формальность. В схеме создания GraphQL он
      // объявлен не-nullable (`Redirect_code_MutationInput!`), а значение по
      // умолчанию за клиента там не подставляется. Запрос без него отклонялся на
      // приведении переменных — до резолвера, то есть до access control — и
      // сценарий был зелёным при ЛЮБЫХ правах на создание редиректа. Теперь
      // отказ приходит от Payload и это проверяется ниже по тексту.
      data: { code: '301', from: `/e602n-samodelnyy-${RUN}-${transport}`, to: '/' },
      transport,
    });

    expect(result.applied).toBe(false);
    // Отказ обязан быть отказом ПО ПРАВАМ. Без этой проверки любая другая
    // ошибка — валидации, схемы, соединения — читалась бы как доказательство
    // запрета.
    expect(
      result.errors.join(' '),
      'создание редиректа отклонено не по правам: ' + result.errors.join(' | '),
    ).toMatch(/not allowed|Forbidden|admin|доступ/i);

    const after = await payload.count({ collection: 'redirects', overrideAccess: true });
    expect(after.totalDocs).toBe(before.totalDocs);
  });

  it('не правит существующий редирект', async () => {
    await attemptUpdate({
      collection: 'redirects',
      // Подменяется и цель, и КОД: 301 → 410 превращает перенос в удаление без
      // замены. Именно поэтому `code` входит в снимок (см. REDIRECT_FIELDS).
      data: { code: '410', to: `/e602n-podmena-${RUN}-${transport}` },
      fields: REDIRECT_FIELDS,
      id: redirectId,
      outcome: 'loud',
      transport,
      what: 'правка редиректа',
    });
  });

  it('не удаляет редирект', async () => {
    const payload = await getTestPayload();
    const result = await deleteDoc({
      actor: aiEditor,
      collection: 'redirects',
      id: redirectId,
      transport,
    });
    expect(result.applied).toBe(false);
    const still = await payload.findByID({
      collection: 'redirects',
      id: redirectId,
      overrideAccess: true,
    });
    expect(still.id).toBe(redirectId);
  });

  /* ---------------------------------------------------------------- */
  /* Пользователи и роли (добор к Э6-01)                               */
  /* ---------------------------------------------------------------- */

  it('не меняет роль ЧУЖОГО аккаунта', async () => {
    const result = await attemptUpdate({
      collection: 'users',
      data: { role: 'ai-editor' },
      fields: ['role', 'enableAPIKey'],
      id: admin.id,
      outcome: 'loud',
      transport,
      what: 'понижение роли администратора',
    });
    expect(result.errors.join(' ')).toMatch(/администратор|not allowed|Forbidden/i);
    expect((await readStored('users', admin.id)).role).toBe('admin');
  });

  /* ---------------------------------------------------------------- */
  /* Журнал аудита                                                     */
  /* ---------------------------------------------------------------- */

  it('не пишет и не правит seo-history напрямую', async () => {
    const payload = await getTestPayload();
    const before = await payload.count({ collection: 'seo-history', overrideAccess: true });

    const created = await createDoc({
      actor: aiEditor,
      collection: 'seo-history',
      // Перечислены ВСЕ обязательные поля входного типа. Их шесть, и раньше
      // передавались три: в GraphQL недостающие обязательные поля валят запрос
      // на приведении переменных, до резолвера, то есть до access control —
      // сценарий был бы зелёным при полностью открытой записи в журнал аудита.
      data: {
        authorRole: 'ai-editor',
        changedAt: new Date().toISOString(),
        documentCollection: 'cards',
        documentId: String(fixture.cardId),
        field: 'title',
        operation: 'update',
      },
      transport,
    });
    expect(created.applied).toBe(false);
    expect(
      created.errors.join(' '),
      'запись в журнал отклонена не по правам: ' + created.errors.join(' | '),
    ).toMatch(/not allowed|Forbidden|доступ/i);

    const after = await payload.count({ collection: 'seo-history', overrideAccess: true });
    expect(after.totalDocs).toBe(before.totalDocs);

    // И существующую запись журнала не переписать. Запись есть всегда: её
    // оставила публикация карточки в фикстуре.
    const existing = await payload.find({
      collection: 'seo-history',
      limit: 1,
      overrideAccess: true,
      where: {
        and: [
          { documentCollection: { equals: 'cards' } },
          { documentId: { equals: String(fixture.cardId) } },
        ],
      },
    });
    const entry = existing.docs[0];
    expect(entry, 'публикация карточки не оставила записи в журнале').toBeDefined();

    await attemptUpdate({
      collection: 'seo-history',
      data: { field: 'slug' },
      fields: ['documentCollection', 'documentId', 'field'],
      id: entry?.id ?? 0,
      outcome: 'loud',
      transport,
      what: 'правка записи журнала',
    });

    const removed = await deleteDoc({
      actor: aiEditor,
      collection: 'seo-history',
      id: entry?.id ?? 0,
      transport,
    });
    expect(removed.applied).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /* Настройки сайта                                                   */
  /* ---------------------------------------------------------------- */

  it('не правит настройки сайта', async () => {
    const payload = await getTestPayload();
    const before = await payload.findGlobal({
      depth: 0,
      overrideAccess: true,
      slug: 'site-settings',
    });

    const result = await updateGlobal({
      actor: aiEditor,
      data: { organization: { name: `Подмена ${RUN}-${transport}` } },
      slug: 'site-settings',
      transport,
    });
    expect(result.applied).toBe(false);
    expect(
      result.errors.join(' '),
      'правка настроек отклонена не по правам: ' + result.errors.join(' | '),
    ).toMatch(/not allowed|Forbidden|доступ/i);

    const after = await payload.findGlobal({
      depth: 0,
      overrideAccess: true,
      slug: 'site-settings',
    });
    expect(after.organization ?? null).toEqual(before.organization ?? null);
  });

  /* ---------------------------------------------------------------- */
  /* Удаление                                                          */
  /* ---------------------------------------------------------------- */

  it('не удаляет опубликованную карточку', async () => {
    const result = await deleteDoc({
      actor: aiEditor,
      collection: 'cards',
      id: fixture.cardId,
      transport,
    });
    expect(result.applied).toBe(false);
    expect((await readStored('cards', fixture.cardId)).status).toBe('published');
  });

  it('не удаляет опубликованную подборку', async () => {
    const result = await deleteDoc({
      actor: aiEditor,
      collection: 'collections',
      id: fixture.nodeId,
      transport,
    });
    expect(result.applied).toBe(false);
    expect((await readStored('collections', fixture.nodeId)).status).toBe('published');
  });

  /* ---------------------------------------------------------------- */
  /* Изображение опубликованной карточки                               */
  /* ---------------------------------------------------------------- */

  it('не заменяет изображение опубликованной карточки (громкий отказ)', async () => {
    const result = await attemptUpdate({
      collection: 'cards',
      data: { image: fixture.otherImageId },
      fields: CARD_FIELDS,
      id: fixture.cardId,
      outcome: 'loud',
      transport,
      what: 'замена изображения',
    });
    expect(result.errors.join(' ')).toMatch(/admin/i);
  });

  /* ---------------------------------------------------------------- */
  /* Служебные поля: lastmod, pHash, ключ производной, суффикс имени    */
  /* ---------------------------------------------------------------- */

  it('не задаёт updatedContentAt — источник lastmod (тихий отказ)', async () => {
    await attemptUpdate({
      collection: 'cards',
      data: { updatedContentAt: '2020-01-01T00:00:00.000Z' },
      fields: CARD_FIELDS,
      id: fixture.cardId,
      outcome: 'silent',
      transport,
      what: 'updatedContentAt',
    });
  });

  it('не подменяет pHash карточки (тихий отказ)', async () => {
    await attemptUpdate({
      collection: 'cards',
      data: { pHash: '0000000000000000' },
      fields: CARD_FIELDS,
      id: fixture.cardId,
      outcome: 'silent',
      transport,
      what: 'pHash карточки',
    });
  });

  it('не подменяет ключ производной, ревизию и суффикс имени (тихий отказ)', async () => {
    const before = await readStored('card-images', fixture.imageId);

    const result = await updateDoc({
      actor: aiEditor,
      collection: 'card-images',
      data: {
        nameStem: `podmena-${RUN}`,
        nameSuffix: 7,
        pHash: '0000000000000000',
        revision: 'podmena',
      },
      id: fixture.imageId,
      transport,
    });
    // Операция ОБЯЗАНА выполниться: отказ здесь тихий, поля вырезаются правами
    // поля, ответ успешный. Не выполнившийся запрос оставил бы значения
    // прежними по совершенно другой причине, и сравнение ниже это не различает.
    expectOutcome(result, 'silent', 'подмена служебных полей изображения');

    const after = await readStored('card-images', fixture.imageId);
    for (const field of ['nameStem', 'nameSuffix', 'pHash', 'revision']) {
      expect(after[field] ?? null, `подменено поле ${field}`).toEqual(before[field] ?? null);
    }
  });

  it('не трогает реестр занятых имён файлов', async () => {
    const payload = await getTestPayload();
    const before = await payload.count({ collection: 'image-name-claims', overrideAccess: true });

    const created = await createDoc({
      actor: aiEditor,
      collection: 'image-name-claims',
      data: { stem: `samozahvat-${RUN}-${transport}` },
      transport,
    });
    expect(created.applied).toBe(false);

    const after = await payload.count({ collection: 'image-name-claims', overrideAccess: true });
    expect(after.totalDocs).toBe(before.totalDocs);
    expect(
      created.errors.join(' '),
      'захват имени отклонён не по правам: ' + created.errors.join(' | '),
    ).toMatch(/not allowed|Forbidden|доступ/i);
  });

  /* ---------------------------------------------------------------- */
  /* Чтение: не всё и не всем                                          */
  /* ---------------------------------------------------------------- */

  it('читать записи сервисный аккаунт вправе: закрыта запись, а не доступ', async () => {
    // Положительный контроль ко всему блоку: если бы ai-editor вообще ничего не
    // видел, все запреты выше проходили бы по неверной причине.
    const listed = await findDocs({
      actor: aiEditor,
      collection: 'cards',
      fields: 'id slug status',
      transport,
      where: { id: { equals: fixture.cardId } },
    });
    expect(listed.errors).toEqual([]);
    expect(listed.docs.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Контроль самого набора                                              */
/* ------------------------------------------------------------------ */

describe('Э6-02: набор ловит запрос, не дошедший до Payload', () => {
  it('мутация GraphQL без обязательного поля падает громко, а не «отказом по правам»', async () => {
    // Этот тест защищает все остальные. Мутация без обязательного `code`
    // отклоняется разбором переменных: резолвер не выполняется, access control
    // не спрашивается, а ответ по форме неотличим от отказа по правам
    // (`errors` есть, документа нет). Именно так три сценария набора были
    // ложно-зелёными. Гарнизон теперь падает на таком ответе — и здесь
    // проверяется, что падает.
    await expect(
      createDoc({
        actor: aiEditor,
        collection: 'redirects',
        data: { from: `/e602n-bez-koda-${RUN}`, to: '/' },
        transport: 'graphql',
      }),
    ).rejects.toThrow(/не дошёл до Payload/);
  });
});

/* ------------------------------------------------------------------ */
/* Пакетные операции: только REST                                      */
/* ------------------------------------------------------------------ */

describe('Э6-02: пакетная операция от имени сервисного аккаунта', () => {
  it('пакетная публикация выборки отклонена целиком', async () => {
    const payload = await getTestPayload();
    const first = await payload.create({
      collection: 'cards',
      data: {
        metaDescription: `Э6-02: описание пакета А ${RUN}`,
        robots: 'noindex,follow',
        slug: `e602n-paket-a-${RUN}`,
        status: 'draft',
        title: `Э6-02: пакет А ${RUN}`,
      },
      overrideAccess: true,
    });
    const second = await payload.create({
      collection: 'cards',
      data: {
        metaDescription: `Э6-02: описание пакета Б ${RUN}`,
        robots: 'noindex,follow',
        slug: `e602n-paket-b-${RUN}`,
        status: 'draft',
        title: `Э6-02: пакет Б ${RUN}`,
      },
      overrideAccess: true,
    });

    const result = await bulkUpdate({
      actor: aiEditor,
      collection: 'cards',
      data: { status: 'published' },
      where: { id: { in: [first.id, second.id] } },
    });
    expect(result.applied).toBe(false);

    for (const id of [first.id, second.id]) {
      expect((await readStored('cards', id)).status).toBe('draft');
    }
    await removeContent('cards', [first.id, second.id]);
    await assertRemoved('cards', [first.id, second.id]);
  });

  it('пакетное включение index,follow отклонено целиком', async () => {
    const before = await snapshot('cards', fixture.cardId, CARD_FIELDS);
    const result = await bulkUpdate({
      actor: aiEditor,
      collection: 'cards',
      data: { robots: 'index,follow' },
      where: { id: { in: [fixture.cardId] } },
    });
    expect(result.applied).toBe(false);
    expect(await snapshot('cards', fixture.cardId, CARD_FIELDS)).toEqual(before);
  });
});
