/**
 * Требование (`CLAUDE.md`, «Sitemap и robots»): «включаются только абсолютные
 * канонические URL со статусом 200 и разрешением на индексацию. Редиректы, 404,
 * noindex, параметры — исключаются. **Это проверяется тестом, а не
 * соглашением**». Плюс п. 23: «НЕ добавлять в sitemap неканонические/закрытые
 * страницы».
 *
 * ## Почему юнит-тестами это не закрывается
 *
 * Юнит-тест `tests/unit/web-sitemap.test.ts` проверяет ПРАВИЛО отбора: по трём
 * фактам (директива, canonical, «отвечает ли 200») оно решает верно. Но третий
 * факт — `respondsOk` — приходит в правило СНАРУЖИ, его вычисляет слой данных по
 * своему представлению о том, когда маршрут отвечает 200 (наличие производных у
 * карточки, предикат «опубликован И непуст» у подборки). Расхождение этого
 * представления с шаблоном юнит-тест увидеть не может в принципе: он проверяет
 * функцию на тех фактах, которые ему подали. Единственный способ поймать
 * расхождение — запросить адрес из карты и посмотреть, что отвечает сервер.
 * Ровно поэтому требование в `CLAUDE.md` записано словами «проверяется тестом».
 *
 * ## Что именно утверждается о каждом адресе карты
 *
 *   - ответ 200 и НЕ переход. Адрес, отвечающий 301, — это карта, которая ведёт
 *     краулера в редирект: вес ссылки теряется, а канонический адрес поисковая
 *     система узнаёт вторым запросом;
 *   - self-canonical, равный этому же адресу ЦЕЛИКОМ (схема, хост, порт, путь).
 *     Страница с canonical на другой адрес в карте быть не может: карта
 *     утверждает «вот канонический адрес», а страница отвечает «нет, другой»;
 *   - `<meta name="robots">` ровно `index,follow`. Это тот самый случай, ради
 *     которого директива считается единственным разрешателем (Э4-01): страница,
 *     закрытая в разметке и открытая в карте, — прямое нарушение п. 23, и в
 *     браузере оно выглядит нормально.
 *
 * ## Про пустой прогон
 *
 * Карта пуста, пока ни одна страница не открыта в `index,follow` (Ч-04-1), —
 * тест проходит ВХОЛОСТУЮ и помечает прогон аннотацией «проверено нечем».
 * Зелёный статус здесь означает «проверять было нечего», а не покрытие.
 */

import { expect, test } from '@playwright/test';

import { canonicalHrefs, metaContents } from './support/html.js';
import { fetchRaw, isRedirect } from './support/http.js';
import { annotateEmptyRun, readSitemapTree } from './support/sitemap-tree.js';
import { resolveAcceptanceTarget } from './support/target.js';

const target = resolveAcceptanceTarget();

/** Директива, которую обязана отдавать страница, попавшая в карту сайта. */
const REQUIRED_DIRECTIVE = 'index,follow';

test.describe.configure({ timeout: 180_000 });

test('каждый адрес из карты сайта отвечает 200, каноничен сам себе и открыт в индекс', async ({
  browser,
  request,
}, testInfo) => {
  const tree = await readSitemapTree(request, browser, target);

  if (tree.pageUrls.length === 0) {
    annotateEmptyRun(testInfo, 'Состав карты сайта НЕ проверен: в ней нет ни одного адреса.');
    return;
  }

  const problems: string[] = [];

  for (const loc of tree.pageUrls) {
    let absolute: string;
    try {
      absolute = new URL(loc).toString();
    } catch {
      problems.push(
        `«${loc}» — не абсолютный адрес. В карту сайта входят только абсолютные канонические ` +
          'URL; относительный адрес разные краулеры разрешают по-разному.',
      );
      continue;
    }

    if (!absolute.startsWith(`${target.origin}/`)) {
      problems.push(
        `«${loc}» ведёт на чужой origin. Ожидался ${target.origin} — тот же хост, на котором ` +
          'гоняется приёмка (BASE_URL и SITE_URL на её окружении совпадают).',
      );
      continue;
    }

    const response = await fetchRaw(request, absolute);

    // Переход проверяется ПЕРВЫМ: у ответа 301 статус тоже «не 200», и сообщение
    // «адрес отвечает 404» отправило бы владельца слоя искать несуществующую
    // страницу вместо лишнего редиректа.
    if (response.location !== null || isRedirect(response.status)) {
      problems.push(
        `${loc} → ${String(response.status)} на ${response.location ?? '—'}. Карта обязана ` +
          'называть КОНЕЧНЫЙ адрес: редирект в ней теряет вес ссылки и заставляет краулера ' +
          'делать второй запрос, а канонический адрес он узнаёт только со второго шага.',
      );
      continue;
    }
    if (response.status !== 200) {
      problems.push(
        `${loc} → ${String(response.status)}. В карте сайта только адреса, отвечающие 200: ` +
          '404 и 410 в ней — прямой сигнал поисковой системе обходить несуществующее.',
      );
      continue;
    }

    const canonicals = canonicalHrefs(response.body);
    if (canonicals.length !== 1) {
      problems.push(
        `${loc} → self-canonical'ов ${String(canonicals.length)}, а обязан быть ровно один.`,
      );
    } else if (canonicals[0] !== absolute) {
      problems.push(
        `${loc} → страница объявляет canonical «${canonicals[0] ?? ''}». Карта утверждает, что ` +
          'канонический адрес один, а страница называет другой: в индекс пойдёт тот, которому ' +
          'поисковая система поверит, и это решение принимает не сайт.',
      );
    }

    const directives = metaContents(response.body, 'robots');
    if (directives.length !== 1) {
      problems.push(
        `${loc} → директив робота ${String(directives.length)}, а обязана быть ровно одна.`,
      );
    } else if (directives[0] !== REQUIRED_DIRECTIVE) {
      problems.push(
        `${loc} → страница отдаёт «${directives[0] ?? ''}», а в карте сайта могут быть только ` +
          `страницы с «${REQUIRED_DIRECTIVE}». Закрытая в разметке и открытая в карте страница — ` +
          'прямое нарушение п. 23 ТЗ, и в браузере оно выглядит нормально.',
      );
    }
  }

  expect(
    problems,
    `Проверено адресов в карте сайта: ${String(tree.pageUrls.length)}.`,
  ).toEqual([]);
});
