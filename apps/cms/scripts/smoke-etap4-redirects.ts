/**
 * Смоук Э4-06 на ЖИВОЙ базе: источник редиректа не может быть маршрутом,
 * который сайт обслуживает сам.
 *
 * Зачем смоук, если есть юнит-тесты планировщика. Юнит-тест доказывает, что
 * правило верно; он не доказывает, что правило ПРИМЕНЯЕТСЯ на пути записи.
 * Между чистой функцией и сохранённой строкой лежат access control, валидация
 * поля и хук `beforeChange` — и именно там правило можно потерять целиком, не
 * уронив ни одного теста. Поэтому здесь всё идёт через Local API с
 * `overrideAccess: false` и явным пользователем: это тот же слой, по которому
 * работают REST и GraphQL, а не форма админки.
 *
 * Что проверяется:
 *   1. отказ по машинному признаку `reserved-from` на контейнере (`/otkrytki`),
 *      на занятом целиком маршруте (`/search`, `/o-proekte`), на пути ПОД
 *      занятым целиком (`/search/istoriya`), на пути админки и на сегменте
 *      пагинации. Признак, а не текст: зелёный негативный смоук на совпадении
 *      подстроки может держаться на отказе по правам;
 *   2. 410 с зарезервированного пути отклоняется так же, как 301 — иначе живую
 *      страницу можно было бы «удалить» правилом;
 *   3. запрет НЕ шире реестра: редирект с обычного адреса записи создаётся, в
 *      том числе НА зарезервированный путь (`/otkrytki`, `/o-proekte`) — цель
 *      редиректа обязана быть достижимой;
 *   4. `ai-editor` не создаёт редиректы вовсе (граница ролей, CLAUDE.md §9).
 *
 * Запуск: pnpm --filter @otkritka/cms exec payload run ./scripts/smoke-etap4-redirects.ts
 *
 * Смоук ничего не публикует: редиректы к статусной модели не относятся. Счётчик
 * опубликованных записей всё равно печатается до и после — он обязан не
 * измениться, и это дешёвая страховка от случайной публикации.
 */
import { getPayload } from 'payload';

import config from '../src/payload.config';
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

/** Ожидает отказ с конкретным машинным признаком. */
async function expectRule(name: string, rule: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const actual = ruleOf(error);
    record(
      name,
      actual === rule,
      `rule=${actual === '' ? '(нет)' : actual}; ${messageOf(error).slice(0, 220)}`,
    );
    return;
  }
  record(name, false, 'операция прошла, хотя должна была быть отклонена');
}

/** Ожидает отказ без разбора признака: у отказа по правам его нет. */
async function expectRejected(
  name: string,
  expectedFragment: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = messageOf(error);
    record(name, message.includes(expectedFragment), message.slice(0, 220));
    return;
  }
  record(name, false, 'операция прошла, хотя должна была быть отклонена');
}

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
    redirects: (await payload.count({ collection: 'redirects' })).totalDocs,
  };
  console.log(`До смоука: ${JSON.stringify(before)}`);

  const created = { redirects: [] as number[], users: [] as number[] };

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
        email: `smouk-ai-${String(Date.now())}@otkritka.test`,
        password: `smouk-${String(Date.now())}`,
        role: 'ai-editor',
      },
    });
    created.users.push(service.id);
    const aiEditor = { ...service, collection: 'users' as const };

    /* --------------------------------------------------------------- */
    /* 1. Отказ по зарезервированному источнику                         */
    /* --------------------------------------------------------------- */

    const reservedSources = [
      ['контейнер /otkrytki', '/otkrytki'],
      ['контейнер /podborki', '/podborki'],
      ['главная', '/'],
      ['занят целиком /search', '/search'],
      ['путь ПОД занятым целиком /search/istoriya', '/search/istoriya'],
      ['служебная страница /o-proekte', '/o-proekte'],
      ['файловый маршрут /sitemap.xml', '/sitemap.xml'],
      ['имя файлового маршрута без расширения /sitemap', '/sitemap'],
      ['путь админки (вычислен из PAYLOAD_ADMIN_PATH)', '/admin'],
      ['сегмент пагинации', '/podborki/prazdniki/8-marta/page/2'],
    ] as const;

    for (const [label, from] of reservedSources) {
      await expectRule(`301 с «${from}» отклонён (${label})`, 'reserved-from', () =>
        payload.create({
          collection: 'redirects',
          data: { code: '301', from, to: '/otkrytki/smouk-zamena' },
          overrideAccess: false,
          user: admin,
        }),
      );
    }

    await expectRule('410 с «/usloviya» отклонён так же, как 301', 'reserved-from', () =>
      payload.create({
        collection: 'redirects',
        data: { code: '410', from: '/usloviya' },
        overrideAccess: false,
        user: admin,
      }),
    );

    /* --------------------------------------------------------------- */
    /* 2. Запрет не шире реестра                                        */
    /* --------------------------------------------------------------- */

    const allowed = await payload.create({
      collection: 'redirects',
      data: {
        code: '301',
        comment: 'смоук Э4-06',
        from: '/otkrytki/smouk-staraya',
        to: '/otkrytki/smouk-novaya',
      },
      overrideAccess: false,
      user: admin,
    });
    created.redirects.push(allowed.id);
    record(
      'редирект с обычного адреса записи создаётся',
      allowed.from === '/otkrytki/smouk-staraya' && allowed.to === '/otkrytki/smouk-novaya',
      `from=${allowed.from} to=${String(allowed.to)}`,
    );

    const toReserved = await payload.create({
      collection: 'redirects',
      data: {
        code: '301',
        comment: 'смоук Э4-06',
        from: '/podborki/smouk-prazdnik/smouk-adresat',
        to: '/o-proekte',
      },
      overrideAccess: false,
      user: admin,
    });
    created.redirects.push(toReserved.id);
    record(
      'цель НА зарезервированном пути допустима: правило только про источник',
      toReserved.to === '/o-proekte',
      `to=${String(toReserved.to)}`,
    );

    const toContainer = await payload.create({
      collection: 'redirects',
      data: { code: '301', comment: 'смоук Э4-06', from: '/otkrytki/smouk-tretya', to: '/otkrytki' },
      overrideAccess: false,
      user: admin,
    });
    created.redirects.push(toContainer.id);
    record(
      'перенос на каталог /otkrytki допустим',
      toContainer.to === '/otkrytki',
      `to=${String(toContainer.to)}`,
    );

    /* --------------------------------------------------------------- */
    /* 3. Правка существующей записи проверяется тем же правилом        */
    /* --------------------------------------------------------------- */

    await expectRule('перевод существующего правила на «/kontakty» отклонён', 'reserved-from', () =>
      payload.update({
        collection: 'redirects',
        id: allowed.id,
        data: { from: '/kontakty' },
        overrideAccess: false,
        user: admin,
      }),
    );

    /* --------------------------------------------------------------- */
    /* 4. Граница ролей                                                 */
    /* --------------------------------------------------------------- */

    await expectRejected('ai-editor не создаёт редиректы вовсе', 'not allowed', () =>
      payload.create({
        collection: 'redirects',
        data: { code: '301', from: '/otkrytki/smouk-ai', to: '/otkrytki/smouk-novaya' },
        overrideAccess: false,
        user: aiEditor,
      }),
    );
  } finally {
    for (const id of created.redirects) {
      await payload.delete({ collection: 'redirects', id }).catch(() => undefined);
    }
    await payload
      .delete({ collection: 'redirects', where: { from: { like: 'smouk' } } })
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
      redirects: (await payload.count({ collection: 'redirects' })).totalDocs,
    };
    console.log(`\nПосле уборки: ${JSON.stringify(after)}`);
    record(
      'уборка вернула базу в исходное состояние',
      after.redirects === before.redirects &&
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
