/**
 * Требование (ТЗ §5.2 и §5.5, решение Ч-04-3, вето V6): отфильтрованное
 * представление НЕ индексируется, и производное представление никогда не бывает
 * ОТКРЫТЕЕ самой страницы.
 *
 * Формулировка «не открытее» выбрана намеренно, вместо «всегда noindex»:
 * страница, закрытая человеком директивой `noindex,nofollow`, обязана остаться
 * такой и с параметром — то есть правило односторонне. Ровно так оно и записано в
 * коде: с задачи Э4-01 директиву считает единственный разрешатель
 * `resolvePageRobots` в `apps/web/src/seo/robots-directive.ts` — он принимает
 * ОБЪЯВЛЕННОЕ значение как потолок и умеет только закрывать, а активный фильтр
 * (`hasActiveFilter` из `apps/web/src/routing/view-params.ts`) — одна из причин
 * закрытия. Прежней функции `robotsForFilteredView` в `view-params.ts` больше
 * нет: там остался только ФАКТ «фильтр активен», а решение переехало к
 * разрешателю. Здесь правило проверяется на живом ответе.
 *
 * ## Честная оговорка о силе проверки на 2026-08-27
 *
 * Ни одна страница сайта пока не открыта в `index,follow` (спрос данными не
 * подтверждён, Ч-04-1), поэтому «фильтр закрывает индексируемую страницу»
 * проверить сейчас НЕ НА ЧЕМ: закрывать нечего. Работает вторая половина
 * правила — «директива не становится открытее», — и она не тавтологична: если
 * шаблон начнёт печатать директиву не из данных страницы, а константой
 * `index,follow` (типичная правка «чтобы поисковик увидел фильтр»), spec упадёт.
 *
 * Полную силу утверждение получит в момент, когда человек откроет в индекс первую
 * посадочную: тогда сравнение «index,follow у чистого адреса против директивы у
 * адреса с `?format=`» станет содержательным, и падение назовёт ровно нарушение
 * V6 — «фильтр породил индексируемый URL». Правок в spec для этого не нужно.
 *
 * Второе, что здесь проверяется, — что ссылки самого фильтра не приглашают
 * краулера в пространство параметров: у ссылки с параметром обязан быть
 * `rel="nofollow"`, а исключение ровно одно — ссылка сброса на чистый путь
 * страницы (ТЗ §6.5: адреса с параметрами не участвуют в перелинковке).
 */

import { expect, test } from '@playwright/test';

import { anchorTags, attributeValue, metaContents } from './support/html.js';
import { fetchRaw } from './support/http.js';
import { ACCEPTANCE_PAGES, QUERY_VARIANTS } from './support/pages.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

/**
 * Насколько директива ОТКРЫТА. Больше — открытее.
 *
 * Числами, а не сравнением строк: правило «представление не бывает открытее
 * страницы» — это отношение порядка, и записать его иначе значило бы перечислять
 * пары значений руками.
 */
const OPENNESS: Readonly<Record<string, number>> = {
  'index,follow': 2,
  'noindex,follow': 1,
  'noindex,nofollow': 0,
};

for (const page of ACCEPTANCE_PAGES) {
  test(`представление с параметрами не открытее страницы: ${page.path} (${page.task})`, async ({
    request,
  }) => {
    const clean = await fetchRaw(request, urlFor(target, page.path));
    const baseDirective = metaContents(clean.body, 'robots')[0] ?? '';
    const baseRank = OPENNESS[baseDirective];
    expect(
      baseRank,
      `Директива «${baseDirective}» у чистого адреса не входит в список допустимых.`,
    ).not.toBeUndefined();

    for (const variant of QUERY_VARIANTS) {
      const response = await fetchRaw(request, urlFor(target, `${page.path}${variant.query}`));
      const directives = metaContents(response.body, 'robots');

      expect(
        directives,
        `На ${page.path}${variant.query} обязана быть ровно одна директива робота.`,
      ).toHaveLength(1);

      const directive = directives[0] ?? '';
      const rank = OPENNESS[directive];
      expect(rank, `Директива «${directive}» не входит в список допустимых.`).not.toBeUndefined();

      expect(
        (rank ?? 9) <= (baseRank ?? -1),
        `Адрес ${page.path}${variant.query} (${variant.note}) отдаёт «${directive}», а чистая ` +
          `страница — «${baseDirective}». Представление, заданное параметрами, не бывает ` +
          'ОТКРЫТЕЕ самой страницы: иначе фильтр порождает индексируемый URL (вето V6), а ' +
          'директива, которой человек закрыл страницу, снимается приписанным параметром.',
      ).toBe(true);
    }
  });
}

/**
 * Ссылки с параметрами проверяются и на ЧИСТОМ адресе, и на отфильтрованном
 * представлении.
 *
 * Второе — не перестраховка, а замеренный случай: на отфильтрованном
 * представлении блок пагинации приписывает `?format=…` к адресам соседних
 * страниц (`apps/web/src/components/Pagination.astro`, проп `query`), и эти
 * ссылки `rel="nofollow"` НЕ получают, хотя ряд самого фильтра получает. Замер
 * 2026-08-27 на локальной базе:
 * `/podborki/.../page/2?format=vertical` печатает `<a href=".../?format=vertical">`
 * без `rel`. Пока страниц списка нет в инвентаре (они существуют только у
 * опубликованной записи), это утверждение здесь молчит; в момент, когда список
 * войдёт в выборку на Э3-13, оно назовёт нарушение — и исправлять его будет
 * владелец слоя `astro-web`, а не приёмка.
 */
const LINK_PROBES: readonly string[] = ['', ...QUERY_VARIANTS.map((variant) => variant.query)];

for (const page of ACCEPTANCE_PAGES) {
  test(`ссылки с параметрами закрыты от обхода: ${page.path} (${page.task})`, async ({
    request,
  }) => {
    const bodies: string[] = [];
    for (const query of LINK_PROBES) {
      bodies.push((await fetchRaw(request, urlFor(target, `${page.path}${query}`))).body);
    }

    const followableWithQuery = bodies
      .flatMap((body) => anchorTags(body))
      .filter((anchor) => {
        const href = (anchor.href ?? '').trim();
        return href.startsWith('/') && href.includes('?');
      })
      .filter((anchor) => {
        const rel = (attributeValue(anchor.tag, 'rel') ?? '').toLowerCase();
        return !rel.split(/[\s,]+/u).includes('nofollow');
      })
      .map((anchor) => anchor.tag);

    expect(
      followableWithQuery,
      'Внутренняя ссылка с параметрами обязана иметь rel="nofollow": адреса с параметрами не ' +
        'участвуют в перелинковке (ТЗ §6.5), потому что каждая такая ссылка приглашает краулера ' +
        'обходить пространство представлений вместо страниц. Исключение — ссылка СБРОСА ' +
        'фильтра: она ведёт на чистый путь и параметров не содержит.',
    ).toEqual([]);
  });
}
