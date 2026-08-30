/**
 * Смоук доборов по ревизии 2026-08-29 на ЖИВОЙ базе: очередь заданий и выгрузка.
 *
 * ЗАЧЕМ ИМЕННО ЖИВОЙ ПРОГОН. Обе находки этой волны — про разрыв между тем, что
 * заявлено, и тем, чем это держится. `jobs.access` выглядел закрывающим очередь
 * целиком, а закрывал три ручки; автогенерируемая коллекция `payload-jobs`
 * оставалась с дефолтом «любой аутентифицированный». Юнит-тест на предикате
 * такого не поймал бы: предикат был верен, его просто не спрашивали. Поэтому
 * здесь всё идёт через Local API с `overrideAccess: false` и явным пользователем
 * — тем же слоем, которым идут REST и GraphQL, а не формой админки.
 *
 * ЧТО ПРОВЕРЯЕТСЯ (коллекция заданий):
 *   1. `ai-editor` не читает задания;
 *   2. не создаёт;
 *   3. не правит;
 *   4. не удаляет;
 *   5. не ставит задание в очередь через `payload.jobs.queue`;
 *   6. не читает и не правит глобал статистики очереди (`payload-jobs-stats`) —
 *      в нём время последнего запуска расписания, и правка этого значения
 *      сдвигает или подавляет ежесуточный прогон;
 *   7. `admin` всё перечисленное может. Положительный контроль обязателен: без
 *      него зелёный смоук держался бы на любой поломке конфига.
 *
 * ЧТО ПРОВЕРЯЕТСЯ (выгрузка Э5-05):
 *   8. `ai-editor` не может заставить CMS опрашивать сайт: `?probe=1` от него
 *      НЕ порождает ни одного исходящего запроса, а колонки измерений остаются
 *      пустыми с явной пометкой почему;
 *   9. `admin` тем же запросом опрос запускает — значит отказ выше зависит от
 *      роли, а не от того, что опрос выключен вообще;
 *  10. отчётные строки `ai-editor` при этом остаются: закрыт опрос, а не отчёт.
 *
 * Исходящие запросы в проверках 8–10 ПОДМЕНЯЮТСЯ счётчиком вместо `fetch`:
 * измеряется сам факт «пошёл запрос или нет», и настоящий сайт для этого не
 * нужен. Заодно смоук не ходит по чужому стенду — приёмка SEO и смоуки `apps/cms`
 * не должны пересекаться на одной базе (правило записано в tests/seo/README.md).
 *
 * Запуск: pnpm --filter @otkritka/cms exec payload run ./scripts/smoke-etap5-jobs-access.ts
 *
 * Смоук убирает за собой всё созданное и не оставляет ни одной опубликованной
 * записи: счётчик `published` печатается до и после и обязан не измениться.
 */
import type { PayloadRequest } from 'payload';
import { getPayload } from 'payload';

import config from '../src/payload.config';
import { JOBS_COLLECTION_SLUG, JOB_STATS_GLOBAL_SLUG, LINK_AUDIT_QUEUE, LINK_AUDIT_TASK } from '../src/audit/task';
import { CSV_BOM } from '../src/export/csv';
import { SEO_INVENTORY_WARNINGS_HEADER, seoInventoryEndpoint } from '../src/export/endpoint';
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

/** Ожидает ОТКАЗ. Прошедшая операция — провал, а не «повезло». */
async function expectDenied(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    record(name, true, messageOf(error).slice(0, 100));
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

const STAMP = String(Date.now());

/** Slug черновика, по которому проверяется, что отчёт у сервисного аккаунта остаётся. */
const CARD_SLUG = `smouk-e5-jobs-${STAMP}`;

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

  const created = { cards: [] as number[], jobs: [] as (number | string)[], users: [] as number[] };
  const realFetch = globalThis.fetch;

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
        email: `smouk-e5-jobs-${STAMP}@otkritka.test`,
        password: `smouk-${STAMP}`,
        role: 'ai-editor',
      },
    });
    created.users.push(service.id);
    const aiEditor = { ...service, collection: 'users' as const };

    /* --------------------------------------------------------------- */
    /* Подготовка: одно задание в очереди, поставленное системой         */
    /* --------------------------------------------------------------- */

    // Черновик карточки — чтобы у выгрузки было что отдать. Создаёт его сам
    // сервисный аккаунт: строка его собственной записи и должна остаться в
    // отчёте, когда опрос сайта ему закрыт.
    const card = await payload.create({
      collection: 'cards',
      data: {
        metaDescription: `Смоук Э5-доборы: описание ${STAMP}`,
        robots: 'noindex,follow',
        slug: CARD_SLUG,
        status: 'draft',
        title: `Смоук Э5-доборы: открытка ${STAMP}`,
      },
      overrideAccess: false,
      user: aiEditor,
    });
    created.cards.push(card.id);

    // Ставится с правами системы (`overrideAccess` по умолчанию у Local API):
    // нужен объект, на котором проверяются чтение, правка и удаление.
    const job = await payload.jobs.queue({
      input: {},
      queue: LINK_AUDIT_QUEUE,
      task: LINK_AUDIT_TASK,
    });
    created.jobs.push(job.id);
    console.log(`Задание для проверки: id=${String(job.id)}`);

    /* --------------------------------------------------------------- */
    /* 1–4. Коллекция payload-jobs закрыта для сервисного аккаунта       */
    /* --------------------------------------------------------------- */

    await expectDenied('ai-editor не ЧИТАЕТ задания', () =>
      payload.find({
        collection: JOBS_COLLECTION_SLUG,
        overrideAccess: false,
        user: aiEditor,
      }),
    );

    await expectDenied('ai-editor не читает задание по id', () =>
      payload.findByID({
        collection: JOBS_COLLECTION_SLUG,
        id: job.id,
        overrideAccess: false,
        user: aiEditor,
      }),
    );

    await expectDenied('ai-editor не СОЗДАЁТ задание напрямую', () =>
      payload.create({
        collection: JOBS_COLLECTION_SLUG,
        data: { input: {}, taskSlug: LINK_AUDIT_TASK },
        overrideAccess: false,
        user: aiEditor,
      }),
    );

    await expectDenied('ai-editor не ПРАВИТ задание', () =>
      payload.update({
        collection: JOBS_COLLECTION_SLUG,
        id: job.id,
        data: { hasError: true },
        overrideAccess: false,
        user: aiEditor,
      }),
    );

    await expectDenied('ai-editor не УДАЛЯЕТ задание', () =>
      payload.delete({
        collection: JOBS_COLLECTION_SLUG,
        id: job.id,
        overrideAccess: false,
        user: aiEditor,
      }),
    );

    /* --------------------------------------------------------------- */
    /* 5. Ручка очереди                                                  */
    /* --------------------------------------------------------------- */

    await expectDenied('ai-editor не ставит задание в очередь', async () => {
      const queued = await payload.jobs.queue({
        input: {},
        overrideAccess: false,
        queue: LINK_AUDIT_QUEUE,
        req: { user: aiEditor } as unknown as PayloadRequest,
        task: LINK_AUDIT_TASK,
      });
      // Если очередь всё-таки пустила — убрать за собой, иначе смоук оставит
      // после себя задание, которого не должно было появиться.
      created.jobs.push(queued.id);
      return queued;
    });

    /* --------------------------------------------------------------- */
    /* 6. Глобал статистики очереди                                      */
    /* --------------------------------------------------------------- */

    await expectDenied('ai-editor не читает статистику очереди', () =>
      payload.findGlobal({
        depth: 0,
        overrideAccess: false,
        slug: JOB_STATS_GLOBAL_SLUG,
        user: aiEditor,
      }),
    );

    await expectDenied('ai-editor не правит статистику очереди', () =>
      payload.updateGlobal({
        data: { stats: { podmena: true } },
        overrideAccess: false,
        slug: JOB_STATS_GLOBAL_SLUG,
        user: aiEditor,
      }),
    );

    /* --------------------------------------------------------------- */
    /* 7. Положительный контроль: admin всё это может                    */
    /* --------------------------------------------------------------- */

    const seenByAdmin = await expectOk('admin читает задания', () =>
      payload.find({
        collection: JOBS_COLLECTION_SLUG,
        overrideAccess: false,
        user: admin,
      }),
    );
    record(
      'поставленное задание видно администратору',
      (seenByAdmin?.docs ?? []).some((doc) => String(doc.id) === String(job.id)),
      `найдено ${String(seenByAdmin?.docs.length ?? 0)}`,
    );

    await expectOk('admin ставит задание в очередь', async () => {
      const queued = await payload.jobs.queue({
        input: {},
        overrideAccess: false,
        queue: LINK_AUDIT_QUEUE,
        req: { user: admin } as unknown as PayloadRequest,
        task: LINK_AUDIT_TASK,
      });
      created.jobs.push(queued.id);
      return queued;
    });

    await expectOk('admin читает статистику очереди', () =>
      payload.findGlobal({
        depth: 0,
        overrideAccess: false,
        slug: JOB_STATS_GLOBAL_SLUG,
        user: admin,
      }),
    );

    /* --------------------------------------------------------------- */
    /* 8–10. Выгрузка: опрос сайта — рычаг, и он закрыт ролью            */
    /* --------------------------------------------------------------- */

    // URL абсолютный: в настоящем HTTP-запросе Payload кладёт сюда полный адрес.
    const reqFor = (user: unknown, url: string): PayloadRequest =>
      ({ context: {}, payload, url: `http://cms.invalid${url}`, user } as unknown as PayloadRequest);

    // Счётчик вместо сети: проверяется сам факт исходящего запроса, а настоящий
    // сайт для этого не нужен — и чужой стенд смоук не трогает.
    let outgoing = 0;
    globalThis.fetch = (input: unknown) => {
      outgoing += 1;
      void input;
      return Promise.resolve(
        new Response('<sitemapindex></sitemapindex>', {
          headers: { 'content-type': 'application/xml' },
          status: 200,
        }),
      );
    };

    const serviceResponse = await seoInventoryEndpoint.handler(
      reqFor(aiEditor, '/api/seo-inventory.csv?probe=1'),
    );
    const serviceOutgoing = outgoing;
    const serviceWarnings = decodeURIComponent(
      serviceResponse.headers.get(SEO_INVENTORY_WARNINGS_HEADER) ?? '',
    );
    // Байты, а не `text()`: декодирование UTF-8 по спецификации СНИМАЕТ ведущий
    // BOM, и проверка на строке ложно падала бы при верном ответе. Excel читает
    // именно байты, и без BOM кириллица в нём превращается в мусор.
    const serviceBody = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
      new Uint8Array(await serviceResponse.arrayBuffer()),
    );

    record(
      'ai-editor просит опрос — и НИ ОДНОГО запроса к сайту не уходит',
      serviceResponse.status === 200 && serviceOutgoing === 0,
      `status=${String(serviceResponse.status)} запросов=${String(serviceOutgoing)}`,
    );
    record(
      'колонки измерений пусты С ПОМЕТКОЙ, а не молча',
      serviceWarnings.includes('только роли admin'),
      serviceWarnings.slice(0, 160),
    );

    // Строка своего же черновика обязана быть в файле: закрыт ОПРОС, а не отчёт.
    // Без этой проверки «пустые колонки» и «пустой отчёт» выглядели бы одинаково.
    record(
      'отчётные строки при этом остаются: закрыт опрос, а не отчёт',
      serviceBody.startsWith(`${CSV_BOM}URL,`) && serviceBody.includes(`/otkrytki/${CARD_SLUG}`),
      `начало=${JSON.stringify(serviceBody.slice(0, 12))} своя строка=${String(
        serviceBody.includes(`/otkrytki/${CARD_SLUG}`),
      )}`,
    );
    const serviceLine =
      serviceBody.split('\r\n').find((line) => line.includes(`/otkrytki/${CARD_SLUG}`)) ?? '';
    record(
      'а колонки измерений в этой строке ПУСТЫ',
      // Предпоследняя ячейка («В sitemap») пуста, и трёхзначного кода ответа в
      // строке нет вовсе. Сравнение по номеру ячейки после split(',') было бы
      // ложным: `index,follow` обрамлено кавычками и содержит запятую внутри.
      serviceLine !== '' && /,,[^,]*$/.test(serviceLine) && !/,\d{3},/.test(serviceLine),
      serviceLine.slice(0, 200) === '' ? '(строки нет)' : serviceLine.slice(0, 200),
    );

    outgoing = 0;
    const adminResponse = await seoInventoryEndpoint.handler(
      reqFor(admin, '/api/seo-inventory.csv?probe=1'),
    );
    const adminOutgoing = outgoing;
    const adminWarnings = decodeURIComponent(
      adminResponse.headers.get(SEO_INVENTORY_WARNINGS_HEADER) ?? '',
    );

    record(
      'admin тем же запросом опрос ЗАПУСКАЕТ — отказ выше зависит от роли',
      adminResponse.status === 200 && adminOutgoing > 0,
      `status=${String(adminResponse.status)} запросов=${String(adminOutgoing)}`,
    );
    record(
      'у admin пометки про роль в предупреждениях нет',
      !adminWarnings.includes('только роли admin'),
      adminWarnings.slice(0, 160),
    );
  } finally {
    globalThis.fetch = realFetch;

    for (const id of created.jobs) {
      await payload.delete({ collection: JOBS_COLLECTION_SLUG, id }).catch(() => undefined);
    }
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
      cards: (await payload.count({ collection: 'cards' })).totalDocs,
      jobs: (await payload.count({ collection: JOBS_COLLECTION_SLUG })).totalDocs,
      users: (await payload.count({ collection: 'users' })).totalDocs,
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
