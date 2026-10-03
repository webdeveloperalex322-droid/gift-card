/**
 * Контракт ЕДИНСТВЕННОГО послабления приёмки — области счётчиков
 * (`support/counters.ts`, решение Ч-36).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ SPEC НА СИНТЕТИЧЕСКОМ HTML. На стенде счётчик выключен
 * (`counters.enabled: false` — закрывающий дефолт), поэтому области в ответе нет
 * вовсе, и `no-client-javascript.spec.ts` ходит по ветке «послаблений нет» —
 * единственной, которая исполняется в обычном прогоне `pnpm test:seo`. Ветка
 * «скрипт разрешён» при этом не проверяется НИЧЕМ: её однократно проверил
 * человек, включив счётчик в локальной базе, и этот замер не повторяется. Любая
 * последующая правка разбора области была бы принята молча, а ошибка в ней не
 * красит тесты — она делает их неправдивыми: расширься область, и запрещённый
 * клиентский JS проедет как разрешённый.
 *
 * Поэтому проверяется не сайт, а инструмент: что разрешено, что нет, и что
 * считается нарушением формы. Падение здесь говорит о приёмке, а не о состоянии
 * сервера.
 */

import { expect, test } from '@playwright/test';

import {
  COUNTERS_END,
  COUNTERS_START,
  countersRegion,
  executableScriptsOutsideCounters,
} from './support/counters.js';
import { scriptTags } from './support/html.js';

const METRIKA = '<script>(function(m,e,t,r,i,k,a){})(window,document,"script");</script>';
const FOREIGN = '<script src="/assets/island.js"></script>';

/** Страница сайта: голова, содержимое и область счётчиков последней в `<body>`. */
function pageWith(counters: string | null, extra = ''): string {
  const region = counters === null ? '' : `${COUNTERS_START}\n${counters}\n${COUNTERS_END}`;
  return (
    '<!DOCTYPE html><html lang="ru"><head><title>Открытки</title>' +
    '<script type="application/ld+json">{"@type":"WebSite"}</script>' +
    `</head><body><main><h1>Открытки</h1></main>${extra}${region}</body></html>`
  );
}

function offenders(html: string): string[] {
  const region = countersRegion(html);
  return executableScriptsOutsideCounters(scriptTags(html), region).map((script) => script.tag);
}

test('области нет — исполняемый скрипт нарушение, структурированные данные нет', () => {
  const html = pageWith(null, FOREIGN);
  expect(countersRegion(html).kind, 'Отсутствие маркеров — это норма, а не неудача разбора.').toBe(
    'absent',
  );
  expect(
    offenders(html),
    'Без области послабления не существует: любой исполняемый script — нарушение.',
  ).toEqual(['<script src="/assets/island.js">']);
  expect(
    offenders(pageWith(null)),
    '<script type="application/ld+json"> клиентским JS не является и разрешён везде.',
  ).toEqual([]);
});

test('скрипт внутри области разрешён, вне области — нет', () => {
  expect(offenders(pageWith(METRIKA)), 'Код счётчика между маркерами — то самое послабление.')
    .toEqual([]);

  expect(
    offenders(pageWith(METRIKA, FOREIGN)),
    'Включённый счётчик не разрешает остальные скрипты страницы: послабление по МЕСТУ.',
  ).toEqual(['<script src="/assets/island.js">']);
});

test('двойник внутри области не покрывает скрипт вне её', () => {
  // Та самая причина, по которой положение берётся из `ScriptTag.at`, а не
  // поиском текста тега в ответе: `indexOf` вернул бы смещение ПЕРВОГО
  // текстуально такого же тега. Здесь первым идёт тег ВНУТРИ области (она
  // напечатана раньше постороннего скрипта), и поиск по тексту счёл бы
  // посторонний скрипт разрешённым — послабление по месту подменилось бы
  // послаблением по содержимому.
  const html =
    '<!DOCTYPE html><html lang="ru"><head><title>t</title></head><body>' +
    `${COUNTERS_START}\n${FOREIGN}\n${COUNTERS_END}` +
    `${FOREIGN}</body></html>`;

  expect(
    offenders(html),
    'Одинаковый текст тега разрешения не наследует: считается положение КАЖДОГО тега.',
  ).toEqual(['<script src="/assets/island.js">']);
});

test('скрипт после закрывающего маркера нарушением остаётся', () => {
  const html = pageWith(METRIKA) + FOREIGN;
  expect(
    offenders(html),
    'Граница области — закрывающий маркер. То, что стоит за ним, послаблением не покрыто.',
  ).toEqual(['<script src="/assets/island.js">']);
});

test('вторая пара маркеров — нарушение формы, а не вторая разрешённая область', () => {
  // Маркер внутри кода запрещён на вводе (`validateSiteCountersCode`). Если пара
  // всё же удвоилась, запрет обойдён, и границу послабления задаёт содержимое
  // поля — об этом обязан узнать человек, а не приёмка «молча ужесточиться».
  const doubled =
    `${COUNTERS_START}${METRIKA}${COUNTERS_END}` + `${COUNTERS_START}${FOREIGN}${COUNTERS_END}`;
  const region = countersRegion(doubled);
  expect(region.kind).toBe('malformed');

  // И пока форма нарушена, послабление не действует ни для одного скрипта.
  expect(executableScriptsOutsideCounters(scriptTags(doubled), region)).toHaveLength(2);
});

test('непарный и перевёрнутый маркер — тоже нарушение формы', () => {
  expect(countersRegion(`${COUNTERS_START}${METRIKA}`).kind, 'Открыли и не закрыли.').toBe(
    'malformed',
  );
  expect(countersRegion(`${METRIKA}${COUNTERS_END}`).kind, 'Закрыли, не открыв.').toBe('malformed');
  expect(
    countersRegion(`${COUNTERS_END}${METRIKA}${COUNTERS_START}`).kind,
    'Закрывающий перед открывающим — «область», не ограниченная ничем.',
  ).toBe('malformed');
});

test('маркеры приёмки совпадают с тем, что печатает шаблон', () => {
  // Значения заданы копией намеренно (см. шапку `support/counters.ts`), поэтому
  // здесь закреплена сама ФОРМА комментария: шаблон печатает
  // `<!-- ${SITE_COUNTERS_MARKER_START} -->` с пробелами внутри комментария, и
  // расхождение в пробеле лишило бы приёмку области целиком.
  expect(COUNTERS_START).toBe('<!-- site-counters:start -->');
  expect(COUNTERS_END).toBe('<!-- site-counters:end -->');
  expect(COUNTERS_START).not.toBe(COUNTERS_END);
});
