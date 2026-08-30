/**
 * П0 — каркас живых API-тестов.
 *
 * Файл доказывает, что гарнизон работает: одна и та же операция (создание
 * черновика карточки ключом `ai-editor`) проходит и через REST, и через GraphQL,
 * а созданная запись реально лежит в базе. Пока это не так, ни один негативный
 * сценарий Э6-01/Э6-02 не значит ничего: «отказано» и «запрос вообще не дошёл»
 * выглядят одинаково.
 *
 * Заодно фиксируются два свойства, на которые опираются остальные файлы:
 *   - аноним контента не создаёт (значит, аутентификация по ключу действительно
 *     работает, а не игнорируется);
 *   - новая запись рождается в `draft` с `noindex` (CLAUDE.md, ТЗ §8.2).
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
  readStored,
  removeContent,
  removeUsers,
  stamp,
  whoAmI,
} from '../../apps/cms/src/testing/api-harness';

const RUN = stamp();

let aiEditor: TestUser;
const createdCards: (number | string)[] = [];

beforeAll(async () => {
  await getTestPayload();
  aiEditor = await createUserWithKey({
    email: `p0-ai-${RUN}@otkritka.test`,
    label: 'ai-editor',
    role: 'ai-editor',
  });
});

// Уборка падает громко: тесты идут на рабочей базе, и проглоченная ошибка
// оставляет в ней записи и ключ прогона, не покраснев ни одним тестом.
afterAll(async () => {
  await removeContent('cards', createdCards);
  await assertRemoved('cards', createdCards);
  await removeUsers([aiEditor.id]);
});

describe('П0: гарнизон доставляет запрос до Payload', () => {
  it('ключ ai-editor аутентифицируется и отдаёт свою роль', async () => {
    const me = await whoAmI(aiEditor);
    expect(me.status).toBe(200);
    expect(me.user?.role).toBe('ai-editor');
  });

  it('анониму без ключа контент создавать нельзя', async () => {
    for (const transport of TRANSPORTS) {
      const result = await createDoc({
        actor: ANONYMOUS,
        collection: 'cards',
        data: {
          robots: 'noindex,follow',
          slug: `p0-anon-${RUN}-${transport}`,
          status: 'draft',
          title: `Аноним ${RUN}`,
        },
        transport,
      });
      expect(result.applied, `${transport}: аноним создал карточку`).toBe(false);
    }
  });

  it.each(TRANSPORTS)('%s: ai-editor создаёт черновик карточки', async (transport) => {
    const slug = `p0-draft-${RUN}-${transport}`;
    const result = await createDoc({
      actor: aiEditor,
      collection: 'cards',
      data: {
        metaDescription: `Описание черновика П0 ${RUN} (${transport})`,
        // status и robots передаются явно: схема создания GraphQL объявляет их
        // не-nullable и дефолт за клиента не подставляет (см. `createDoc`).
        robots: 'noindex,follow',
        slug,
        status: 'draft',
        title: `Черновик П0 ${RUN} (${transport})`,
      },
      transport,
    });

    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(true);

    const id = result.doc?.id;
    expect(typeof id === 'number' || typeof id === 'string').toBe(true);
    createdCards.push(id as number | string);

    // Запись существует в базе именно в том состоянии, которого требует модель.
    const stored = await readStored('cards', id as number | string);
    expect(stored.slug).toBe(slug);
    expect(stored.status).toBe('draft');
    expect(stored.robots).toBe('noindex,follow');
    expect(stored.publishedAt ?? null).toBeNull();
  });
});
