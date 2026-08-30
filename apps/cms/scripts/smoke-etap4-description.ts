/**
 * Смоук Э4 на ЖИВОЙ базе: индексируемая директива при пустом meta description
 * отклоняется, и отклоняется в том же слое, по которому работают REST и GraphQL.
 *
 * ЗАЧЕМ СМОУК, ЕСЛИ ЕСТЬ ЮНИТ-ТЕСТЫ. Юнит-тест доказывает, что правило верно, и
 * стенд в `content-hooks.test.ts` доказывает, что оно стоит в нужной фазе. Ни то,
 * ни другое не доказывает, что правило ПРИМЕНЯЕТСЯ на живом ядре: между чистой
 * функцией и сохранённой строкой лежат access control полей, слияние входных
 * данных с документом и транзакция, и потерять правило можно там, не уронив ни
 * одного теста. Поэтому здесь всё идёт через Local API с `overrideAccess: false`
 * и явным пользователем — это тот же путь, которым идут REST и GraphQL, а не
 * форма админки.
 *
 * ЧТО ПРОВЕРЯЕТСЯ:
 *   1. открыть index,follow при пустом описании нельзя — отказ по машинному
 *      признаку `index-requires-description`, а не по совпадению подстроки;
 *   2. очистить описание у уже индексируемой записи нельзя — тот же признак.
 *      Это второй, более дорогой случай: страница уже в индексе и в sitemap;
 *   3. правило действует и на сервисный аккаунт: `ai-editor` директиву не
 *      трогает вовсе, но описание — его поле, и очистка у индексируемой записи
 *      для него такой же отказ;
 *   4. при `noindex` пустое описание правилом не трогается — запрет не шире
 *      правила рендера;
 *   5. заполненное описание открывает индексацию как раньше (правило не ломает
 *      законный путь);
 *   6. снятие с публикации индексируемой записи не блокируется: проверка стоит
 *      на ИТОГОВОЙ директиве, которую то же сохранение понижает;
 *   7. служебная страница глобала отдаёт состояние индексации ПОЛЕМ — то есть
 *      оно приходит и в REST, и в GraphQL, а не живёт в форме админки.
 *
 * Запуск: pnpm --filter @otkritka/cms exec payload run ./scripts/smoke-etap4-description.ts
 *
 * Смоук убирает за собой всё созданное, включая историю, изображения и занятые
 * имена файлов, и не оставляет ни одной опубликованной записи: счётчик
 * `published` печатается до и после и обязан не измениться.
 */
import { getPayload } from 'payload';

import config from '../src/payload.config';
import { createPngFixture } from '../src/images/png-fixture';
import { describeInfoPageIndexation } from '../src/globals/site-settings';
import { finishSmoke } from '../src/scripts/smoke-exit';

interface Check {
  readonly detail: string;
  readonly name: string;
  readonly ok: boolean;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail = ''): void {
  checks.push({ detail, name, ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ruleOf(error: unknown): string {
  const data = (error as { data?: { rule?: unknown } }).data;
  return typeof data?.rule === 'string' ? data.rule : '';
}

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

/**
 * Ожидает отказ с конкретным машинным признаком.
 *
 * Признак, а не подстрока: зелёный негативный смоук на совпадении текста
 * однажды держится на ДРУГОМ отказе — например, по правам, — и правило, ради
 * которого он писался, к тому моменту уже не работает.
 */
async function expectRule(name: string, rule: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const actual = ruleOf(error);
    record(
      name,
      actual === rule,
      `rule=${actual === '' ? '(нет)' : actual} status=${String(statusOf(error))}; ` +
        messageOf(error).slice(0, 200),
    );
    return;
  }
  record(name, false, 'операция прошла, хотя должна была быть отклонена');
}

async function expectOk(name: string, run: () => Promise<unknown>): Promise<unknown> {
  try {
    const result = await run();
    record(name, true);
    return result;
  } catch (error) {
    record(name, false, messageOf(error).slice(0, 220));
    return null;
  }
}

const DESCRIPTION = 'Смоук Э4: описание карточки, из-за которого страница может быть в индексе.';

async function main(): Promise<void> {
  const payload = await getPayload({ config });

  const before = {
    publishedCards: (
      await payload.count({ collection: 'cards', where: { status: { equals: 'published' } } })
    ).totalDocs,
    publishedCollections: (
      await payload.count({
        collection: 'collections',
        where: { status: { equals: 'published' } },
      })
    ).totalDocs,
  };
  console.log(`До смоука: ${JSON.stringify(before)}`);

  const created = {
    cardImages: [] as number[],
    cards: [] as number[],
    collections: [] as number[],
    users: [] as number[],
  };
  const claimedStems: string[] = [];

  try {
    const admins = await payload.find({
      collection: 'users',
      limit: 1,
      where: { role: { equals: 'admin' } },
    });
    const adminDoc = admins.docs[0];
    if (adminDoc === undefined) {
      throw new Error('В базе нет администратора: запустите CMS один раз, чтобы создался первый.');
    }
    const admin = { ...adminDoc, collection: 'users' as const };

    const service = await payload.create({
      collection: 'users',
      data: {
        email: `smouk-opisanie-${String(Date.now())}@otkritka.test`,
        password: `smouk-${String(Date.now())}`,
        role: 'ai-editor',
      },
    });
    created.users.push(service.id);
    const aiEditor = { ...service, collection: 'users' as const };

    /* --------------------------------------------------------------- */
    /* Подготовка: узел привязки, изображение, карточка до published    */
    /* --------------------------------------------------------------- */

    const node = await payload.create({
      collection: 'collections',
      data: {
        nodeKind: 'group',
        robots: 'noindex,follow',
        slug: 'smouk-opisanie-gruppa',
        status: 'draft',
        title: 'Смоук Э4: группа',
      },
      overrideAccess: false,
      user: admin,
    });
    created.collections.push(node.id);

    const bytes = createPngFixture({ composition: 'rings', height: 500, width: 800 });
    const image = await payload.create({
      collection: 'card-images',
      data: { title: 'Смоук Э4: изображение' },
      file: {
        data: bytes,
        mimetype: 'image/png',
        name: 'smouk-opisanie.png',
        size: bytes.byteLength,
      },
      overrideAccess: false,
      user: aiEditor,
    });
    created.cardImages.push(image.id);
    if (typeof image.nameStem === 'string') {
      claimedStems.push(image.nameStem);
    }

    const card = await payload.create({
      collection: 'cards',
      data: {
        robots: 'noindex,follow',
        slug: 'smouk-opisanie-otkrytka',
        status: 'draft',
        title: 'Смоук Э4: открытка',
      },
      overrideAccess: false,
      user: aiEditor,
    });
    created.cards.push(card.id);

    await payload.update({
      collection: 'cards',
      id: card.id,
      data: {
        alt: 'Смоук Э4: описание изображения',
        caption: 'Смоук Э4: подпись',
        collections: [node.id],
        image: image.id,
        metaDescription: DESCRIPTION,
      },
      overrideAccess: false,
      user: aiEditor,
    });
    await payload.update({
      collection: 'cards',
      id: card.id,
      data: { status: 'review' },
      overrideAccess: false,
      user: aiEditor,
    });
    const published = await payload.update({
      collection: 'cards',
      id: card.id,
      data: { status: 'published' },
      overrideAccess: false,
      user: admin,
    });
    record(
      'подготовка: карточка опубликована с непустым описанием',
      published.status === 'published' && published.robots === 'noindex,follow',
      `status=${published.status} robots=${published.robots}`,
    );

    /* --------------------------------------------------------------- */
    /* 1. Открытие индексации при заполненном описании — норма          */
    /* --------------------------------------------------------------- */

    const opened = await expectOk('admin открывает index,follow при непустом описании', () =>
      payload.update({
        collection: 'cards',
        id: card.id,
        data: { robots: 'index,follow' },
        overrideAccess: false,
        user: admin,
      }),
    );
    record(
      'директива записалась именно index,follow',
      (opened as { robots?: string } | null)?.robots === 'index,follow',
      `robots=${String((opened as { robots?: string } | null)?.robots)}`,
    );

    /* --------------------------------------------------------------- */
    /* 2. Очистка описания у индексируемой записи отклоняется           */
    /* --------------------------------------------------------------- */

    await expectRule(
      'очистка описания у index,follow отклонена (admin)',
      'index-requires-description',
      () =>
        payload.update({
          collection: 'cards',
          id: card.id,
          data: { metaDescription: '' },
          overrideAccess: false,
          user: admin,
        }),
    );

    await expectRule(
      'та же очистка отклонена и сервисному аккаунту: правило в слое, а не в форме',
      'index-requires-description',
      () =>
        payload.update({
          collection: 'cards',
          id: card.id,
          data: { metaDescription: '   ' },
          overrideAccess: false,
          user: aiEditor,
        }),
    );

    const afterAttempts = await payload.findByID({ collection: 'cards', id: card.id });
    record(
      'описание после отклонённых попыток не изменилось',
      afterAttempts.metaDescription === DESCRIPTION,
      `metaDescription=${String(afterAttempts.metaDescription).slice(0, 40)}`,
    );

    /* --------------------------------------------------------------- */
    /* 3. При noindex пустое описание правилом не трогается             */
    /* --------------------------------------------------------------- */

    await expectOk('admin закрывает страницу от индекса', () =>
      payload.update({
        collection: 'cards',
        id: card.id,
        data: { robots: 'noindex,follow' },
        overrideAccess: false,
        user: admin,
      }),
    );

    const cleared = await expectOk('при noindex описание очищается: запрет не шире правила', () =>
      payload.update({
        collection: 'cards',
        id: card.id,
        data: { metaDescription: '' },
        overrideAccess: false,
        user: aiEditor,
      }),
    );
    record(
      'описание действительно пусто',
      ((cleared as { metaDescription?: string | null } | null)?.metaDescription ?? '') === '',
    );

    /* --------------------------------------------------------------- */
    /* 4. Открыть индексацию с пустым описанием нельзя                  */
    /* --------------------------------------------------------------- */

    await expectRule(
      'открытие index,follow при пустом описании отклонено',
      'index-requires-description',
      () =>
        payload.update({
          collection: 'cards',
          id: card.id,
          data: { robots: 'index,follow' },
          overrideAccess: false,
          user: admin,
        }),
    );

    const stillClosed = await payload.findByID({ collection: 'cards', id: card.id });
    record(
      'директива осталась noindex,follow: отказ не применил половину операции',
      stillClosed.robots === 'noindex,follow',
      `robots=${stillClosed.robots}`,
    );

    /* --------------------------------------------------------------- */
    /* 5. Заполнить описание и открыть индексацию — одно сохранение     */
    /* --------------------------------------------------------------- */

    const fixed = await expectOk(
      'описание и директива в ОДНОМ сохранении проходят: выход из отказа есть',
      () =>
        payload.update({
          collection: 'cards',
          id: card.id,
          data: { metaDescription: DESCRIPTION, robots: 'index,follow' },
          overrideAccess: false,
          user: admin,
        }),
    );
    record(
      'после исправления страница индексируется',
      (fixed as { robots?: string } | null)?.robots === 'index,follow',
      `robots=${String((fixed as { robots?: string } | null)?.robots)}`,
    );

    /* --------------------------------------------------------------- */
    /* 6. Снятие с публикации не блокируется правилом                   */
    /* --------------------------------------------------------------- */

    const withdrawn = await expectOk(
      'снятие с публикации проходит: проверяется ИТОГОВАЯ директива, а не входящая',
      () =>
        payload.update({
          collection: 'cards',
          id: card.id,
          data: { status: 'draft', withdrawal: { mode: '410', redirectTo: null } },
          overrideAccess: false,
          user: admin,
        }),
    );
    record(
      'уход из published понизил директиву сам',
      (withdrawn as { robots?: string } | null)?.robots === 'noindex,follow',
      `robots=${String((withdrawn as { robots?: string } | null)?.robots)}`,
    );

    /* --------------------------------------------------------------- */
    /* 7. Служебные страницы: состояние индексации приходит полем       */
    /* --------------------------------------------------------------- */

    const settings = await payload.findGlobal({ slug: 'site-settings', overrideAccess: false });
    const about = settings.infoPages?.about;
    const state = about?.indexationState;
    record(
      'состояние индексации служебной страницы приходит полем, а не только в админку',
      typeof state === 'string' && state !== '',
      String(state).slice(0, 160),
    );
    record(
      'значение совпадает с предикатом Ч-23: второй трактовки нет',
      state === describeInfoPageIndexation(about ?? {}),
    );
  } finally {
    for (const id of created.cards) {
      await payload.delete({ collection: 'cards', id }).catch(() => undefined);
      await payload
        .delete({
          collection: 'seo-history',
          where: {
            and: [
              { documentCollection: { equals: 'cards' } },
              { documentId: { equals: String(id) } },
            ],
          },
        })
        .catch(() => undefined);
    }
    for (const id of [...created.collections].reverse()) {
      await payload.delete({ collection: 'collections', id }).catch(() => undefined);
      await payload
        .delete({
          collection: 'seo-history',
          where: {
            and: [
              { documentCollection: { equals: 'collections' } },
              { documentId: { equals: String(id) } },
            ],
          },
        })
        .catch(() => undefined);
    }
    for (const id of created.cardImages) {
      await payload.delete({ collection: 'card-images', id }).catch(() => undefined);
    }
    for (const stem of claimedStems) {
      await payload
        .delete({ collection: 'image-name-claims', where: { stem: { equals: stem } } })
        .catch(() => undefined);
    }
    await payload
      .delete({ collection: 'redirects', where: { from: { like: 'smouk-opisanie' } } })
      .catch(() => undefined);
    for (const id of created.users) {
      await payload.delete({ collection: 'users', id }).catch(() => undefined);
    }

    const after = {
      publishedCards: (
        await payload.count({ collection: 'cards', where: { status: { equals: 'published' } } })
      ).totalDocs,
      publishedCollections: (
        await payload.count({
          collection: 'collections',
          where: { status: { equals: 'published' } },
        })
      ).totalDocs,
    };
    const leftovers = {
      cardImages: (await payload.count({ collection: 'card-images' })).totalDocs,
      cards: (await payload.count({ collection: 'cards' })).totalDocs,
      claims: (await payload.count({ collection: 'image-name-claims' })).totalDocs,
      collections: (await payload.count({ collection: 'collections' })).totalDocs,
      redirects: (await payload.count({ collection: 'redirects' })).totalDocs,
    };
    console.log(
      `\nПосле уборки: ${JSON.stringify(after)} остатки=${JSON.stringify(leftovers)}`,
    );
    record(
      'уборка вернула базу в исходное состояние, published не прибавилось',
      after.publishedCards === before.publishedCards &&
        after.publishedCollections === before.publishedCollections,
      `было ${JSON.stringify(before)}`,
    );

    const failed = checks.filter((check) => !check.ok);
    console.log(
      `\nИТОГ: ${String(checks.length - failed.length)}/${String(checks.length)} проверок пройдено`,
    );
    for (const check of failed) {
      console.log(`  ПРОВАЛ: ${check.name} — ${check.detail}`);
    }
  }
}

// Код выхода выставляет `finishSmoke`, а не `process.exitCode`: `payload run`
// после скрипта безусловно делает `process.exit(0)` и выставленное поле затирает
// — красный смоук выходил бы нулём.
try {
  await main();
} catch (error) {
  console.error('\nСмоук оборван ошибкой:', error);
  await finishSmoke(1);
}

await finishSmoke(checks.filter((check) => !check.ok).length);
