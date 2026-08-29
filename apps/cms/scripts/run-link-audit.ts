/**
 * Прогон проверки внутренних ссылок «прямо сейчас» (задача Э5-03, ТЗ §8.3.4).
 *
 * Запуск:
 *   pnpm --filter @otkritka/cms run audit:links
 *   (то же самое: payload run ./scripts/run-link-audit.ts)
 *
 * ЗАЧЕМ КОМАНДА, ЕСЛИ ЕСТЬ РАСПИСАНИЕ. Расписание ставит задание в очередь раз
 * в сутки (`src/audit/task.ts`), а человеку и смоуку нужен прогон по требованию:
 * «поправил перелинковку — покажи, что стало». Отдельной HTTP-ручки для этого
 * сознательно НЕ заведено: новая точка входа — это новая поверхность, которую
 * пришлось бы защищать, а команда доступна ровно тому, у кого есть доступ к
 * серверу.
 *
 * Куда ходит обход — только на origin из `SITE_URL`. Ни аргумента командной
 * строки, ни второй переменной окружения: адрес обхода не выбирается тем, кто
 * запускает.
 *
 * Ничего не публикует, не снимает с публикации и не меняет robots-директивы —
 * ни при каких находках. Единственная запись — отчёт в глобале.
 */
import { getPayload } from 'payload';

import config from '../src/payload.config';
import { runLinkAudit } from '../src/audit/run';
import { finishSmoke } from '../src/scripts/smoke-exit';

const payload = await getPayload({ config });

const started = Date.now();
const { report } = await runLinkAudit({ payload });
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log(`Обойден origin: ${report.origin}`);
console.log(`Запросов к сайту: ${String(report.crawl.requested)} за ${seconds} с`);
console.log(`Опубликованных записей проверено: ${String(report.counts.publishedRecords)}`);
console.log(`Сирот: ${String(report.counts.orphans)}`);
console.log(`Битых ссылок: ${String(report.counts.broken)}`);
console.log(`Ссылок через редирект: ${String(report.counts.redirected)}`);
console.log(`Записей с адресом не 200: ${String(report.counts.unhealthy)}`);
console.log(
  report.reliable
    ? 'Находки о достижимости надёжны: обход дошёл до конца.'
    : 'ВНИМАНИЕ: находки о достижимости НЕНАДЁЖНЫ — обход не состоялся или оборван пределом.',
);
for (const warning of report.warnings) {
  console.log(`  ! ${warning.text}`);
}

// Код выхода — про то, состоялось ли ИЗМЕРЕНИЕ, а не про то, понравились ли
// находки. Сирота на сайте — повод для работы редактора, а не для красного
// прогона; ненадёжный отчёт — наоборот, повод не верить числам.
await finishSmoke(report.reliable ? 0 : 1);
