/**
 * Ежесуточное расписание проверки внутренних ссылок (задача Э5-03, ТЗ §8.3.4).
 *
 * ═══ ЧЕМ ЭТО ЗАПУСКАЕТСЯ НА САМОМ ДЕЛЕ ═══
 *
 * Планировщик у Payload 3.88 штатный, и он здесь используется, а не переписан:
 * задача объявлена как task очереди заданий с полем `schedule` (сверено по
 * `payload/dist/queues/config/types/*`, а не по памяти). Само по себе
 * объявление ничего не запускает — оно лишь описывает, когда работу СЛЕДУЕТ
 * поставить в очередь. Крутить расписание может одно из двух:
 *
 *   1. **внешний планировщик ОС** (cron/systemd/Планировщик заданий), который
 *      раз в сутки зовёт `payload jobs:run --handle-schedules --queue
 *      seo-audit`. Выбрано как основной способ, и вот почему: тот же конфиг
 *      Payload поднимается ВТОРЫМ процессом — рендером `apps/web` через Local
 *      API (`apps/web/src/data/payload-client.ts`). Включить `jobs.autoRun` в
 *      конфиге значило бы завести крон и там: сайт обходил бы сам себя из
 *      процесса, который в этот момент обязан отдавать страницы, а два процесса
 *      делили бы одну очередь;
 *   2. `jobs.autoRun` внутри процесса CMS — законная альтернатива, но включать
 *      её можно только там, где точно известно, что процесс один. Это решение
 *      развёртывания (этап 7), а не свойство кода, поэтому в конфиге его нет.
 *
 * Отдельно есть команда для прогона «прямо сейчас», без очереди и расписания:
 * `pnpm --filter @otkritka/cms exec payload run ./scripts/run-link-audit.ts`.
 * Она нужна и человеку («проверь сейчас»), и смоуку.
 *
 * Честно про состояние: пока внешний планировщик не настроен (этап 7), задача
 * ЕЖЕСУТОЧНО НЕ ВЫПОЛНЯЕТСЯ. Расписание объявлено, механизм готов и проверяем
 * командой — но фоновая задача, которая на самом деле не запускается, хуже
 * отсутствующей, поэтому это сказано здесь и в отчёте, а не подразумевается.
 *
 * ═══ ПРАВА: ТРИ ЗАМКА, А НЕ ОДИН ═══
 *
 * Очередь заданий — служебная механика, а не контент, и у `ai-editor` не должно
 * появляться новых рычагов из-за того, что в проекте завелась очередь. Одного
 * `jobs.access` для этого НЕ ХВАТАЕТ, и это проверено по исходникам ядра
 * (payload 3.88), а не выведено из документации:
 *
 *   1. {@link linkAuditJobsAccess} — `jobs.access`. Читается ровно в двух
 *      местах: `access.run` в `queues/endpoints/run.js` и
 *      `queues/operations/handleSchedules`, `access.queue` в
 *      `queues/localAPI.js`. То есть закрывает ручки «запустить», «поставить в
 *      очередь» и «отменить» — и больше ничего;
 *   2. {@link linkAuditJobsCollectionOverrides} — `jobs.jobsCollectionOverrides`.
 *      Payload автогенерирует коллекцию `payload-jobs`
 *      (`queues/config/collection.js`) и добавляет её в конфиг наравне с
 *      остальными, то есть с полноценными REST и GraphQL. Своего `access` у неё
 *      нет, поэтому `addDefaultsToCollectionConfig`
 *      (`collections/config/defaults.js`) ставит `defaultAccess`, а это
 *      `Boolean(user)`: сервисный аккаунт создавал, читал, правил и удалял бы
 *      задания напрямую, мимо `jobs.access`. Находка ревизии от 2026-08-29;
 *   3. {@link sealJobsInternals} — глобал `payload-jobs-stats`. Он появляется
 *      сам, как только у задачи есть `schedule` (`config/sanitize.js` ставит
 *      `jobs.scheduling` и добавляет `getJobStatsGlobal`), и точки для его
 *      настройки в конфиге нет вовсе. Глобал без `access` получает
 *      `defaultAccess` на чтение И на запись (`globals/config/sanitize.js`), а
 *      в нём лежит время последнего запуска расписания: правка этого значения
 *      сдвигает или подавляет ежесуточный прогон. Поэтому конфиг
 *      «допечатывается» после `buildConfig`.
 *
 * Ни один из трёх замков не мешает самому исполнителю заданий: очередь работает
 * через `payload.db.*` напрямую (`runHooks` выключен по умолчанию), а ветки с
 * `payload.create`/`payload.delete` включаются только при `jobs.runHooks` или
 * `jobs.depth` и идут с `overrideAccess`. Проверено там же, в
 * `queues/utilities/updateJob.js` и `queues/operations/runJobs/index.js`.
 */
import type {
  CollectionConfig,
  JobsConfig,
  SanitizedConfig,
  SanitizedGlobalConfig,
  TaskConfig,
} from 'payload';

import { isAdmin } from '../access/roles';
import { runLinkAudit } from './run';

/** Очередь, в которой живёт проверка. Своя — чтобы её можно было гонять отдельно. */
export const LINK_AUDIT_QUEUE = 'seo-audit';

/** Слаг задачи. Он же имя в очереди и в CLI. */
export const LINK_AUDIT_TASK = 'seo-link-audit';

/**
 * Расписание: ежесуточно в 03:00 UTC.
 *
 * ПРОВЕНАНС: час выбран агентом (норма говорит только «ежесуточно»). Ночь —
 * потому что обход делает сотни запросов к собственному сайту; UTC — потому что
 * даты и дедлайны в проекте считаются в UTC, и час, зависящий от пояса
 * процесса, означал бы разное время прогона на разработке и на production.
 *
 * Формат — шесть полей (секунды первыми), как в типах Payload.
 */
export const LINK_AUDIT_CRON = '0 0 3 * * *';

/** Права на ручки очереди: только `admin`, включая запуск и отмену. */
export const linkAuditJobsAccess: NonNullable<JobsConfig['access']> = {
  cancel: ({ req }) => isAdmin(req.user),
  queue: ({ req }) => isAdmin(req.user),
  run: ({ req }) => isAdmin(req.user),
};

/** Слаг автогенерируемой коллекции заданий (payload 3.88, `queues/config/collection.js`). */
export const JOBS_COLLECTION_SLUG = 'payload-jobs';

/** Слаг глобала статистики очереди (payload 3.88, `queues/config/global.js`). */
export const JOB_STATS_GLOBAL_SLUG = 'payload-jobs-stats';

/**
 * Закрывает САМУ коллекцию заданий: все четыре глагола — только `admin`.
 *
 * Права проверяются по роли, а не по «происхождению» запроса: `payload-jobs`
 * отдаётся через REST и GraphQL как любая другая коллекция, поэтому правило,
 * закрывающее только ручку `run`, оставляло бы дверь `POST /api/payload-jobs`
 * открытой. Хуков здесь НЕ добавляется намеренно — при выключенном
 * `jobs.runHooks` ядро их не выполняет и предупреждает об этом в консоль.
 */
export const linkAuditJobsCollectionOverrides = ({
  defaultJobsCollection,
}: {
  defaultJobsCollection: CollectionConfig;
}): CollectionConfig => ({
  ...defaultJobsCollection,
  access: {
    ...defaultJobsCollection.access,
    create: ({ req }) => isAdmin(req.user),
    delete: ({ req }) => isAdmin(req.user),
    read: ({ req }) => isAdmin(req.user),
    update: ({ req }) => isAdmin(req.user),
  },
});

/**
 * Досуживает права служебных объектов очереди, у которых нет точки настройки в
 * конфиге, — сегодня это глобал `payload-jobs-stats`.
 *
 * Работает ПОСЛЕ `buildConfig`, потому что раньше объекта не существует: его
 * добавляет сама санитизация, увидев расписание у задачи. Замена делается копией,
 * а не правкой на месте: конфиг после этого уходит в Payload, и мутировать чужую
 * структуру ради одного поля — способ однажды поймать разницу между тем, что
 * прочитал `payload`, и тем, что прочитал импортёр конфига (`apps/web`).
 *
 * Значение глобала пишет и читает само ядро через `payload.db.*`
 * (`handleSchedules`), поэтому сужение прав расписание не ломает.
 */
export async function sealJobsInternals(config: Promise<SanitizedConfig>): Promise<SanitizedConfig> {
  const sanitized = await config;
  const globals: SanitizedGlobalConfig[] = sanitized.globals.map((global) =>
    global.slug === JOB_STATS_GLOBAL_SLUG
      ? {
          ...global,
          access: {
            ...global.access,
            read: ({ req }) => isAdmin(req.user),
            update: ({ req }) => isAdmin(req.user),
          },
        }
      : global,
  );
  return { ...sanitized, globals };
}

/**
 * Задача очереди. Вся работа — в `runLinkAudit`: здесь только объявление.
 *
 * Ошибка прогона НЕ гасится: задание падает и остаётся видимым в очереди. Тихо
 * записанный пустой отчёт был бы хуже отсутствующего — дашборд показал бы
 * «сирот нет» там, где проверка не состоялась.
 */
export const linkAuditTask: TaskConfig<{ input: object; output: object }> = {
  slug: LINK_AUDIT_TASK,
  handler: async ({ req }) => {
    const result = await runLinkAudit({ payload: req.payload });
    const { counts, reliable } = result.report;
    req.payload.logger.info(
      `[seo-link-audit] запросов ${String(result.report.crawl.requested)}, ` +
        `записей ${String(counts.publishedRecords)}, сирот ${String(counts.orphans)}, ` +
        `битых ссылок ${String(counts.broken)}, надёжность ${reliable ? 'да' : 'нет'}`,
    );
    return { output: {} };
  },
  label: 'Проверка внутренних ссылок',
  schedule: [{ cron: LINK_AUDIT_CRON, queue: LINK_AUDIT_QUEUE }],
};
