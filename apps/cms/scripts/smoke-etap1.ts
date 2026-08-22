/**
 * Смоук задач Э1-07…Э1-09 на ЖИВОЙ базе (одноразовый скрипт проверки).
 *
 * Зачем он нужен, если есть юнит-тесты: переходы статусов, атомарность «смена URL
 * + 301» и запись истории проверяются на конфиге лишь частично — фазы Payload,
 * транзакции и access control полей работают только на поднятом ядре. Скрипт
 * выполняет операции через Local API с `overrideAccess: false` и явным `user`,
 * то есть ровно так, как их выполнил бы внешний клиент по REST или GraphQL.
 *
 * Запуск: pnpm --filter @otkritka/cms exec payload run ./scripts/smoke-etap1.ts
 *
 * Скрипт удаляет за собой все созданные записи, включая историю и редиректы, и
 * не оставляет ни одной опубликованной записи.
 */
import { getPayload } from 'payload';

import config from '../src/payload.config';

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
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Ожидание отказа: проверяется и факт отказа, и его причина. */
async function expectRejected(name: string, fragment: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = messageOf(error);
    record(name, message.includes(fragment), message.slice(0, 220));
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

/** Минимальный валидный lexical-документ: вводный текст подборки. */
const RICH_TEXT: { root: Record<string, unknown> } = {
  root: {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [{ type: 'text', detail: 0, format: 0, mode: 'normal', style: '', text: 'Смоук', version: 1 }],
        direction: 'ltr',
        format: '',
        indent: 0,
        version: 1,
      },
    ],
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
  },
};

async function main(): Promise<void> {
  const payload = await getPayload({ config });

  const created = {
    cards: [] as number[],
    collections: [] as number[],
    users: [] as number[],
  };

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
        email: `smoke-ai-${String(Date.now())}@otkritka.test`,
        password: `smoke-${String(Date.now())}`,
        role: 'ai-editor',
      },
    });
    created.users.push(service.id);
    const aiEditor = { ...service, collection: 'users' as const };

    /* --------------------------------------------------------------- */
    /* Подборки: нужны как цель привязки карточек                       */
    /* --------------------------------------------------------------- */

    const groupA = await payload.create({
      collection: 'collections',
      data: {
        nodeKind: 'group',
        robots: 'noindex,follow',
        slug: 'smoke-gruppa',
        status: 'draft',
        title: 'Смоук: группа',
      },
      overrideAccess: false,
      user: admin,
    });
    created.collections.push(groupA.id);

    const groupB = await payload.create({
      collection: 'collections',
      data: {
        nodeKind: 'group',
        robots: 'noindex,follow',
        slug: 'smoke-vtoraya',
        status: 'draft',
        title: 'Смоук: вторая группа',
      },
      overrideAccess: false,
      user: admin,
    });
    created.collections.push(groupB.id);

    record('создание подборки в draft разрешено', groupA.status === 'draft' && groupA.robots === 'noindex,follow');
    record('путь подборки собран хуком', groupA.path === '/podborki/smoke-gruppa', String(groupA.path));

    /* --------------------------------------------------------------- */
    /* Э1-08: создание только в draft                                  */
    /* --------------------------------------------------------------- */

    await expectRejected('создание сразу в review отклонено (ai-editor)', 'только в статусе draft', () =>
      payload.create({
        collection: 'cards',
        data: {
          robots: 'noindex,follow',
          slug: 'smoke-review-na-sozdanii',
          status: 'review',
          title: 'Смоук',
        },
        overrideAccess: false,
        user: aiEditor,
      }),
    );

    await expectRejected('создание сразу в published отклонено (admin)', 'только в статусе draft', () =>
      payload.create({
        collection: 'cards',
        data: {
          robots: 'noindex,follow',
          slug: 'smoke-published-na-sozdanii',
          status: 'published',
          title: 'Смоук',
        },
        overrideAccess: false,
        user: admin,
      }),
    );

    await expectRejected('создание с index,follow отклонено', 'index,follow', () =>
      payload.create({
        collection: 'cards',
        data: {
          robots: 'index,follow',
          slug: 'smoke-index-na-sozdanii',
          status: 'draft',
          title: 'Смоук',
        },
        overrideAccess: false,
        user: admin,
      }),
    );

    const card = await payload.create({
      collection: 'cards',
      data: {
        robots: 'noindex,follow',
        slug: 'smoke-otkrytka',
        status: 'draft',
        title: 'Смоук: открытка',
      },
      overrideAccess: false,
      user: aiEditor,
    });
    created.cards.push(card.id);
    record(
      'новая карточка — draft, noindex, без publishedAt',
      card.status === 'draft' && card.robots === 'noindex,follow' && !card.publishedAt,
      `status=${card.status} robots=${card.robots} publishedAt=${String(card.publishedAt)}`,
    );

    /* --------------------------------------------------------------- */
    /* Э1-08: draft → review с валидацией полноты                      */
    /* --------------------------------------------------------------- */

    await expectRejected('неполная карточка в review не уходит', 'не заполнено', () =>
      payload.update({
        collection: 'cards',
        id: card.id,
        data: { status: 'review' },
        overrideAccess: false,
        user: aiEditor,
      }),
    );

    await expectOk('ai-editor заполняет метаданные и привязывает подборки', () =>
      payload.update({
        collection: 'cards',
        id: card.id,
        data: {
          alt: 'Смоук: описание изображения',
          caption: 'Смоук: подпись',
          collections: [groupA.id],
        },
        overrideAccess: false,
        user: aiEditor,
      }),
    );

    await expectOk('ai-editor переводит draft → review', () =>
      payload.update({
        collection: 'cards',
        id: card.id,
        data: { status: 'review' },
        overrideAccess: false,
        user: aiEditor,
      }),
    );

    /* --------------------------------------------------------------- */
    /* Э1-08: review → published только admin                          */
    /* --------------------------------------------------------------- */

    await expectRejected('ai-editor не публикует', 'только человек с ролью admin', () =>
      payload.update({
        collection: 'cards',
        id: card.id,
        data: { status: 'published' },
        overrideAccess: false,
        user: aiEditor,
      }),
    );

    await expectRejected('публикация без пользователя (код) отклонена', 'только человек с ролью admin', () =>
      payload.update({
        collection: 'cards',
        id: card.id,
        data: { status: 'published' },
        overrideAccess: false,
      }),
    );

    await expectRejected('публикация с index,follow одной операцией отклонена', 'ОТДЕЛЬН', () =>
      payload.update({
        collection: 'cards',
        id: card.id,
        data: { robots: 'index,follow', status: 'published' },
        overrideAccess: false,
        user: admin,
      }),
    );

    const published = await payload.update({
      collection: 'cards',
      id: card.id,
      data: { status: 'published' },
      overrideAccess: false,
      user: admin,
    });
    record(
      'admin публикует, publishedAt проставлен хуком',
      published.status === 'published' && typeof published.publishedAt === 'string',
      `publishedAt=${String(published.publishedAt)}`,
    );

    /* --------------------------------------------------------------- */
    /* Э1-08: index,follow отдельным действием                         */
    /* --------------------------------------------------------------- */

    await expectRejected('ai-editor не включает index,follow', 'только admin', () =>
      payload.update({
        collection: 'cards',
        id: card.id,
        data: { robots: 'index,follow' },
        overrideAccess: false,
        user: aiEditor,
      }),
    );

    const opened = await payload.update({
      collection: 'cards',
      id: card.id,
      data: { robots: 'index,follow' },
      overrideAccess: false,
      user: admin,
    });
    record('admin открывает индексацию вторым действием', opened.robots === 'index,follow');

    /* --------------------------------------------------------------- */
    /* Э1-09: неизменяемость URL и атомарный 301                       */
    /* --------------------------------------------------------------- */

    await expectRejected('смена slug опубликованной карточки без подтверждения отклонена', 'неизменяем', () =>
      payload.update({
        collection: 'cards',
        id: card.id,
        data: { slug: 'smoke-otkrytka-2' },
        overrideAccess: false,
        user: admin,
      }),
    );

    await expectRejected('ai-editor не меняет URL даже с подтверждением', 'меняет только admin', () =>
      payload.update({
        collection: 'cards',
        id: card.id,
        data: { slug: 'smoke-otkrytka-2', urlChange: { confirm: true } },
        overrideAccess: false,
        user: aiEditor,
      }),
    );

    const moved = await payload.update({
      collection: 'cards',
      id: card.id,
      data: { slug: 'smoke-otkrytka-2', urlChange: { confirm: true, reason: 'смоук' } },
      overrideAccess: false,
      user: admin,
    });
    const cardRedirects = await payload.find({
      collection: 'redirects',
      where: { from: { equals: '/otkrytki/smoke-otkrytka' } },
    });
    record(
      'смена URL с подтверждением создала ровно один 301',
      moved.slug === 'smoke-otkrytka-2' &&
        cardRedirects.totalDocs === 1 &&
        cardRedirects.docs[0]?.to === '/otkrytki/smoke-otkrytka-2' &&
        cardRedirects.docs[0]?.code === '301',
      `redirects=${String(cardRedirects.totalDocs)} to=${String(cardRedirects.docs[0]?.to)}`,
    );
    record('подтверждение одноразовое', moved.urlChange?.confirm === false, String(moved.urlChange?.confirm));

    await expectRejected('вторая смена slug без подтверждения отклонена', 'неизменяем', () =>
      payload.update({
        collection: 'cards',
        id: card.id,
        data: { slug: 'smoke-otkrytka-3' },
        overrideAccess: false,
        user: admin,
      }),
    );

    /* --------------------------------------------------------------- */
    /* Э1-08: снятие с публикации                                      */
    /* --------------------------------------------------------------- */

    await expectRejected('снятие с публикации без решения о URL отклонено', 'Решение о судьбе URL', () =>
      payload.update({
        collection: 'cards',
        id: card.id,
        data: { status: 'draft' },
        overrideAccess: false,
        user: admin,
      }),
    );

    // Целью 301 указан прежний путь этой же карточки — а он уже редиректит на
    // текущий. Это петля, и отказ обязан быть громким. Заодно проверяется
    // атомарность: снятие с публикации и создание редиректа идут одной
    // транзакцией, поэтому отказ обязан откатить и смену статуса.
    await expectRejected('невозможное решение о судьбе URL отклонено (петля)', 'петлю', () =>
      payload.update({
        collection: 'cards',
        id: card.id,
        data: {
          status: 'draft',
          withdrawal: { mode: '301', redirectTo: '/otkrytki/smoke-otkrytka' },
        },
        overrideAccess: false,
        user: admin,
      }),
    );
    const afterFailedWithdrawal = await payload.findByID({ collection: 'cards', id: card.id });
    record(
      'отказ в afterChange откатил транзакцию: запись осталась published',
      afterFailedWithdrawal.status === 'published',
      `status=${afterFailedWithdrawal.status}`,
    );

    const withdrawn = await payload.update({
      collection: 'cards',
      id: card.id,
      data: { status: 'draft', withdrawal: { mode: '301', redirectTo: '/otkrytki/smoke-zamena' } },
      overrideAccess: false,
      user: admin,
    });
    const afterWithdrawal = await payload.find({
      collection: 'redirects',
      where: { from: { equals: '/otkrytki/smoke-otkrytka-2' } },
    });
    record(
      'снятие с публикации: robots понижен, 301 создан',
      withdrawn.robots === 'noindex,follow' && afterWithdrawal.totalDocs === 1,
      `robots=${withdrawn.robots} redirects=${String(afterWithdrawal.totalDocs)}`,
    );

    // Возврат в публикацию: по пути снова отвечает страница, поэтому редирект с
    // него обязан исчезнуть — иначе middleware уводило бы запрос с живой страницы.
    await payload.update({
      collection: 'cards',
      id: card.id,
      data: { status: 'review' },
      overrideAccess: false,
      user: admin,
    });
    await payload.update({
      collection: 'cards',
      id: card.id,
      data: { status: 'published' },
      overrideAccess: false,
      user: admin,
    });
    const afterRepublish = await payload.find({
      collection: 'redirects',
      where: { from: { equals: '/otkrytki/smoke-otkrytka-2' } },
    });
    record(
      'возврат в публикацию снял редирект со своего пути',
      afterRepublish.totalDocs === 0,
      `осталось правил=${String(afterRepublish.totalDocs)}`,
    );

    // И снова снимаем с публикации: смоук не должен оставить ни одной
    // опубликованной записи, даже если дальше что-то упадёт.
    await payload.update({
      collection: 'cards',
      id: card.id,
      data: { status: 'draft', withdrawal: { mode: '404' } },
      overrideAccess: false,
      user: admin,
    });

    /* --------------------------------------------------------------- */
    /* Э1-08: пакетная операция (Ч-07, V11)                            */
    /* --------------------------------------------------------------- */

    const batch: number[] = [];
    for (const suffix of ['a', 'b']) {
      const doc = await payload.create({
        collection: 'cards',
        data: {
          alt: 'Смоук: alt',
          caption: 'Смоук: подпись',
          collections: [groupA.id],
          robots: 'noindex,follow',
          slug: `smoke-paket-${suffix}`,
          status: 'draft',
          title: `Смоук: пакет ${suffix}`,
        },
        overrideAccess: false,
        user: aiEditor,
      });
      created.cards.push(doc.id);
      batch.push(doc.id);
      await payload.update({
        collection: 'cards',
        id: doc.id,
        data: { status: 'review' },
        overrideAccess: false,
        user: aiEditor,
      });
    }

    await expectRejected('пакетная публикация по фильтру отклонена', 'ЯВНО выбранным', () =>
      payload.update({
        collection: 'cards',
        where: { status: { equals: 'review' } },
        data: { status: 'published' },
        overrideAccess: false,
        user: admin,
      }),
    );

    await expectRejected('пакетная публикация ai-editor отклонена', 'только роли admin', () =>
      payload.update({
        collection: 'cards',
        where: { id: { in: batch } },
        data: { status: 'published' },
        overrideAccess: false,
        user: aiEditor,
      }),
    );

    await expectRejected('пакетная публикация вместе с index,follow отклонена', 'отдельное явное действие', () =>
      payload.update({
        collection: 'cards',
        where: { id: { in: batch } },
        data: { robots: 'index,follow', status: 'published' },
        overrideAccess: false,
        user: admin,
      }),
    );

    await expectRejected('пакетная смена slug отклонена', 'Пакетная смена полей URL', () =>
      payload.update({
        collection: 'cards',
        where: { id: { in: batch } },
        data: { slug: 'smoke-obshchiy' },
        overrideAccess: false,
        user: admin,
      }),
    );

    // Форма «выбрать все доступные» из админки: перечисления записей нет.
    await expectRejected('пакетная публикация «все доступные» отклонена', 'ЯВНО выбранным', () =>
      payload.update({
        collection: 'cards',
        where: { and: [{ id: { not_equals: '' } }] },
        data: { status: 'published' },
        overrideAccess: false,
        user: admin,
      }),
    );

    // Ровно та форма запроса, которую строит админка Payload для выбранных
    // строк списка с активным фильтром: and из фильтра и перечисления id.
    const bulk = await payload.update({
      collection: 'cards',
      where: { and: [{ status: { equals: 'review' } }, { id: { in: batch } }] },
      data: { status: 'published' },
      overrideAccess: false,
      user: admin,
    });
    record(
      'admin публикует выбранную выборку одной операцией',
      bulk.docs.length === batch.length && bulk.errors.length === 0,
      `docs=${String(bulk.docs.length)} errors=${String(bulk.errors.length)}`,
    );

    const bulkIndex = await payload.update({
      collection: 'cards',
      where: { id: { in: batch } },
      data: { robots: 'index,follow' },
      overrideAccess: false,
      user: admin,
    });
    record(
      'пакетное index,follow отдельным действием проходит у admin',
      bulkIndex.docs.every((doc) => doc.robots === 'index,follow'),
    );

    const bulkHistory = await payload.find({
      collection: 'seo-history',
      limit: 200,
      where: { and: [{ field: { equals: 'status' } }, { documentId: { in: batch.map(String) } }] },
    });
    record(
      'история пишется по КАЖДОЙ записи пакета',
      bulkHistory.totalDocs >= batch.length * 2,
      `записей=${String(bulkHistory.totalDocs)}`,
    );

    /* --------------------------------------------------------------- */
    /* Э1-09: перенос поддерева подборок                               */
    /* --------------------------------------------------------------- */

    const occasion = await payload.create({
      collection: 'collections',
      data: {
        nodeKind: 'occasion',
        parent: groupA.id,
        robots: 'noindex,follow',
        slug: 'smoke-povod',
        status: 'draft',
        title: 'Смоук: повод',
      },
      overrideAccess: false,
      user: admin,
    });
    created.collections.push(occasion.id);

    for (const node of [groupA, occasion]) {
      await payload.update({
        collection: 'collections',
        id: node.id,
        data: {
          intro: RICH_TEXT,
          metaDescription: 'Смоук: описание',
          related: [groupB.id],
          responsibleEditor: adminDoc.id,
        },
        overrideAccess: false,
        user: admin,
      });
      await payload.update({
        collection: 'collections',
        id: node.id,
        data: { status: 'review' },
        overrideAccess: false,
        user: admin,
      });
      await payload.update({
        collection: 'collections',
        id: node.id,
        data: { status: 'published' },
        overrideAccess: false,
        user: admin,
      });
    }

    const beforeMove = await payload.find({ collection: 'redirects', limit: 200 });

    await expectOk('перенос опубликованного узла с подтверждением', () =>
      payload.update({
        collection: 'collections',
        id: groupA.id,
        data: { slug: 'smoke-gruppa-2', urlChange: { confirm: true, reason: 'смоук поддерева' } },
        overrideAccess: false,
        user: admin,
      }),
    );

    const afterMove = await payload.find({ collection: 'redirects', limit: 200 });
    const fresh = afterMove.docs.filter(
      (doc) => !beforeMove.docs.some((old) => old.id === doc.id),
    );
    const movedChild = await payload.findByID({ collection: 'collections', id: occasion.id });
    const sources = new Set(afterMove.docs.map((doc) => doc.from));
    record(
      'перенос поддерева дал по одному 301 на каждый путь',
      fresh.length === 2 &&
        fresh.every((doc) => doc.code === '301') &&
        movedChild.path === '/podborki/smoke-gruppa-2/smoke-povod',
      `новых редиректов=${String(fresh.length)}: ${fresh.map((doc) => `${String(doc.from)}→${String(doc.to)}`).join(', ')}`,
    );
    record(
      'цепочек не возникло',
      afterMove.docs.every((doc) => !doc.to || !sources.has(doc.to)),
    );

    /* --------------------------------------------------------------- */
    /* Э1-07: история и её неизменяемость                              */
    /* --------------------------------------------------------------- */

    const cardHistory = await payload.find({
      collection: 'seo-history',
      limit: 200,
      sort: 'changedAt',
      where: { and: [{ documentCollection: { equals: 'cards' } }, { documentId: { equals: String(card.id) } }] },
    });
    const roles = new Set(cardHistory.docs.map((entry) => entry.authorRole));
    record(
      'история карточки содержит правки обоих авторов',
      roles.has('admin') && roles.has('ai-editor'),
      `записей=${String(cardHistory.totalDocs)} роли=${[...roles].join(', ')}`,
    );
    const slugEntry = cardHistory.docs.find((entry) => entry.field === 'slug' && entry.operation === 'update');
    record(
      'смена URL зафиксирована как «старое → новое»',
      slugEntry?.previousValue === 'smoke-otkrytka' && slugEntry?.nextValue === 'smoke-otkrytka-2',
      `${String(slugEntry?.previousValue)} → ${String(slugEntry?.nextValue)}`,
    );

    const someEntry = cardHistory.docs[0];
    if (someEntry !== undefined) {
      await expectRejected('запись истории нельзя отредактировать', 'неизменяема', () =>
        payload.update({
          collection: 'seo-history',
          id: someEntry.id,
          data: { nextValue: 'подмена' },
        }),
      );
      await expectRejected('запись истории нельзя создать снаружи', 'not allowed', () =>
        payload.create({
          collection: 'seo-history',
          data: {
            authorRole: 'admin',
            changedAt: new Date().toISOString(),
            documentCollection: 'cards',
            documentId: '0',
            field: 'title',
            operation: 'update',
          },
          overrideAccess: false,
          user: admin,
        }),
      );
    }

    /* --------------------------------------------------------------- */
    /* Наблюдение: молчаливое срезание поля (для отчёта)               */
    /* --------------------------------------------------------------- */

    const silent = await payload.update({
      collection: 'cards',
      id: card.id,
      data: { canonical: '/otkrytki/podmena' },
      overrideAccess: false,
      user: aiEditor,
    });
    record(
      'поле canonical у ai-editor по-прежнему срезается молча (200, значение не применено)',
      !silent.canonical,
      `canonical=${String(silent.canonical)}`,
    );
  } finally {
    /* --------------------------------------------------------------- */
    /* Уборка: смоук не оставляет ни записей, ни публикаций            */
    /* --------------------------------------------------------------- */
    for (const id of created.cards) {
      await payload.delete({ collection: 'cards', id }).catch(() => undefined);
      await payload
        .delete({
          collection: 'seo-history',
          where: { and: [{ documentCollection: { equals: 'cards' } }, { documentId: { equals: String(id) } }] },
        })
        .catch(() => undefined);
    }
    for (const id of [...created.collections].reverse()) {
      await payload.delete({ collection: 'collections', id }).catch(() => undefined);
      await payload
        .delete({
          collection: 'seo-history',
          where: {
            and: [{ documentCollection: { equals: 'collections' } }, { documentId: { equals: String(id) } }],
          },
        })
        .catch(() => undefined);
    }
    await payload
      .delete({ collection: 'redirects', where: { from: { like: 'smoke' } } })
      .catch(() => undefined);
    await payload
      .delete({ collection: 'redirects', where: { to: { like: 'smoke' } } })
      .catch(() => undefined);
    for (const id of created.users) {
      await payload.delete({ collection: 'users', id }).catch(() => undefined);
    }

    const leftovers = await payload.count({ collection: 'cards' });
    const leftoverCollections = await payload.count({ collection: 'collections' });
    const leftoverRedirects = await payload.count({ collection: 'redirects' });
    const leftoverHistory = await payload.count({ collection: 'seo-history' });
    console.log(
      `\nПосле уборки: cards=${String(leftovers.totalDocs)} collections=${String(leftoverCollections.totalDocs)} ` +
        `redirects=${String(leftoverRedirects.totalDocs)} seo-history=${String(leftoverHistory.totalDocs)}`,
    );

    const failed = checks.filter((check) => !check.ok);
    console.log(`\nИТОГ: ${String(checks.length - failed.length)}/${String(checks.length)} проверок пройдено`);
    for (const check of failed) {
      console.log(`  ПРОВАЛ: ${check.name} — ${check.detail}`);
    }
  }
}

await main();
