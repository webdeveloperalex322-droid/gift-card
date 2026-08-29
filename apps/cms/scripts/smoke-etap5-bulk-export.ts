/**
 * Смоук Э5-06 и Э5-05 на ЖИВОЙ базе: массовые операции и выгрузка CSV.
 *
 * ЗАЧЕМ СМОУК, ЕСЛИ ЕСТЬ ЮНИТ-ТЕСТЫ. Юнит-тесты доказывают, что правила верны,
 * но не то, что они СТОЯТ на пути живого запроса. Между чистой функцией
 * `assertBulkChangeAllowed` и строкой в базе лежат access control полей, слияние
 * входных данных с документом, порядок хуков и настоящая транзакция. Поэтому всё
 * здесь идёт через Local API с `overrideAccess: false` и явным пользователем —
 * тем же путём, которым идут REST и GraphQL, а не формой админки.
 *
 * ЧТО ПРОВЕРЯЕТСЯ (Э5-06, точка вето V11):
 *   1. `ai-editor` не публикует пакетно — отказ `bulk-requires-admin`;
 *   2. `admin` не публикует пакетом ПО ФИЛЬТРУ — отказ
 *      `bulk-requires-explicit-selection`. Это и есть машинная граница между
 *      «выборкой, которую человек составил» и «условием, развёрнутым кодом»;
 *   3. выборка сверх предела отклоняется (`bulk-too-large`);
 *   4. публикация и открытие в индекс одной операцией отклоняются
 *      (`index-not-separate`);
 *   5. `admin` публикует ЯВНУЮ выборку — и проверки полноты при этом НЕ
 *      обходятся: запись, не прошедшая review, отклоняется поимённо, остальные
 *      публикуются. Частичный успех с отчётом — поведение самого Payload
 *      (`update` по `where` возвращает `docs` и `errors`), а не надстройка;
 *   6. пакетное включение `index,follow` доступно `admin` отдельной операцией;
 *   7. массовая привязка ДОБАВЛЯЕТ подборку, не переставляя первую (основную,
 *      из которой строятся хлебные крошки), и доступна сервисному аккаунту;
 *   8. пустой список подборок пакетом — отказ `bulk-collections-clear`;
 *   9. привязка по фильтру — отказ `bulk-requires-explicit-selection`;
 *  10. вне пакета связь по-прежнему ЗАМЕНЯЕТСЯ: правило меняет трактовку ровно
 *      в пакете.
 *
 * ЧТО ПРОВЕРЯЕТСЯ (Э5-05):
 *  11. выгрузка читает записи через тот же access control: анонимный вызывающий
 *      не получает ни одной строки о `draft`/`review`;
 *  12. ручка отвечает анониму 403 и не собирает отчёт вовсе;
 *  13. колонки ответа сайта заполняются ИЗМЕРЕНИЕМ: подставной сайт отвечает 200
 *      с canonical и картой, и это видно в строке;
 *  14. недоступный сайт даёт ПУСТЫЕ ячейки и предупреждение, а не догадку.
 *
 * Запуск: pnpm --filter @otkritka/cms exec payload run ./scripts/smoke-etap5-bulk-export.ts
 *
 * Смоук убирает за собой всё созданное и не оставляет ни одной опубликованной
 * записи: счётчик `published` печатается до и после и обязан не измениться.
 */
import type { PayloadRequest } from 'payload';
import { getPayload } from 'payload';

import { buildAbsoluteUrl } from '@otkritka/shared';

import config from '../src/payload.config';
import type { Collection } from '../src/payload-types';
import { createPngFixture } from '../src/images/png-fixture';
import { MAX_BATCH_SELECTION } from '../src/collections/status-model';
import { collectInventoryRecords, seoInventoryEndpoint } from '../src/export/endpoint';
import { CSV_BOM } from '../src/export/csv';
import { type ProbeResponse, buildInventoryCsv } from '../src/export/inventory';
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

/**
 * Ожидает отказ с конкретным машинным признаком.
 *
 * Признак, а не подстрока: зелёный негативный смоук на совпадении текста
 * однажды держится на ДРУГОМ отказе, и правило, ради которого он писался, к
 * этому моменту уже не работает.
 */
async function expectRule(name: string, rule: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const actual = ruleOf(error);
    record(name, actual === rule, `rule=${actual === '' ? '(нет)' : actual}; ${messageOf(error).slice(0, 160)}`);
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

/** Идентификатор связи из ответа API: на глубине по умолчанию приходит документ. */
function relationIds(value: unknown): (number | string)[] {
  const items = Array.isArray(value) ? value.map((item: unknown) => item) : [];
  const ids: (number | string)[] = [];
  for (const item of items) {
    if (typeof item === 'number' || typeof item === 'string') {
      ids.push(item);
    } else if (typeof item === 'object' && item !== null && 'id' in item) {
      const { id } = item;
      if (typeof id === 'number' || typeof id === 'string') {
        ids.push(id);
      }
    }
  }
  return ids;
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
        email: `smouk-e5b-${STAMP}@otkritka.test`,
        password: `smouk-${STAMP}`,
        role: 'ai-editor',
      },
    });
    created.users.push(service.id);
    const aiEditor = { ...service, collection: 'users' as const };

    /* --------------------------------------------------------------- */
    /* Подготовка: две подборки и три карточки                          */
    /* --------------------------------------------------------------- */

    const group = await payload.create({
      collection: 'collections',
      data: {
        nodeKind: 'group',
        robots: 'noindex,follow',
        slug: `smouk-e5b-${STAMP}`,
        status: 'draft',
        title: `Смоук Э5б: группа ${STAMP}`,
      },
      overrideAccess: false,
      user: admin,
    });
    created.collections.push(group.id);

    const makeNode = async (slug: string, title: string): Promise<number> => {
      const node = await payload.create({
        collection: 'collections',
        data: {
          intro: lexical(`Вводный текст смоука Э5б для узла «${title}».`),
          metaDescription: `Смоук Э5б: описание узла ${slug} ${STAMP}`,
          nodeKind: 'occasion',
          parent: group.id,
          related: [group.id],
          responsibleEditor: admin.id,
          robots: 'noindex,follow',
          slug,
          status: 'draft',
          title,
        },
        overrideAccess: false,
        user: admin,
      });
      created.collections.push(node.id);
      return node.id;
    };

    const mainNode = await makeNode('smouk-osnovnoy', `Смоук Э5б: основная подборка ${STAMP}`);
    const extraNode = await makeNode('smouk-dopolnitelnyy', `Смоук Э5б: вторая подборка ${STAMP}`);

    const compositions = ['grid', 'stripes', 'rings'] as const;
    const makeCard = async (index: number, complete: boolean): Promise<number> => {
      const bytes = createPngFixture({
        composition: compositions[index] ?? 'grid',
        height: 700 + index * 30,
        width: 1100 + index * 40,
      });
      const image = await payload.create({
        collection: 'card-images',
        data: { title: `Смоук Э5б: изображение ${String(index)} ${STAMP}` },
        file: {
          data: bytes,
          mimetype: 'image/png',
          name: `smouk-e5b-${String(index)}-${STAMP}.png`,
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
          alt: `Смоук Э5б: описание изображения ${String(index)}`,
          // Подпись есть только у полных карточек: без неё запись не проходит
          // валидацию полноты и не может уйти в review — именно этим ниже
          // проверяется, что пакет проверки НЕ обходит.
          ...(complete ? { caption: `Смоук Э5б: подпись ${String(index)} ${STAMP}` } : {}),
          collections: [mainNode],
          image: image.id,
          metaDescription: `Смоук Э5б: описание карточки ${String(index)} ${STAMP}`,
          robots: 'noindex,follow',
          slug: `smouk-e5b-otkrytka-${String(index)}-${STAMP}`,
          status: 'draft',
          title: `Смоук Э5б: открытка ${String(index)} ${STAMP}`,
        },
        overrideAccess: false,
        user: aiEditor,
      });
      created.cards.push(card.id);
      return card.id;
    };

    const cardA = await makeCard(0, true);
    const cardB = await makeCard(1, true);
    const cardC = await makeCard(2, false);

    /* --------------------------------------------------------------- */
    /* 1. Пакетная смена draft → review по ЯВНОЙ выборке (ТЗ §8.5)      */
    /* --------------------------------------------------------------- */

    const toReview = await expectOk('ai-editor переводит выбранные карточки в review одной операцией', () =>
      payload.update({
        collection: 'cards',
        data: { status: 'review', visualDuplicate: { confirm: true, decision: 'unique' } },
        overrideAccess: false,
        user: aiEditor,
        where: { id: { in: [cardA, cardB] } },
      }),
    );
    record(
      'обе выбранные карточки в review',
      (toReview?.docs ?? []).every((doc) => doc.status === 'review') &&
        (toReview?.docs ?? []).length === 2,
      `docs=${String(toReview?.docs.length)} errors=${JSON.stringify(toReview?.errors)}`,
    );

    await expectRule(
      'пакетная смена статуса ПО ФИЛЬТРУ отклоняется даже у admin',
      'bulk-requires-explicit-selection',
      () =>
        payload.update({
          collection: 'cards',
          data: { status: 'review' },
          overrideAccess: false,
          user: admin,
          where: { status: { equals: 'draft' } },
        }),
    );

    /* --------------------------------------------------------------- */
    /* 2. Публикация пакетом: только admin, только явная выборка         */
    /* --------------------------------------------------------------- */

    await expectRule('ai-editor не публикует пакетно', 'bulk-requires-admin', () =>
      payload.update({
        collection: 'cards',
        data: { status: 'published' },
        overrideAccess: false,
        user: aiEditor,
        where: { id: { in: [cardA, cardB] } },
      }),
    );

    await expectRule(
      'массовая публикация по фильтру запрещена: это не выборка человека',
      'bulk-requires-explicit-selection',
      () =>
        payload.update({
          collection: 'cards',
          data: { status: 'published' },
          overrideAccess: false,
          user: admin,
          where: { status: { equals: 'review' } },
        }),
    );

    await expectRule('выборка сверх предела — тот же фильтр, только списком', 'bulk-too-large', () =>
      payload.update({
        collection: 'cards',
        data: { status: 'published' },
        overrideAccess: false,
        user: admin,
        where: {
          id: { in: Array.from({ length: MAX_BATCH_SELECTION + 1 }, (_, index) => index + 1) },
        },
      }),
    );

    await expectRule(
      'публикация и открытие в индекс одной операцией отклоняются',
      'index-not-separate',
      () =>
        payload.update({
          collection: 'cards',
          data: { robots: 'index,follow', status: 'published' },
          overrideAccess: false,
          user: admin,
          where: { id: { in: [cardA] } },
        }),
    );

    const published = await expectOk('admin публикует ЯВНУЮ выборку одной операцией (Ч-07)', () =>
      payload.update({
        collection: 'cards',
        data: { status: 'published' },
        overrideAccess: false,
        user: admin,
        where: { id: { in: [cardA, cardB, cardC] } },
      }),
    );
    record(
      'проверки полноты пакетом НЕ обходятся: незавершённая карточка отклонена поимённо',
      (published?.docs ?? []).length === 2 &&
        (published?.errors ?? []).length === 1 &&
        String(published?.errors[0]?.id) === String(cardC),
      `docs=${String(published?.docs.length)} errors=${JSON.stringify(published?.errors)}`,
    );
    const stillDraft = await payload.findByID({ collection: 'cards', id: cardC });
    record('отклонённая карточка осталась черновиком', stillDraft.status === 'draft', String(stillDraft.status));

    const indexed = await expectOk('открытие в индекс — отдельный пакет, доступный admin', () =>
      payload.update({
        collection: 'cards',
        data: { robots: 'index,follow' },
        overrideAccess: false,
        user: admin,
        where: { id: { in: [cardA] } },
      }),
    );
    record(
      'директива применилась именно к выбранной записи',
      indexed?.docs[0]?.robots === 'index,follow' && (indexed.docs.length ?? 0) === 1,
      `robots=${String(indexed?.docs[0]?.robots)}`,
    );
    await payload.update({
      collection: 'cards',
      id: cardA,
      data: { robots: 'noindex,follow' },
      overrideAccess: false,
      user: admin,
    });

    /* --------------------------------------------------------------- */
    /* 3. Массовая привязка карточек к подборке (ТЗ §8.5)                */
    /* --------------------------------------------------------------- */

    await expectRule(
      'привязка по фильтру отклоняется: наполнение подборки решает её судьбу в индексе',
      'bulk-requires-explicit-selection',
      () =>
        payload.update({
          collection: 'cards',
          data: { collections: [extraNode] },
          overrideAccess: false,
          user: aiEditor,
          where: { status: { equals: 'published' } },
        }),
    );

    await expectRule('пустой список пакетом — это отвязка, и она запрещена', 'bulk-collections-clear', () =>
      payload.update({
        collection: 'cards',
        data: { collections: [] },
        overrideAccess: false,
        user: admin,
        where: { id: { in: [cardA] } },
      }),
    );

    const attached = await expectOk('ai-editor привязывает выбранные карточки ко второй подборке', () =>
      payload.update({
        collection: 'cards',
        data: { collections: [extraNode] },
        overrideAccess: false,
        user: aiEditor,
        where: { id: { in: [cardA, cardB] } },
      }),
    );
    const attachedIds = relationIds(attached?.docs[0]?.collections);
    record(
      'подборка ДОБАВЛЕНА, а основная (первая, из неё крошки) осталась первой',
      attachedIds.length === 2 &&
        String(attachedIds[0]) === String(mainNode) &&
        String(attachedIds[1]) === String(extraNode),
      `collections=${JSON.stringify(attachedIds)} ожидались [${String(mainNode)}, ${String(extraNode)}]`,
    );

    const repeated = await expectOk('повторная привязка той же подборки не дублирует связь', () =>
      payload.update({
        collection: 'cards',
        data: { collections: [extraNode] },
        overrideAccess: false,
        user: aiEditor,
        where: { id: { in: [cardA] } },
      }),
    );
    record(
      'связей по-прежнему две',
      relationIds(repeated?.docs[0]?.collections).length === 2,
      JSON.stringify(relationIds(repeated?.docs[0]?.collections)),
    );

    const singleEdit = await expectOk('вне пакета связь ЗАМЕНЯЕТСЯ: редактор видит её целиком', () =>
      payload.update({
        collection: 'cards',
        id: cardB,
        data: { collections: [extraNode] },
        overrideAccess: false,
        user: admin,
      }),
    );
    record(
      'у поштучно правленной карточки осталась одна подборка',
      relationIds(singleEdit?.collections).length === 1 &&
        String(relationIds(singleEdit?.collections)[0]) === String(extraNode),
      JSON.stringify(relationIds(singleEdit?.collections)),
    );

    /* --------------------------------------------------------------- */
    /* 4. Выгрузка CSV (Э5-05)                                          */
    /* --------------------------------------------------------------- */

    // URL абсолютный: `createLocalReq` строит из него объект URL, и
    // относительный путь дал бы шумную ошибку в журнале. В настоящем HTTP-запросе
    // Payload кладёт сюда полный адрес.
    const reqFor = (user: unknown, url: string): PayloadRequest =>
      ({ context: {}, payload, url: `http://cms.invalid${url}`, user } as unknown as PayloadRequest);

    const adminRecords = await collectInventoryRecords(reqFor(admin, '/api/seo-inventory.csv'));
    const cardSlug = `smouk-e5b-otkrytka-2-${STAMP}`;
    record(
      'выгрузка администратора видит черновик',
      adminRecords.some((row) => row.path === `/otkrytki/${cardSlug}`),
      `строк=${String(adminRecords.length)}`,
    );

    const anonymousRecords = await collectInventoryRecords(reqFor(null, '/api/seo-inventory.csv'));
    record(
      'выгрузка не обходит права: анониму черновиков не видно',
      !anonymousRecords.some((row) => row.path === `/otkrytki/${cardSlug}`) &&
        anonymousRecords.some((row) => row.path === `/otkrytki/smouk-e5b-otkrytka-0-${STAMP}`),
      `строк=${String(anonymousRecords.length)}`,
    );

    const anonymousResponse = await seoInventoryEndpoint.handler(
      reqFor(null, '/api/seo-inventory.csv?probe=0'),
    );
    record(
      'ручка отвечает анониму 403 и отчёта не собирает',
      anonymousResponse.status === 403,
      `status=${String(anonymousResponse.status)}`,
    );

    const adminResponse = await seoInventoryEndpoint.handler(
      reqFor(admin, '/api/seo-inventory.csv?probe=0'),
    );
    // Байты, а не `text()`: декодирование UTF-8 по спецификации СНИМАЕТ ведущий
    // BOM, поэтому проверка на строке ложно падала бы при верном ответе. Excel
    // же читает именно байты, и без BOM кириллица в нём превращается в мусор.
    const bodyBytes = new Uint8Array(await adminResponse.arrayBuffer());
    const bom = bodyBytes[0] === 0xef && bodyBytes[1] === 0xbb && bodyBytes[2] === 0xbf;
    // `ignoreBOM: true` — иначе декодер тоже снимет BOM, и строковая проверка
    // проверяла бы не тот файл, который уходит по сети.
    const body = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bodyBytes);
    record(
      'ручка отдаёт CSV с BOM, заголовком вложения и noindex',
      adminResponse.status === 200 &&
        adminResponse.headers.get('content-type') === 'text/csv; charset=utf-8' &&
        adminResponse.headers.get('content-disposition')?.includes('attachment') === true &&
        adminResponse.headers.get('x-robots-tag') === 'noindex' &&
        bom &&
        body.startsWith(`${CSV_BOM}URL,`),
      `status=${String(adminResponse.status)} type=${String(adminResponse.headers.get('content-type'))} ` +
        `robots=${String(adminResponse.headers.get('x-robots-tag'))} ` +
        `disposition=${String(adminResponse.headers.get('content-disposition'))} ` +
        `bom=${String(bom)} начало=${JSON.stringify(body.slice(0, 12))}`,
    );

    // Подставной сайт: колонки ответа обязаны заполняться ИЗМЕРЕНИЕМ, а не
    // выводом из полей записи. Настоящий сайт в смоуке не поднимается —
    // проверяется именно то, что измеренное значение доходит до ячейки.
    const cardUrl = buildAbsoluteUrl(`/otkrytki/smouk-e5b-otkrytka-0-${STAMP}`);
    const origin = new URL(cardUrl).origin;
    const fakeSite = new Map<string, ProbeResponse>([
      [
        `${origin}/sitemap.xml`,
        {
          body: `<sitemapindex><sitemap><loc>${origin}/sitemap-cards-1.xml</loc></sitemap></sitemapindex>`,
          status: 200,
        },
      ],
      [
        `${origin}/sitemap-cards-1.xml`,
        { body: `<urlset><url><loc>${cardUrl}</loc></url></urlset>`, status: 200 },
      ],
      [
        cardUrl,
        { body: `<html><head><link rel="canonical" href="${cardUrl}"></head></html>`, status: 200 },
      ],
    ]);
    const measured = await buildInventoryCsv({
      probe: (url: string) => {
        const response = fakeSite.get(url);
        return response === undefined
          ? Promise.resolve({ body: 'Не найдено', status: 404 })
          : Promise.resolve(response);
      },
      records: adminRecords,
    });
    const measuredRow = measured.csv.split('\r\n').find((line) => line.startsWith(cardUrl));
    record(
      'колонки ответа сайта заполнены измерением: 200, canonical и «да» в карте',
      measuredRow !== undefined &&
        measuredRow.includes(',200,') &&
        measuredRow.includes(cardUrl) &&
        measuredRow.endsWith(',да,') === false &&
        measuredRow.split(',').includes('да'),
      String(measuredRow).slice(0, 220),
    );

    const unreachable = await buildInventoryCsv({
      probe: () => Promise.reject(new Error('ECONNREFUSED')),
      records: adminRecords.slice(0, 1),
    });
    record(
      'недоступный сайт даёт предупреждение, а не правдоподобную догадку',
      unreachable.warnings.some((warning) => warning.includes('карта сайта не прочитана')),
      unreachable.warnings.join(' | ').slice(0, 200),
    );

    /* --------------------------------------------------------------- */
    /* 5. Снятие с публикации — поштучно, с решением о судьбе URL        */
    /* --------------------------------------------------------------- */

    await expectRule(
      'снять пакетом с общим решением о судьбе URL нельзя: это массовый редирект',
      'bulk-withdrawal-forbidden',
      () =>
        payload.update({
          collection: 'cards',
          data: { status: 'draft', withdrawal: { mode: '301', redirectTo: '/' } },
          overrideAccess: false,
          user: admin,
          where: { id: { in: [cardA, cardB] } },
        }),
    );

    for (const id of [cardA, cardB]) {
      await expectOk(`карточка ${String(id)} снимается с публикации поштучно`, () =>
        payload.update({
          collection: 'cards',
          id,
          data: { status: 'draft', withdrawal: { mode: '410', redirectTo: null } },
          overrideAccess: false,
          user: admin,
        }),
      );
    }
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
      .delete({ collection: 'redirects', where: { from: { like: 'smouk-e5b' } } })
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
