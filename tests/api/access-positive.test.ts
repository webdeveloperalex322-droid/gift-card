/**
 * Э6-02, положительная половина: что сервисный аккаунт МОЖЕТ.
 *
 * Без неё негативные сценарии ничего не стоят. Набор, в котором `ai-editor` не
 * может ничего, зелёный по всем запретам — и одинаково зелёный при верной
 * матрице прав и при случайно сломанном ключе, опечатке в роли или отвалившейся
 * базе. Поэтому здесь пройден весь путь агента до `review`, ровно по
 * формулировке CLAUDE.md: создать и править записи в `draft`, загружать
 * изображения, заполнять метаданные и alt, привязывать карточки к подборкам,
 * расставлять внутренние ссылки, переводить `draft` → `review`.
 *
 * Загрузка файла идёт только через REST: мутации GraphQL у Payload файлов не
 * принимают вовсе (в схеме нет скалярного типа файла) — это свойство фреймворка,
 * а не пробел набора. Остальные шаги проверяются обоими транспортами.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPngFixture } from '../../apps/cms/src/images/png-fixture';
import { lexical } from '../../apps/cms/src/testing/api-fixtures';
import {
  TRANSPORTS,
  type TestUser,
  assertRemoved,
  createDoc,
  createUserWithKey,
  getTestPayload,
  readStored,
  removeContent,
  removeUsers,
  restRaw,
  stamp,
  updateDoc,
} from '../../apps/cms/src/testing/api-harness';

const RUN = stamp();

let admin: TestUser;
let aiEditor: TestUser;

const created = {
  cards: [] as number[],
  collections: [] as number[],
  images: [] as number[],
};

beforeAll(async () => {
  await getTestPayload();
  admin = await createUserWithKey({
    email: `e602p-admin-${RUN}@otkritka.test`,
    label: 'admin',
    role: 'admin',
  });
  aiEditor = await createUserWithKey({
    email: `e602p-ai-${RUN}@otkritka.test`,
    label: 'ai-editor',
    role: 'ai-editor',
  });
});

// Уборка не глушит ошибки: несделанная уборка на рабочей базе оставляет записи
// прогона, а набор при этом остаётся зелёным.
afterAll(async () => {
  await removeContent('cards', created.cards);
  await removeContent('collections', created.collections);
  await removeContent('card-images', created.images);
  await assertRemoved('cards', created.cards);
  await assertRemoved('collections', created.collections);
  await assertRemoved('card-images', created.images);
  await removeUsers([admin.id, aiEditor.id]);
});

/** Загрузка файла: multipart с полем `_payload` и полем `file` (форма Payload). */
async function uploadImage(actor: TestUser, name: string, title: string): Promise<number> {
  const bytes = createPngFixture({ composition: 'stripes', height: 700, width: 1100 });
  const form = new FormData();
  form.set('_payload', JSON.stringify({ title }));
  form.set('file', new File([new Uint8Array(bytes)], `${name}.png`, { type: 'image/png' }));

  const response = await restRaw({
    actor,
    body: form,
    method: 'POST',
    segments: ['card-images'],
  });
  const body = (await response.json()) as { doc?: { id?: number }; errors?: { message: string }[] };
  if (typeof body.doc?.id !== 'number') {
    throw new Error(
      `Загрузка изображения не прошла: ${JSON.stringify(body.errors ?? body).slice(0, 300)}`,
    );
  }
  return body.doc.id;
}

describe.each(TRANSPORTS)('Э6-02 положительное (%s): путь агента до review', (transport) => {
  it('весь путь проходит одним сценарием', async () => {
    const suffix = `${RUN}-${transport}`;

    /* 1. Подборка-группа: её создаёт сам сервисный аккаунт, в draft. */
    const groupResult = await createDoc({
      actor: aiEditor,
      collection: 'collections',
      data: {
        nodeKind: 'group',
        robots: 'noindex,follow',
        slug: `e602p-gruppa-${suffix}`,
        status: 'draft',
        title: `Э6-02 положительное: группа ${suffix}`,
      },
      transport,
    });
    expect(groupResult.errors).toEqual([]);
    const groupId = groupResult.doc?.id as number;
    created.collections.push(groupId);

    /* 2. Подборка-повод с вводным текстом и внутренними ссылками. */
    const nodeResult = await createDoc({
      actor: aiEditor,
      collection: 'collections',
      data: {
        intro: lexical(`Вводный текст подборки ${suffix}: написан под эту тему, а не по шаблону.`),
        metaDescription: `Э6-02 положительное: описание подборки ${suffix}`,
        nodeKind: 'occasion',
        parent: groupId,
        // Внутренние ссылки — штатное право агента (CLAUDE.md).
        related: [groupId],
        responsibleEditor: admin.id,
        robots: 'noindex,follow',
        slug: `e602p-povod-${suffix}`,
        status: 'draft',
        title: `Э6-02 положительное: подборка ${suffix}`,
      },
      transport,
    });
    expect(nodeResult.errors).toEqual([]);
    const nodeId = nodeResult.doc?.id as number;
    created.collections.push(nodeId);

    const storedNode = await readStored('collections', nodeId);
    expect(storedNode.status).toBe('draft');
    expect(storedNode.robots).toBe('noindex,follow');
    expect(Array.isArray(storedNode.related) ? storedNode.related.length : 0).toBe(1);

    /* 3. Загрузка изображения (REST: GraphQL файлов не принимает). */
    const imageId = await uploadImage(
      aiEditor,
      `e602p-${suffix}`,
      `Э6-02 положительное: изображение ${suffix}`,
    );
    created.images.push(imageId);
    const storedImage = await readStored('card-images', imageId);
    expect(typeof storedImage.pHash).toBe('string');

    /* 4. Черновик карточки. */
    const cardResult = await createDoc({
      actor: aiEditor,
      collection: 'cards',
      data: {
        robots: 'noindex,follow',
        slug: `e602p-otkrytka-${suffix}`,
        status: 'draft',
        title: `Э6-02 положительное: открытка ${suffix}`,
      },
      transport,
    });
    expect(cardResult.errors).toEqual([]);
    const cardId = cardResult.doc?.id as number;
    created.cards.push(cardId);

    /* 5. Метаданные, alt, подпись и привязка к подборке. */
    const filled = await updateDoc({
      actor: aiEditor,
      collection: 'cards',
      data: {
        alt: `Открытка ${suffix}: диагональные полосы`,
        caption: `Подпись открытки ${suffix}`,
        collections: [nodeId],
        image: imageId,
        metaDescription: `Э6-02 положительное: описание открытки ${suffix}`,
      },
      id: cardId,
      transport,
    });
    expect(filled.errors).toEqual([]);

    const storedCard = await readStored('cards', cardId);
    expect(storedCard.alt).toBe(`Открытка ${suffix}: диагональные полосы`);
    expect(storedCard.image).toBe(imageId);

    /* 6. Решение о визуальных дублях — тоже право агента (ТЗ §9). */
    const decided = await updateDoc({
      actor: aiEditor,
      collection: 'cards',
      data: { visualDuplicate: { confirm: true, decision: 'unique' } },
      id: cardId,
      transport,
    });
    expect(decided.errors).toEqual([]);

    /* 7. draft → review. Дальше агент не идёт: границу держит статусная модель. */
    const reviewed = await updateDoc({
      actor: aiEditor,
      collection: 'cards',
      data: { status: 'review' },
      id: cardId,
      transport,
    });
    expect(reviewed.errors).toEqual([]);
    expect((await readStored('cards', cardId)).status).toBe('review');

    /* 8. Подборка тоже доходит до review руками агента. */
    const nodeReviewed = await updateDoc({
      actor: aiEditor,
      collection: 'collections',
      data: { status: 'review' },
      id: nodeId,
      transport,
    });
    expect(nodeReviewed.errors).toEqual([]);
    expect((await readStored('collections', nodeId)).status).toBe('review');

    /* 9. И на review запись остаётся закрытой от индекса и вне sitemap. */
    for (const [collection, id] of [
      ['cards', cardId],
      ['collections', nodeId],
    ] as const) {
      expect((await readStored(collection, id)).robots).toBe('noindex,follow');
    }
  });
});
