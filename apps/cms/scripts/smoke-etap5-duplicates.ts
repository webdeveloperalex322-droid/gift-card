/**
 * Смоук Э5-01 и Э5-02 на ЖИВОЙ базе: дубли метатегов и визуальные дубли.
 *
 * ЗАЧЕМ СМОУК, ЕСЛИ ЕСТЬ ЮНИТ-ТЕСТЫ. Юнит-тесты доказывают, что правила верны, а
 * стенд в `content-hooks.test.ts` — что они стоят в нужной фазе. Ни то, ни
 * другое не доказывает, что правило РАБОТАЕТ на живом ядре: между чистой
 * функцией и сохранённой строкой лежат access control полей, слияние входных
 * данных с документом, настоящий SQL с индексами по нормализованным ключам и
 * транзакция. Потерять правило можно там, не уронив ни одного теста. Поэтому всё
 * здесь идёт через Local API с `overrideAccess: false` и явным пользователем —
 * тем же путём, которым идут REST и GraphQL, а не формой админки.
 *
 * ЧТО ПРОВЕРЯЕТСЯ (Э5-01):
 *   1. совпадение ищется в ОБЕИХ коллекциях: заголовок карточки против заголовка
 *      подборки. Пространства имён разведены, а выдача поисковика — нет;
 *   2. предупреждение приходит В ОТВЕТЕ на сохранение (снимок в записи), а не
 *      только строкой в журнале, которого внешний AI-редактор не видит;
 *   3. виртуальное поле-зеркало `summary` приходит на чтении и совпадает с
 *      единственной формулировкой проекта;
 *   4. перевод в review при неразрешённом конфликте отклонён машинным признаком
 *      `meta-duplicate-unresolved` — и сервисному аккаунту тоже;
 *   5. подтверждение открывает переход, записывается вместе с автором, а флаг
 *      подтверждения после сохранения снят;
 *   6. регистр и лишние пробелы конфликт не снимают;
 *   7. правка заголовка у уже видимой записи в конфликт отклоняется;
 *   8. уникальные метатеги проходят в review без всякого подтверждения — запрет
 *      не шире правила.
 *
 * ЧТО ПРОВЕРЯЕТСЯ (Э5-02, сверка с DoD):
 *   9. перевод в review при похожем изображении отклонён признаком
 *      `visual-duplicate-unresolved`;
 *  10. после решения редактора переход проходит, а решение записано вместе с
 *      автором и отпечатком набора.
 *
 * Запуск: pnpm --filter @otkritka/cms exec payload run ./scripts/smoke-etap5-duplicates.ts
 *
 * Смоук убирает за собой всё созданное (карточки → изображения → подборки от
 * листа к корню) и не оставляет ни одной опубликованной записи: счётчик
 * `published` печатается до и после и обязан не измениться.
 */
import { getPayload } from 'payload';

import config from '../src/payload.config';
import type { Collection } from '../src/payload-types';
import { createPngFixture } from '../src/images/png-fixture';
import {
  describeMetaConflicts,
  readMetaConflictFacts,
} from '../src/collections/meta-duplicates';
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
 * однажды держится на ДРУГОМ отказе — например, по полноте полей, — и правило,
 * ради которого он писался, к тому моменту уже не работает.
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
        messageOf(error).slice(0, 180),
    );
    return;
  }
  record(name, false, 'операция прошла, хотя должна была быть отклонена');
}

async function expectOk<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  try {
    const result = await run();
    record(name, true);
    return result;
  } catch (error) {
    record(name, false, messageOf(error).slice(0, 220));
    return null;
  }
}

/**
 * Идентификатор связи из ответа API.
 *
 * Нужен потому, что живой ответ НЕ равен тому, что записал хук: на глубине по
 * умолчанию Payload подставляет в связь весь документ, а не id. Сравнение
 * «связь === id» на живом ядре поэтому ложно падает — замер 2026-08-29 при
 * первом прогоне этого смоука. Проверять надо идентификатор, каким бы образом
 * связь ни пришла.
 */
function relationId(value: unknown): number | string | null {
  if (typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && value !== null && 'id' in value) {
    const { id } = value as { id?: unknown };
    return typeof id === 'number' || typeof id === 'string' ? id : null;
  }
  return null;
}

/** Вводный текст подборки в том виде, в каком его хранит richText. */
function lexical(text: string): NonNullable<Collection['intro']> {
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

const STAMP = String(Date.now());

/** Спорный заголовок: он будет и у подборки, и у карточки. */
const SHARED_TITLE = `Смоук Э5: спорный заголовок ${STAMP}`;
const SHARED_DESCRIPTION = `Смоук Э5: спорное описание ${STAMP}`;

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
        email: `smouk-e5-${STAMP}@otkritka.test`,
        password: `smouk-${STAMP}`,
        role: 'ai-editor',
      },
    });
    created.users.push(service.id);
    const aiEditor = { ...service, collection: 'users' as const };

    /* --------------------------------------------------------------- */
    /* Подготовка: подборка в review со СПОРНЫМ заголовком              */
    /* --------------------------------------------------------------- */

    const group = await payload.create({
      collection: 'collections',
      data: {
        nodeKind: 'group',
        robots: 'noindex,follow',
        slug: `smouk-e5-${STAMP}`,
        status: 'draft',
        title: `Смоук Э5: группа ${STAMP}`,
      },
      overrideAccess: false,
      user: admin,
    });
    created.collections.push(group.id);

    const node = await payload.create({
      collection: 'collections',
      data: {
        intro: lexical('Вводный текст смоука Э5: подборка, с которой будет спорить карточка.'),
        metaDescription: `Смоук Э5: описание подборки ${STAMP}`,
        nodeKind: 'occasion',
        parent: group.id,
        related: [group.id],
        responsibleEditor: admin.id,
        robots: 'noindex,follow',
        slug: 'smouk-povod',
        status: 'draft',
        title: SHARED_TITLE,
      },
      overrideAccess: false,
      user: admin,
    });
    created.collections.push(node.id);

    const reviewedNode = await expectOk('подготовка: подборка уходит в review', () =>
      payload.update({
        collection: 'collections',
        id: node.id,
        data: { status: 'review' },
        overrideAccess: false,
        user: aiEditor,
      }),
    );
    const nodePath = typeof reviewedNode?.path === 'string' ? reviewedNode.path : '';
    record('у подборки собран путь, который увидит редактор в предупреждении', nodePath !== '', nodePath);

    const bytes = createPngFixture({ composition: 'rings', height: 700, width: 1100 });
    const image = await payload.create({
      collection: 'card-images',
      data: { title: `Смоук Э5: изображение ${STAMP}` },
      file: {
        data: bytes,
        mimetype: 'image/png',
        name: `smouk-e5-${STAMP}.png`,
        size: bytes.byteLength,
      },
      overrideAccess: false,
      user: aiEditor,
    });
    created.cardImages.push(image.id);
    if (typeof image.nameStem === 'string') {
      claimedStems.push(image.nameStem);
    }

    /* --------------------------------------------------------------- */
    /* 1. Конфликт из ДРУГОЙ коллекции виден в ответе на сохранение     */
    /* --------------------------------------------------------------- */

    const card = await payload.create({
      collection: 'cards',
      data: {
        robots: 'noindex,follow',
        slug: `smouk-e5-otkrytka-${STAMP}`,
        status: 'draft',
        // Регистр и двойной пробел — проверка нормализации: в выдаче это тот же
        // самый заголовок.
        title: SHARED_TITLE.toUpperCase().replace('Э5:', 'Э5:  '),
      },
      overrideAccess: false,
      user: aiEditor,
    });
    created.cards.push(card.id);

    const conflicts = card.metaConflict?.conflicts ?? [];
    record(
      'совпадение найдено в ДРУГОЙ коллекции и пришло в ответе на создание',
      conflicts.length === 1 && conflicts[0]?.documentCollection === 'collections',
      JSON.stringify(conflicts).slice(0, 200),
    );
    record(
      'в снимке стоит АДРЕС конфликтующей страницы (ТЗ §8.3.1 — «со ссылками»)',
      conflicts[0]?.path === nodePath,
      `path=${String(conflicts[0]?.path)} ожидался ${nodePath}`,
    );
    record(
      'регистр и лишние пробелы конфликт не снимают',
      card.titleKey === SHARED_TITLE.toLowerCase(),
      `titleKey=${String(card.titleKey)}`,
    );
    record('снимок помечен временем: он верен на момент сохранения', typeof card.metaConflict?.checkedAt === 'string');

    /* --------------------------------------------------------------- */
    /* 2. Зеркало-строка приходит на чтении, а не живёт в форме админки */
    /* --------------------------------------------------------------- */

    const readBack = await payload.findByID({ collection: 'cards', id: card.id });
    const summary = readBack.metaConflict?.summary;
    record(
      'состояние дублей приходит ПОЛЕМ, то есть в REST и GraphQL тоже',
      typeof summary === 'string' && summary !== '',
      String(summary).slice(0, 160),
    );
    record(
      'значение совпадает с единственной формулировкой проекта',
      summary === describeMetaConflicts(readMetaConflictFacts(readBack.metaConflict)),
    );

    /* --------------------------------------------------------------- */
    /* 3. Перевод в review без подтверждения отклонён                   */
    /* --------------------------------------------------------------- */

    await payload.update({
      collection: 'cards',
      id: card.id,
      data: {
        alt: 'Смоук Э5: описание изображения',
        caption: 'Смоук Э5: подпись',
        collections: [node.id],
        image: image.id,
        metaDescription: SHARED_DESCRIPTION,
      },
      overrideAccess: false,
      user: aiEditor,
    });

    await expectRule(
      'перевод в review при неразрешённом конфликте отклонён (сервисный аккаунт)',
      'meta-duplicate-unresolved',
      () =>
        payload.update({
          collection: 'cards',
          id: card.id,
          data: { status: 'review' },
          overrideAccess: false,
          user: aiEditor,
        }),
    );

    await expectRule(
      'тот же отказ получает и администратор: правило в слое, а не в форме',
      'meta-duplicate-unresolved',
      () =>
        payload.update({
          collection: 'cards',
          id: card.id,
          data: { status: 'review' },
          overrideAccess: false,
          user: admin,
        }),
    );

    const stillDraft = await payload.findByID({ collection: 'cards', id: card.id });
    record(
      'после отказов карточка осталась черновиком: половина операции не применилась',
      stillDraft.status === 'draft',
      `status=${stillDraft.status}`,
    );

    /* --------------------------------------------------------------- */
    /* 4. Подтверждение открывает переход и записывается с автором      */
    /* --------------------------------------------------------------- */

    const confirmed = await expectOk('подтверждение в том же сохранении открывает переход', () =>
      payload.update({
        collection: 'cards',
        id: card.id,
        data: { metaConflict: { confirm: true }, status: 'review' },
        overrideAccess: false,
        user: aiEditor,
      }),
    );
    record(
      'карточка в review, отпечаток и автор подтверждения записаны',
      confirmed?.status === 'review' &&
        typeof confirmed.metaConflict?.confirmedFor === 'string' &&
        confirmed.metaConflict.confirmedFor !== '' &&
        relationId(confirmed.metaConflict.confirmedBy) === aiEditor.id,
      `confirmedFor=${String(confirmed?.metaConflict?.confirmedFor)} confirmedBy=${String(
        relationId(confirmed?.metaConflict?.confirmedBy),
      )}`,
    );
    record(
      'флаг подтверждения одноразовый: после сохранения он снят',
      confirmed?.metaConflict?.confirm !== true,
      `confirm=${String(confirmed?.metaConflict?.confirm)}`,
    );

    /* --------------------------------------------------------------- */
    /* 5. Правка метатега у уже видимой записи в новый конфликт         */
    /* --------------------------------------------------------------- */

    const rivalCard = await payload.create({
      collection: 'cards',
      data: {
        alt: 'Смоук Э5: вторая открытка',
        caption: 'Смоук Э5: подпись второй',
        metaDescription: `Смоук Э5: описание второй карточки ${STAMP}`,
        robots: 'noindex,follow',
        slug: `smouk-e5-vtoraya-${STAMP}`,
        status: 'draft',
        title: `Смоук Э5: вторая открытка ${STAMP}`,
      },
      overrideAccess: false,
      user: aiEditor,
    });
    created.cards.push(rivalCard.id);

    await expectRule(
      'правка описания карточки в review в чужое значение отклонена',
      'meta-duplicate-unresolved',
      () =>
        payload.update({
          collection: 'cards',
          id: card.id,
          // Описание меняем на описание подборки: статус при этом не меняется,
          // но обе записи уже видны проверяющему.
          data: { metaDescription: `Смоук Э5: описание подборки ${STAMP}` },
          overrideAccess: false,
          user: admin,
        }),
    );

    /* --------------------------------------------------------------- */
    /* 6. Уникальные метатеги проходят без подтверждения                */
    /* --------------------------------------------------------------- */

    const secondImageBytes = createPngFixture({ composition: 'rings', height: 700, width: 1100 });
    const secondImage = await payload.create({
      collection: 'card-images',
      data: { title: `Смоук Э5: второе изображение ${STAMP}` },
      file: {
        data: secondImageBytes,
        mimetype: 'image/png',
        name: `smouk-e5-vtoroe-${STAMP}.png`,
        size: secondImageBytes.byteLength,
      },
      overrideAccess: false,
      user: aiEditor,
    });
    created.cardImages.push(secondImage.id);
    if (typeof secondImage.nameStem === 'string') {
      claimedStems.push(secondImage.nameStem);
    }
    record(
      'подготовка Э5-02: у двух изображений один перцептивный хеш',
      typeof secondImage.pHash === 'string' && secondImage.pHash === image.pHash,
      `${String(image.pHash)} / ${String(secondImage.pHash)}`,
    );

    await payload.update({
      collection: 'cards',
      id: rivalCard.id,
      data: { collections: [node.id], image: secondImage.id },
      overrideAccess: false,
      user: aiEditor,
    });

    const rivalRead = await payload.findByID({ collection: 'cards', id: rivalCard.id });
    record(
      'у записи с уникальными метатегами совпадений нет',
      (rivalRead.metaConflict?.total ?? 0) === 0,
      `total=${String(rivalRead.metaConflict?.total)}`,
    );

    /* --------------------------------------------------------------- */
    /* 7. Э5-02: визуальный дубль закрывает переход в review            */
    /* --------------------------------------------------------------- */

    await expectRule(
      'Э5-02: перевод в review при похожем изображении отклонён',
      'visual-duplicate-unresolved',
      () =>
        payload.update({
          collection: 'cards',
          id: rivalCard.id,
          data: { status: 'review' },
          overrideAccess: false,
          user: aiEditor,
        }),
    );

    const decided = await expectOk('Э5-02: после решения редактора переход проходит', () =>
      payload.update({
        collection: 'cards',
        id: rivalCard.id,
        data: {
          status: 'review',
          visualDuplicate: { confirm: true, decision: 'unique' },
        },
        overrideAccess: false,
        user: aiEditor,
      }),
    );
    record(
      'Э5-02: решение записано вместе с отпечатком набора и автором',
      decided?.status === 'review' &&
        decided.visualDuplicate?.decision === 'unique' &&
        typeof decided.visualDuplicate.decisionFor === 'string' &&
        decided.visualDuplicate.decisionFor !== '' &&
        relationId(decided.visualDuplicate.decidedBy) === aiEditor.id,
      `decision=${String(decided?.visualDuplicate?.decision)} decisionFor=${String(
        decided?.visualDuplicate?.decisionFor,
      )} decidedBy=${String(relationId(decided?.visualDuplicate?.decidedBy))}`,
    );
    record(
      'Э5-02: круг поиска нашёл карточку в review, а не только опубликованную',
      (decided?.visualDuplicate?.similar ?? []).some(
        (match) => relationId(match.card) === card.id,
      ),
      (decided?.visualDuplicate?.similar ?? [])
        .map((match) => `#${String(relationId(match.card))}:${String(match.distance)}`)
        .join(', '),
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
    for (const id of created.cardImages) {
      await payload.delete({ collection: 'card-images', id }).catch(() => undefined);
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
    for (const stem of claimedStems) {
      await payload
        .delete({ collection: 'image-name-claims', where: { stem: { equals: stem } } })
        .catch(() => undefined);
    }
    await payload
      .delete({ collection: 'redirects', where: { from: { like: 'smouk-e5' } } })
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
    console.log(`\nПосле уборки: ${JSON.stringify(after)} остатки=${JSON.stringify(leftovers)}`);
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
