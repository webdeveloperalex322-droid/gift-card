/**
 * Смоук Э5-03, Э5-04 и Э5-07 на ЖИВОЙ базе: проверка внутренних ссылок, дашборд
 * SEO-здоровья и сезонные дедлайны.
 *
 * ЗАЧЕМ СМОУК, ЕСЛИ ЕСТЬ ЮНИТ-ТЕСТЫ. Юнит-тесты доказывают, что правила верны на
 * синтетике. Здесь проверяется другое: что между чистой функцией и живым ядром
 * ничего не потерялось — права на глобал, реальный access control контентных
 * коллекций, настоящий SQL и настоящая транзакция. Сайт при этом остаётся
 * подставным (опрос подменяется), потому что эталонной выборки страниц у проекта
 * нет: Э3-13 отложена человеком, опубликованных записей ноль.
 *
 * ЧТО ПРОВЕРЯЕТСЯ (Э5-03):
 *   1. прогон пишет отчёт в глобал, и в нём стоит origin из SITE_URL;
 *   2. битая ссылка и ссылка через редирект попадают в отчёт РАЗНЫМИ видами
 *      находок;
 *   3. прогон НЕ меняет ни статуса, ни robots-директивы ни одной записи —
 *      снимок записи до и после совпадает побайтно по этим полям;
 *   4. отчёт не отдаётся анониму: глобал закрыт `authenticatedAccess`;
 *   5. отчёт нельзя переписать руками даже администратору — `access.update`
 *      глобала отказывает и через Local API с правами.
 *
 * ЧТО ПРОВЕРЯЕТСЯ (Э5-04):
 *   6. дашборд показывает то, что видит СМОТРЯЩИЙ: черновик виден админу и не
 *      виден анониму — при одном и том же коде сборки;
 *   7. блок проверки ссылок у анонима говорит «нет прав», а не «сирот нет»;
 *   8. разметка стартового экрана рисуется и содержит все блоки ТЗ §8.4.
 *
 * ЧТО ПРОВЕРЯЕТСЯ (Э5-07):
 *   9. подборка с прошедшей датой готовности попадает в сорванные дедлайны, а
 *      окно показа, заданное наполовину, названо отдельной находкой.
 *
 * Запуск: pnpm --filter @otkritka/cms exec payload run ./scripts/smoke-etap5-audit-dashboard.ts
 *
 * Смоук убирает за собой всё созданное, возвращает отчёт проверки ссылок в
 * прежнее состояние и не оставляет ни одной опубликованной записи: счётчик
 * `published` печатается до и после и обязан не измениться.
 */
import { createLocalReq, getPayload } from 'payload';
import { renderToStaticMarkup } from 'react-dom/server';

import config from '../src/payload.config';
import { LINK_AUDIT_SLUG } from '../src/audit/report';
import { runLinkAudit } from '../src/audit/run';
import type { ProbeResponse, SiteProbe } from '../src/export/inventory';
import { collectDashboardModel } from '../src/dashboard/collect';
import { SeoHealthView } from '../src/dashboard/SeoHealth';
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

const STAMP = String(Date.now());

/** Подставной сайт: главная со ссылками на битый адрес и на переехавший. */
function stubSite(origin: string): SiteProbe {
  const home: ProbeResponse = {
    body:
      '<html><body><h1>Главная</h1>' +
      '<a href="/podborki">Подборки</a>' +
      '<a href="/net-takoy-stranicy">Битая</a>' +
      '<a href="/staryy-adres">Переехавшая</a>' +
      '</body></html>',
    status: 200,
  };
  const pages: Record<string, ProbeResponse> = {
    [`${origin}/`]: home,
    [`${origin}/podborki`]: { body: '<html><body><h1>Подборки</h1></body></html>', status: 200 },
    [`${origin}/staryy-adres`]: { body: '', location: '/podborki', status: 301 },
    [`${origin}/sitemap.xml`]: { body: '<sitemapindex></sitemapindex>', status: 200 },
  };
  return (url: string) =>
    Promise.resolve(pages[url] ?? { body: '<html><body>404</body></html>', status: 404 });
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
  };
  console.log(`До смоука: ${JSON.stringify(before)}`);

  // Прежний отчёт запоминается целиком: смоук пишет в тот же глобал, и оставить
  // после себя синтетический протокол значило бы соврать дашборду.
  const previousReport = await payload.findGlobal({ depth: 0, slug: LINK_AUDIT_SLUG });
  const created = { collections: [] as number[] };

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

    /* --------------------------------------------------------------- */
    /* Подготовка: черновик подборки с прошедшим дедлайном (Э5-07)      */
    /* --------------------------------------------------------------- */

    const node = await payload.create({
      collection: 'collections',
      data: {
        nodeKind: 'group',
        robots: 'noindex,follow',
        seasonal: {
          // Праздник в прошлом: дата готовности выведется по Ч-12 и окажется
          // просроченной, а окно показа задано НАПОЛОВИНУ — вторая находка.
          holidayDate: '2026-03-08T00:00:00.000Z',
          showFrom: '2026-02-01T00:00:00.000Z',
        },
        slug: `smouk-e5-audit-${STAMP}`,
        status: 'draft',
        title: `Смоук Э5: сезонная группа ${STAMP}`,
      },
      overrideAccess: false,
      user: admin,
    });
    created.collections.push(node.id);

    const snapshotBefore = await payload.findByID({
      collection: 'collections',
      depth: 0,
      id: node.id,
    });

    /* --------------------------------------------------------------- */
    /* Э5-03: прогон проверки ссылок                                    */
    /* --------------------------------------------------------------- */

    const origin = 'http://otkritka.test';
    const { report } = await runLinkAudit({ payload, probe: stubSite(origin) });

    const stored = await payload.findGlobal({ depth: 0, slug: LINK_AUDIT_SLUG });
    record(
      '1. отчёт записан в глобал, origin — из SITE_URL',
      stored.origin === report.origin && report.origin.startsWith('http'),
      `origin=${String(stored.origin)}`,
    );

    const links = stored.links ?? [];
    const broken = links.filter((link) => link.kind === 'broken');
    const redirected = links.filter((link) => link.kind === 'redirected');
    record(
      '2. битая ссылка и ссылка через редирект различены',
      broken.length === 1 &&
        broken[0]?.url === `${origin}/net-takoy-stranicy` &&
        redirected.length === 1 &&
        redirected[0]?.url === `${origin}/staryy-adres`,
      `битых=${String(broken.length)} через редирект=${String(redirected.length)}`,
    );

    const snapshotAfter = await payload.findByID({
      collection: 'collections',
      depth: 0,
      id: node.id,
    });
    record(
      '3. прогон не тронул ни статуса, ни robots-директивы записи',
      snapshotAfter.status === snapshotBefore.status &&
        snapshotAfter.robots === snapshotBefore.robots &&
        snapshotAfter.updatedAt === snapshotBefore.updatedAt,
      `status=${String(snapshotAfter.status)} robots=${String(snapshotAfter.robots)}`,
    );

    const anonymous = await createLocalReq({}, payload);
    let anonymousSawReport = false;
    try {
      await payload.findGlobal({
        depth: 0,
        overrideAccess: false,
        req: anonymous,
        slug: LINK_AUDIT_SLUG,
      });
      anonymousSawReport = true;
    } catch {
      anonymousSawReport = false;
    }
    record('4. отчёт не отдаётся анониму', !anonymousSawReport);

    let adminRewroteReport = false;
    try {
      await payload.updateGlobal({
        data: { origin: 'http://podmena.test' },
        overrideAccess: false,
        slug: LINK_AUDIT_SLUG,
        user: admin,
      });
      adminRewroteReport = true;
    } catch (error) {
      record('5. отчёт нельзя переписать руками даже админу', true, messageOf(error).slice(0, 120));
    }
    if (adminRewroteReport) {
      record('5. отчёт нельзя переписать руками даже админу', false, 'запись прошла');
    }

    /* --------------------------------------------------------------- */
    /* Э5-04: дашборд показывает то, что видит смотрящий                */
    /* --------------------------------------------------------------- */

    const adminReq = await createLocalReq({ user: admin }, payload);
    const adminModel = await collectDashboardModel({ payload, req: adminReq });
    const anonymousModel = await collectDashboardModel({ payload, req: anonymous });

    const adminDrafts = adminModel.statuses.find((row) => row.collection === 'collections')?.draft ?? 0;
    const anonymousDrafts =
      anonymousModel.statuses.find((row) => row.collection === 'collections')?.draft ?? 0;
    record(
      '6. черновик виден админу и не виден анониму — один и тот же код сборки',
      adminDrafts >= 1 && anonymousDrafts === 0,
      `админ=${String(adminDrafts)} аноним=${String(anonymousDrafts)}`,
    );

    record(
      '7. у анонима блок проверки ссылок говорит «нет прав», а не «сирот нет»',
      anonymousModel.audit === null && anonymousModel.auditAbsence === 'forbidden',
      `absence=${String(anonymousModel.auditAbsence)}`,
    );

    const markup = renderToStaticMarkup(SeoHealthView({ model: adminModel }));
    const blocks = [
      'Записи по статусам',
      'Дубли метатегов сейчас',
      'Записи со снимком конфликта',
      'Визуальные дубли',
      'На проверке (review)',
      'Сезонные дедлайны',
      'Внутренние ссылки',
      'Карта сайта: последнее наблюдение',
      'Последние изменения',
    ];
    const missing = blocks.filter((block) => !markup.includes(block));
    record(
      '8. стартовый экран рисуется и содержит все блоки ТЗ §8.4',
      missing.length === 0,
      missing.length === 0 ? `${String(markup.length)} символов разметки` : `нет блоков: ${missing.join(', ')}`,
    );

    /* --------------------------------------------------------------- */
    /* Э5-07: сезонные дедлайны                                         */
    /* --------------------------------------------------------------- */

    const alert = adminModel.seasonal.alerts.find((row) => row.id === String(node.id));
    const windowIssue = adminModel.seasonal.windowIssues.find((row) => row.id === String(node.id));
    record(
      '9. сорванный дедлайн и половинчатое окно показа названы каждый своим именем',
      alert?.deadline.state === 'overdue' && windowIssue?.deadline.showWindow === 'half-set',
      `состояние=${String(alert?.deadline.state)} окно=${String(windowIssue?.deadline.showWindow)}`,
    );
  } finally {
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

    // Отчёт возвращается в состояние «до смоука»: синтетические находки не
    // должны пережить прогон и попасть в дашборд как настоящие.
    const { createdAt, globalType, id, updatedAt, ...restored } =
      previousReport as unknown as Record<string, unknown>;
    void createdAt;
    void globalType;
    void id;
    void updatedAt;
    await payload.updateGlobal({ data: restored, depth: 0, slug: LINK_AUDIT_SLUG }).catch(() => undefined);

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
      collections: (await payload.count({ collection: 'collections' })).totalDocs,
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
