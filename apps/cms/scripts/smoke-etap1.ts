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
 * Скрипт удаляет за собой все созданные записи, включая историю, редиректы,
 * изображения и занятые ими имена файлов, и не оставляет ни одной
 * опубликованной записи.
 *
 * ПОЧЕМУ ЗДЕСЬ ЕСТЬ ИЗОБРАЖЕНИЯ, хотя проверяется статусная модель. С задачей
 * Э2-04 в схеме появилось поле `cards.image`, и требование полноты перед
 * `review` включилось само (`CARD_REVIEW_REQUIREMENTS`): карточка без
 * изображения дальше черновика не идёт. Поэтому каждая карточка смоука получает
 * СВОЁ изображение, и композиции у них разные (`grid`, `rings`, `stripes`) —
 * перцептивные хеши расходятся на 26–36 бит при пороге 14, поэтому блокировка
 * визуальных дублей (Э2-05) здесь не срабатывает и не смешивается с проверкой
 * переходов. Одна картинка на три карточки означала бы три визуальных дубля, и
 * смоук статусной модели упирался бы в чужое правило.
 */
import { getPayload } from 'payload';

import config from '../src/payload.config';
import { createPngFixture } from '../src/images/png-fixture';
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

  /**
   * Создание с ЗАВЕДОМО неполными данными.
   *
   * Нужно ровно для одной проверки: пользователь без явной роли. В
   * сгенерированных типах `role` обязательна, поэтому вызов с полными типами не
   * собрался бы — а проверить надо именно то, что происходит с запросом БЕЗ
   * этого поля (так его пришлёт внешний клиент). Расширение типа локальное и
   * применяется только здесь.
   */
  const createWithLooseData = (
    collection: 'users',
    data: Record<string, unknown>,
  ): Promise<unknown> => {
    const create = payload.create as unknown as (args: {
      collection: string;
      data: Record<string, unknown>;
    }) => Promise<unknown>;
    return create({ collection, data });
  };

  const created = {
    cardImages: [] as number[],
    cards: [] as number[],
    collections: [] as number[],
    users: [] as number[],
  };
  /** Имена файлов, занятые смоуком: реестр их не отдаёт обратно сам. */
  const claimedStems: string[] = [];

  /**
   * Загружает изображение для карточки. Композиция задаётся явно: разные
   * композиции — разные картинки, одна композиция со сдвигом яркости была бы
   * визуальным дублем и включила бы блокировку Э2-05.
   */
  async function uploadImage(
    title: string,
    composition: 'grid' | 'rings' | 'stripes',
    user: unknown,
  ): Promise<number> {
    const bytes = createPngFixture({ composition, height: 500, width: 800 });
    const image = await payload.create({
      collection: 'card-images',
      data: { title },
      file: { data: bytes, mimetype: 'image/png', name: `${composition}.png`, size: bytes.byteLength },
      overrideAccess: false,
      user: user as Parameters<typeof payload.create>[0]['user'],
    });
    created.cardImages.push(image.id);
    if (typeof image.nameStem === 'string') {
      claimedStems.push(image.nameStem);
    }
    return image.id;
  }

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

    const imageMain = await uploadImage('Смоук изображение основное', 'grid', aiEditor);

    await expectOk('ai-editor заполняет метаданные, изображение и привязывает подборки', () =>
      payload.update({
        collection: 'cards',
        id: card.id,
        data: {
          alt: 'Смоук: описание изображения',
          caption: 'Смоук: подпись',
          collections: [groupA.id],
          image: imageMain,
          // Требование полноты перед `review` пополнилось description по
          // вердикту ревизии Э3-05/Э3-06 (`CARD_REVIEW_REQUIREMENTS`). Смоук
          // этап-1 об этом не знал и обрывался на переходе в `review`, а
          // докладывал нулём: код выхода затирал `payload run`.
          metaDescription: 'Смоук: описание карточки для проверки полноты перед review.',
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
    const batchCompositions = { a: 'rings', b: 'stripes' } as const;
    for (const suffix of ['a', 'b'] as const) {
      const image = await uploadImage(
        `Смоук изображение пакет ${suffix}`,
        batchCompositions[suffix],
        aiEditor,
      );
      const doc = await payload.create({
        collection: 'cards',
        data: {
          alt: 'Смоук: alt',
          caption: 'Смоук: подпись',
          collections: [groupA.id],
          image,
          metaDescription: `Смоук: описание карточки пакета ${suffix}.`,
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
    /* Пакетное СНЯТИЕ с публикации (находка ревизии 2026-08-22)        */
    /* --------------------------------------------------------------- */

    // Прежний гейт проверял только вход в published и включение индексации,
    // поэтому УХОД из published до проверок не доходил: один запрос по фильтру
    // «все опубликованные» с общим решением { mode: '301', redirectTo: '/' }
    // создавал по 301 с каждого снятого пути на главную — прямой запрет п. 23.
    const redirectsBefore = await payload.count({ collection: 'redirects' });

    await expectRejected(
      'пакетное снятие с публикации по фильтру отклонено',
      'ЯВНО выбранным',
      () =>
        payload.update({
          collection: 'cards',
          where: { status: { equals: 'published' } },
          data: { status: 'draft' },
          overrideAccess: false,
          user: admin,
        }),
    );

    await expectRejected(
      'один общий redirectTo на выборку отклонён',
      'Решение о судьбе URL нельзя применить к выборке',
      () =>
        payload.update({
          collection: 'cards',
          where: { id: { in: batch } },
          data: { status: 'draft', withdrawal: { mode: '301', redirectTo: '/' } },
          overrideAccess: false,
          user: admin,
        }),
    );

    await expectRejected(
      'общее решение 410 на выборку отклонено тоже',
      'Решение о судьбе URL нельзя применить к выборке',
      () =>
        payload.update({
          collection: 'cards',
          where: { id: { in: batch } },
          data: { status: 'draft', withdrawal: { mode: '410' } },
          overrideAccess: false,
          user: admin,
        }),
    );

    const redirectsAfter = await payload.count({ collection: 'redirects' });
    record(
      'отклонённые пакеты не создали ни одного 301',
      redirectsAfter.totalDocs === redirectsBefore.totalDocs,
      `было=${String(redirectsBefore.totalDocs)} стало=${String(redirectsAfter.totalDocs)}`,
    );

    const afterRefusals = await payload.find({
      collection: 'cards',
      limit: batch.length,
      where: { id: { in: batch } },
    });
    record(
      'записи выборки остались опубликованными: пакет отклонён целиком',
      afterRefusals.docs.every((doc) => doc.status === 'published'),
      afterRefusals.docs.map((doc) => String(doc.status)).join(', '),
    );

    const [firstOfBatch] = batch;
    if (firstOfBatch === undefined) {
      throw new Error('выборка пакета пуста — смоук собран неверно');
    }
    const withdrawnOne = await payload.update({
      collection: 'cards',
      id: firstOfBatch,
      data: { status: 'draft', withdrawal: { mode: '410', redirectTo: null } },
      overrideAccess: false,
      user: admin,
    });
    record(
      'поштучное снятие с решением 410 работает как раньше',
      withdrawnOne.status === 'draft' && withdrawnOne.robots === 'noindex,follow',
      `status=${String(withdrawnOne.status)} robots=${String(withdrawnOne.robots)}`,
    );

    /* --------------------------------------------------------------- */
    /* Год в адресе (условие C3, находка ревизии 2026-08-22)            */
    /* --------------------------------------------------------------- */

    await expectRejected(
      'год в slug карточки отклонён хуком',
      'есть год 2027',
      () =>
        payload.create({
          collection: 'cards',
          data: {
            robots: 'noindex,follow',
            slug: 'smoke-novyy-god-2027',
            status: 'draft',
            title: 'Смоук: Новый год 2027',
          },
          overrideAccess: false,
          user: aiEditor,
        }),
    );

    await expectRejected(
      'год в slug праздничной посадочной отклонён хуком',
      'есть год 2027',
      () =>
        payload.create({
          collection: 'collections',
          data: {
            nodeKind: 'occasion',
            parent: groupA.id,
            robots: 'noindex,follow',
            slug: 'smoke-novyy-god-2027',
            status: 'draft',
            title: 'Смоук: Новый год 2027',
          },
          overrideAccess: false,
          user: admin,
        }),
    );

    // Вердикт url-guard: год попадал в адрес двумя обходными путями.
    // (а) сегмент группы входит в адрес каждого повода под ней.
    await expectRejected(
      'год в slug группирующего узла отклонён (адрес потомков)',
      'есть год 2027',
      () =>
        payload.create({
          collection: 'collections',
          data: {
            nodeKind: 'group',
            robots: 'noindex,follow',
            slug: 'smoke-prazdniki-2027',
            status: 'draft',
            title: 'Смоук: Праздники 2027',
          },
          overrideAccess: false,
          user: admin,
        }),
    );

    // (б) recipient прямо под группой: матрица это допускает, а проверка по
    // виду узла пропускала.
    await expectRejected(
      'год в slug уточнения прямо под группой отклонён',
      'есть год 2027',
      () =>
        payload.create({
          collection: 'collections',
          data: {
            nodeKind: 'recipient',
            parent: groupA.id,
            robots: 'noindex,follow',
            slug: 'smoke-novyy-god-2027',
            status: 'draft',
            title: 'Смоук: Новый год 2027',
          },
          overrideAccess: false,
          user: admin,
        }),
    );

    /* --------------------------------------------------------------- */
    /* Роль пользователя без дефолта (находка ревизии 2026-08-22)       */
    /* --------------------------------------------------------------- */

    // Payload отвечает на пропущенное обязательное поле своим текстом
    // («The following field is invalid: Role») — это и есть громкий отказ
    // вместо прежнего молчаливого «получи роль admin по умолчанию».
    await expectRejected(
      'пользователь без явной роли не создаётся',
      'Role',
      () =>
        createWithLooseData('users', {
          email: `smoke-bez-roli-${String(Date.now())}@otkritka.test`,
          password: `smoke-${String(Date.now())}`,
        }),
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

    // Пустой узел не публикуется (`empty-for-publish`, вердикт ревизии
    // Э3-05/Э3-06), а перенос поддерева проверяется именно на ОПУБЛИКОВАННЫХ
    // узлах: 301 возникает только у известного поисковику пути. Поэтому в
    // дочерний узел добавляется уже опубликованная карточка пакета — связь
    // many-to-many, поэтому URL самой карточки от этого не меняется, она просто
    // входит в две подборки. До этой правки смоук обрывался здесь исключением, а
    // докладывал нулём: код выхода затирал `payload run`.
    const [, secondOfBatch] = batch;
    if (secondOfBatch === undefined) {
      throw new Error('во выборке пакета меньше двух записей — смоук собран неверно');
    }
    await payload.update({
      collection: 'cards',
      id: secondOfBatch,
      data: { collections: [groupA.id, occasion.id] },
      overrideAccess: false,
      user: admin,
    });

    for (const node of [groupA, occasion]) {
      await payload.update({
        collection: 'collections',
        id: node.id,
        data: {
          intro: RICH_TEXT,
          // Описание СВОЁ у каждого узла. Общая строка на два узла означала бы,
          // что второй из них упирается в калитку дублей метатегов (Э5-01,
          // `meta-duplicate-unresolved`) на переходе в review: первый к этому
          // моменту уже опубликован и попадает в круг поиска. Смоук проверяет
          // перенос поддерева, а не поведение калитки дублей, — и не должен
          // ставить модель в состояние, которого она не допускает.
          metaDescription: `Смоук: описание узла ${node.slug}`,
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
    for (const id of created.cardImages) {
      // afterDelete коллекции убирает и производные, и оригинал из хранилища.
      await payload.delete({ collection: 'card-images', id }).catch(() => undefined);
    }
    // Реестр занятых имён снаружи не удаляется никем — это его смысл. Здесь
    // уборка идёт через Local API с overrideAccess: правило защищает REST и
    // GraphQL, а смоук не должен оставлять следов.
    for (const stem of claimedStems) {
      await payload
        .delete({ collection: 'image-name-claims', where: { stem: { equals: stem } } })
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
    const leftoverImages = await payload.count({ collection: 'card-images' });
    const leftoverClaims = await payload.count({ collection: 'image-name-claims' });
    const leftoverPublished = await payload.count({
      collection: 'cards',
      where: { status: { equals: 'published' } },
    });
    console.log(
      `\nПосле уборки: cards=${String(leftovers.totalDocs)} collections=${String(leftoverCollections.totalDocs)} ` +
        `redirects=${String(leftoverRedirects.totalDocs)} seo-history=${String(leftoverHistory.totalDocs)} ` +
        `card-images=${String(leftoverImages.totalDocs)} image-name-claims=${String(leftoverClaims.totalDocs)} ` +
        `published=${String(leftoverPublished.totalDocs)}`,
    );

    const failed = checks.filter((check) => !check.ok);
    console.log(`\nИТОГ: ${String(checks.length - failed.length)}/${String(checks.length)} проверок пройдено`);
    for (const check of failed) {
      console.log(`  ПРОВАЛ: ${check.name} — ${check.detail}`);
    }
  }
}

// Код выхода выставляет `finishSmoke`, а не `process.exitCode`: `payload run`
// после скрипта безусловно делает `process.exit(0)` (`payload/dist/bin/index.js`)
// и выставленное поле затирает — красный смоук выходил бы нулём. Решение о коде
// вынесено ЗА `main` намеренно: вызов изнутри `finally` при исключении,
// оборвавшем смоук, вышел бы нулём и съел саму ошибку.
try {
  await main();
} catch (error) {
  console.error('\nСмоук оборван ошибкой:', error);
  await finishSmoke(1);
}

await finishSmoke(checks.filter((check) => !check.ok).length);
