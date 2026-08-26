/**
 * Смоук правок по вердикту ревизии Э3-05/Э3-06 на ЖИВОЙ базе.
 *
 * Что здесь проверяется и почему юнит-тестов недостаточно:
 *
 *   1. **узел lexical без фичи не сохраняется через API.** Набор фич поля
 *      (`src/editor/public-rich-text.ts`) закрывает форму админки, но проверка
 *      узлов у Payload регистрируется САМИМИ фичами: у отсутствующей фичи
 *      проверок нет, поэтому `upload` внутри вводного текста через REST прошёл
 *      бы молча. Правило, живущее в интерфейсе, внешний AI-редактор обходит —
 *      значит проверять надо именно вход API, а не конфиг;
 *   2. **description обязателен перед `review`** — и у карточки, и у подборки;
 *   3. **пустой узел не публикуется** (`empty-for-publish`): его публичная
 *      страница отдаёт 404, то есть ссылка на него из родительской подборки
 *      была бы битой (вето V5);
 *   4. **порог п. 5.1 стоит на `index,follow`, а не на публикации**
 *      (`thin-content-for-index`): опубликованная страница с одной открыткой
 *      законна и остаётся `noindex,follow`, а в индекс её не пускает отказ.
 *
 * Запуск: pnpm --filter @otkritka/cms exec payload run ./scripts/smoke-etap3b.ts
 *
 * Скрипт публикует записи — это действие роли `admin`, выполняемое Local API от
 * имени администратора, тем же способом, что смоуки Э2 и Э3-03a. `index,follow`
 * включается ровно один раз, чтобы показать положительную сторону порога, и тут
 * же снимается; уборка удаляет всё созданное и печатает счётчики, включая число
 * опубликованных записей — оно обязано вернуться к исходному.
 */
import { getPayload } from 'payload';

import config from '../src/payload.config';
import { MIN_PUBLISHED_CARDS_ENV_KEY } from '../src/collections/collection-volume';
import type { Collection } from '../src/payload-types';
import { createPngFixture } from '../src/images/png-fixture';

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

/**
 * Ожидает отказ с конкретным машинным признаком.
 *
 * Признак, а не текст: зелёный негативный смоук на совпадении подстроки может
 * держаться на совсем другом отказе — например на нехватке прав.
 */
async function expectRule(name: string, rule: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const actual = ruleOf(error);
    record(
      name,
      actual === rule,
      `rule=${actual === '' ? '(нет)' : actual}; ${messageOf(error).slice(0, 200)}`,
    );
    return;
  }
  record(name, false, 'операция прошла, хотя должна была быть отклонена');
}

/** Вводный текст подборки в том виде, в каком его хранит richText. */
type Intro = NonNullable<Collection['intro']>;

/** Вводный текст в форме, которую пишет richText. */
function lexical(text: string): Intro {
  return {
    root: {
      type: 'root',
      children: [
        { type: 'paragraph', version: 1, children: [{ type: 'text', text, version: 1 }] },
      ],
      direction: 'ltr' as const,
      format: '' as const,
      indent: 0,
      version: 1,
    },
  };
}

/**
 * Тот же документ, но с узлом изображения — тем, которого шаблон не печатает.
 *
 * Сгенерированный тип поля допускает произвольный узел (`type: string`), и это
 * ровно то, что проверяет смоук: типы такой документ не отклоняют, отклонить его
 * обязан сервер — иначе через REST, где типов нет вовсе, узел сохранился бы.
 */
function lexicalWithUpload(imageId: number): Intro {
  return {
    root: {
      type: 'root',
      children: [
        { type: 'paragraph', version: 1, children: [{ type: 'text', text: 'Текст', version: 1 }] },
        { type: 'upload', version: 1, relationTo: 'card-images', value: imageId, fields: {} },
      ],
      direction: 'ltr' as const,
      format: '' as const,
      indent: 0,
      version: 1,
    },
  };
}

const STAMP = String(Date.now());

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
  const savedThreshold = process.env[MIN_PUBLISHED_CARDS_ENV_KEY];

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
        email: `smoke3b-ai-${STAMP}@otkritka.test`,
        password: `smoke-${STAMP}`,
        role: 'ai-editor',
      },
    });
    created.users.push(service.id);
    const aiEditor = { ...service, collection: 'users' as const };

    /* --------------------------------------------------------------- */
    /* Дерево подборок: группа → повод                                  */
    /* --------------------------------------------------------------- */

    const group = await payload.create({
      collection: 'collections',
      data: {
        nodeKind: 'group',
        robots: 'noindex,follow',
        slug: 'smouk-e3b',
        status: 'draft',
        title: 'Смоук Э3b: группа',
      },
      overrideAccess: false,
      user: admin,
    });
    created.collections.push(group.id);

    const node = await payload.create({
      collection: 'collections',
      data: {
        intro: lexical('Вводный текст смоука: подборка про открытки.'),
        nodeKind: 'occasion',
        parent: group.id,
        related: [group.id],
        robots: 'noindex,follow',
        slug: 'smouk-povod',
        status: 'draft',
        title: 'Смоук Э3b: повод',
      },
      overrideAccess: false,
      user: admin,
    });
    created.collections.push(node.id);

    /* --------------------------------------------------------------- */
    /* 1. Узел вводного текста, которого публичный шаблон не печатает   */
    /* --------------------------------------------------------------- */

    const bytes = createPngFixture({ height: 700, width: 1100 });
    const image = await payload.create({
      collection: 'card-images',
      data: { title: `Смоук Э3b ${STAMP}` },
      file: { data: bytes, mimetype: 'image/png', name: `IMG_3B_${STAMP}.png`, size: bytes.byteLength },
      overrideAccess: false,
      user: aiEditor,
    });
    created.cardImages.push(image.id);
    if (typeof image.nameStem === 'string') {
      claimedStems.push(image.nameStem);
    }

    await expectRule(
      'изображение внутри вводного текста отклонено через API (не только в форме)',
      'unsupported-rich-text-node',
      () =>
        payload.update({
          collection: 'collections',
          id: node.id,
          data: { intro: lexicalWithUpload(image.id) },
          overrideAccess: false,
          user: aiEditor,
        }),
    );

    const introSurvived = await payload.findByID({ collection: 'collections', id: node.id });
    record(
      'после отказа вводный текст остался прежним',
      JSON.stringify(introSurvived.intro).includes('Вводный текст смоука'),
    );

    /* --------------------------------------------------------------- */
    /* 2. description обязателен перед review                           */
    /* --------------------------------------------------------------- */

    await expectRule(
      'подборка без description в review не уходит',
      'incomplete-for-review',
      () =>
        payload.update({
          collection: 'collections',
          id: node.id,
          data: { status: 'review' },
          overrideAccess: false,
          user: aiEditor,
        }),
    );

    const card = await payload.create({
      collection: 'cards',
      data: {
        alt: 'Смоук Э3b: тюльпаны на открытке',
        caption: 'С праздником!',
        collections: [node.id],
        image: image.id,
        robots: 'noindex,follow',
        slug: `smouk-otkrytka-${STAMP}`,
        status: 'draft',
        title: `Смоук Э3b: открытка ${STAMP}`,
      },
      overrideAccess: false,
      user: aiEditor,
    });
    created.cards.push(card.id);

    await expectRule('карточка без description в review не уходит', 'incomplete-for-review', () =>
      payload.update({
        collection: 'cards',
        id: card.id,
        data: { status: 'review' },
        overrideAccess: false,
        user: aiEditor,
      }),
    );

    const cardInReview = await payload.update({
      collection: 'cards',
      id: card.id,
      data: { metaDescription: 'Открытка смоука Э3b для проверки полноты', status: 'review' },
      overrideAccess: false,
      user: aiEditor,
    });
    record(
      'с заполненным description карточка уходит в review руками ai-editor',
      cardInReview.status === 'review',
      String(cardInReview.status),
    );

    const nodeInReview = await payload.update({
      collection: 'collections',
      id: node.id,
      data: { metaDescription: 'Подборка смоука Э3b', status: 'review' },
      overrideAccess: false,
      user: admin,
    });
    record(
      'с заполненным description подборка уходит в review',
      nodeInReview.status === 'review',
      String(nodeInReview.status),
    );

    /* --------------------------------------------------------------- */
    /* 3. Пустой узел не публикуется                                    */
    /* --------------------------------------------------------------- */

    await expectRule(
      'подборка без опубликованных открыток и детей не публикуется',
      'empty-for-publish',
      () =>
        payload.update({
          collection: 'collections',
          id: node.id,
          data: { status: 'published' },
          overrideAccess: false,
          user: admin,
        }),
    );

    const publishedCard = await payload.update({
      collection: 'cards',
      id: card.id,
      data: { status: 'published' },
      overrideAccess: false,
      user: admin,
    });
    record(
      'открытку публикует admin, robots остаётся закрывающим',
      publishedCard.status === 'published' && publishedCard.robots === 'noindex,follow',
      `${String(publishedCard.status)} / ${String(publishedCard.robots)}`,
    );

    const publishedNode = await payload.update({
      collection: 'collections',
      id: node.id,
      data: { status: 'published' },
      overrideAccess: false,
      user: admin,
    });
    record(
      'с одной опубликованной открыткой подборка публикуется',
      publishedNode.status === 'published' && publishedNode.robots === 'noindex,follow',
      `${String(publishedNode.status)} / ${String(publishedNode.robots)}`,
    );

    // Группа проходит тот же путь draft → review → published: перескок моделью
    // не предусмотрен, и это проверяет сам смоук своим падением, если правило
    // однажды ослабят.
    await payload.update({
      collection: 'collections',
      id: group.id,
      data: {
        intro: lexical('Вводный текст группирующего узла смоука.'),
        metaDescription: 'Группа смоука Э3b',
        related: [node.id],
        status: 'review',
      },
      overrideAccess: false,
      user: admin,
    });

    const publishedGroup = await payload.update({
      collection: 'collections',
      id: group.id,
      data: { status: 'published' },
      overrideAccess: false,
      user: admin,
    });
    record(
      'группирующий узел публикуется по опубликованному ребёнку',
      publishedGroup.status === 'published',
      String(publishedGroup.status),
    );

    /* --------------------------------------------------------------- */
    /* 4. Порог п. 5.1 стоит на index,follow                            */
    /* --------------------------------------------------------------- */

    delete process.env[MIN_PUBLISHED_CARDS_ENV_KEY];
    await expectRule(
      'index,follow при одной открытке отклонён порогом Ч-06 (по умолчанию 20)',
      'thin-content-for-index',
      () =>
        payload.update({
          collection: 'collections',
          id: node.id,
          data: { robots: 'index,follow' },
          overrideAccess: false,
          user: admin,
        }),
    );

    const stillNoindex = await payload.findByID({ collection: 'collections', id: node.id });
    record(
      'после отказа страница осталась noindex,follow и опубликованной',
      stillNoindex.robots === 'noindex,follow' && stillNoindex.status === 'published',
      `${String(stillNoindex.status)} / ${String(stillNoindex.robots)}`,
    );

    // Порог — параметр (Ч-06). Понижаем его до 1, чтобы показать, что отказ
    // снимается выполненным условием, а не отсутствием проверки.
    process.env[MIN_PUBLISHED_CARDS_ENV_KEY] = '1';

    await expectRule(
      'ai-editor не открывает индексацию даже при выполненном пороге',
      'index-requires-admin',
      () =>
        payload.update({
          collection: 'collections',
          id: node.id,
          data: { robots: 'index,follow' },
          overrideAccess: false,
          user: aiEditor,
        }),
    );

    const opened = await payload.update({
      collection: 'collections',
      id: node.id,
      data: { robots: 'index,follow' },
      overrideAccess: false,
      user: admin,
    });
    record(
      'при выполненном пороге admin открывает индексацию вторым сохранением',
      opened.robots === 'index,follow',
      `порог ${String(process.env[MIN_PUBLISHED_CARDS_ENV_KEY])}, robots ${String(opened.robots)}`,
    );

    const closed = await payload.update({
      collection: 'collections',
      id: node.id,
      data: { robots: 'noindex,follow' },
      overrideAccess: false,
      user: admin,
    });
    record(
      'индексация снята обратно: смоук не оставляет страницу в индексе',
      closed.robots === 'noindex,follow',
      String(closed.robots),
    );
  } finally {
    /* --------------------------------------------------------------- */
    /* Уборка                                                          */
    /* --------------------------------------------------------------- */
    if (savedThreshold === undefined) {
      delete process.env[MIN_PUBLISHED_CARDS_ENV_KEY];
    } else {
      process.env[MIN_PUBLISHED_CARDS_ENV_KEY] = savedThreshold;
    }

    // Порядок обязателен: карточка → изображение. Удалить изображение, на
    // которое ссылается карточка, нельзя — это защита Э2-06.
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
    for (const id of created.cardImages) {
      await payload.delete({ collection: 'card-images', id }).catch(() => undefined);
    }
    // Подборки — от листа к корню: удаление узла с детьми отклоняется хуком.
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
    for (const stem of claimedStems) {
      await payload
        .delete({ collection: 'image-name-claims', where: { stem: { equals: stem } } })
        .catch(() => undefined);
    }
    await payload
      .delete({ collection: 'redirects', where: { from: { like: 'smouk' } } })
      .catch(() => undefined);
    for (const id of created.users) {
      await payload.delete({ collection: 'users', id }).catch(() => undefined);
    }

    const counts = {
      cardImages: (await payload.count({ collection: 'card-images' })).totalDocs,
      cards: (await payload.count({ collection: 'cards' })).totalDocs,
      claims: (await payload.count({ collection: 'image-name-claims' })).totalDocs,
      collections: (await payload.count({ collection: 'collections' })).totalDocs,
      history: (await payload.count({ collection: 'seo-history' })).totalDocs,
      publishedCards: (
        await payload.count({ collection: 'cards', where: { status: { equals: 'published' } } })
      ).totalDocs,
      publishedCollections: (
        await payload.count({
          collection: 'collections',
          where: { status: { equals: 'published' } },
        })
      ).totalDocs,
      redirects: (await payload.count({ collection: 'redirects' })).totalDocs,
    };
    console.log(`\nПосле уборки: ${JSON.stringify(counts)}`);
    record(
      'после уборки опубликованных записей столько же, сколько до смоука',
      counts.publishedCards === before.publishedCards &&
        counts.publishedCollections === before.publishedCollections,
      `было ${JSON.stringify(before)}`,
    );

    const failed = checks.filter((check) => !check.ok);
    console.log(
      `\nИТОГ: ${String(checks.length - failed.length)}/${String(checks.length)} проверок пройдено`,
    );
    for (const check of failed) {
      console.log(`  ПРОВАЛ: ${check.name} — ${check.detail}`);
    }
    if (failed.length > 0) {
      process.exitCode = 1;
    }
  }
}

await main();
