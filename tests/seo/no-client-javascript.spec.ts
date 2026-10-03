/**
 * Требование (раздел «Рендеринг»): клиентский JS — только точечные острова;
 * по умолчанию его нет. На страницах волны 0 островов нет ни одного, поэтому
 * исполняемых `<script>` в ответе быть не должно.
 *
 * Что НЕ считается клиентским JS: `<script type="application/ld+json">`. Это
 * структурированные данные, они обязательны по ТЗ (раздел «Структурированные
 * данные») и появятся на карточке, подборке и главной. Spec различает их по
 * `type`, а не «разрешает любой script с json в теле» — иначе он перестал бы
 * ловить настоящий скрипт.
 *
 * Когда появятся острова (кнопка скачивания на Э3-05, фильтры на Э3-10), это
 * требование не отменяется, а уточняется: разрешённый скрипт станет свойством
 * страницы в инвентаре (`support/pages.ts`), а не общим послаблением. Пока
 * послабления нет.
 *
 * ## Единственное исключение: область счётчиков (решение Ч-36)
 *
 * Код сторонних счётчиков (Яндекс.Метрика и подобное) вставляет человек в
 * настройках сайта, и это произвольный HTML: по содержимому скрипта узнать его
 * «свой или чужой» нельзя. Поэтому послабление сделано по МЕСТУ, а не по
 * содержимому — шаблон обводит код комментариями-маркерами, и исполняемый
 * `<script>` допустим РОВНО между ними. Любой скрипт вне области валит приёмку
 * по-прежнему, то есть общего «скрипты разрешены» здесь не появляется.
 *
 * Разбор области и сами маркеры живут в `support/counters.ts` отдельным модулем
 * с собственным контрактом (`counters-region-contract.spec.ts`). Причина — там
 * же в шапке: на стенде с выключенным счётчиком области в ответе НЕТ, то есть
 * обычный прогон приёмки ветку послабления не исполняет ни разу, и проверять её
 * приходится синтетическим HTML.
 */

import { expect, test } from '@playwright/test';

import {
  STRUCTURED_DATA_TYPE,
  countersRegion,
  executableScriptsOutsideCounters,
} from './support/counters.js';
import { scriptTags } from './support/html.js';
import { fetchRaw } from './support/http.js';
import { ACCEPTANCE_PAGES } from './support/pages.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

for (const page of ACCEPTANCE_PAGES) {
  test(`нет исполняемого клиентского JS: ${page.path} (${page.task})`, async ({ request }) => {
    const response = await fetchRaw(request, urlFor(target, page.path));
    expect(response.status, 'Страница обязана отдавать 200.').toBe(200);

    const region = countersRegion(response.body);
    expect(
      region.kind === 'malformed' ? region.reason : null,
      'Форма области счётчиков нарушена, а значит нарушена и граница послабления Ч-36.',
    ).toBeNull();

    const executable = executableScriptsOutsideCounters(scriptTags(response.body), region);

    expect(
      executable.map((script) => script.tag),
      'Клиентского JS на этой странице быть не должно (нулевой клиентский JS по умолчанию). ' +
        `Исключения два: <script type="${STRUCTURED_DATA_TYPE}"> и код счётчиков внутри ` +
        'области, обведённой маркерами site-counters (решение Ч-36).',
    ).toEqual([]);
  });
}
