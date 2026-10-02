/**
 * Требование (п. 22, чек-лист: «уникальные title/H1/description на выборке,
 * ровно один H1»; условие п. 5.1.4 «уникальные тексты»): два РАЗНЫХ адреса,
 * открытых в индекс, не описывают себя одинаково.
 *
 * ## Почему это не дубль `unique-title-h1-description.spec.ts`
 *
 * Тот spec идёт по ОБЪЯВЛЕННОЙ выборке инвентаря (`support/declared-pages.ts`) —
 * по одной странице на каждый вид из п. 22. Выборка намеренно берёт один
 * представитель шаблона: страницы одного шаблона на разных записях проверяют
 * одно и то же, а время обязательного шлюза расходуется на каждую.
 *
 * Пока в индекс не открыта ни одна страница, этого достаточно. С волной 1
 * (2026-10-02, `docs/publikaciya-volna-1.md`) стало недостаточно: человек открыл
 * в `index,follow` ШЕСТЬ праздничных узлов одного шаблона, а в инвентаре из них
 * объявлен один (`/otkrytki/prazdniki/8-marta`). Совпадение title у двух
 * ОСТАЛЬНЫХ узлов выборка из одного представителя не видит в принципе — а это
 * ровно тот дубль, за который поисковая система склеивает посадочные и выбирает
 * каноническую сама.
 *
 * Поэтому здесь выборка другая и считается не из репозитория, а из состояния
 * сайта: адреса берутся из карты сайта, то есть это ровно тот список, с которым
 * к сайту приходит поисковая система (в карту по построению входят только 200 +
 * self-canonical + `index,follow`, это держит
 * `sitemap-entries-are-indexable.spec.ts`). Новая открытая человеком страница
 * попадает под проверку сама, без правок здесь.
 *
 * ## Почему именно по карте, а не по обходу сайта
 *
 * Обход нашёл бы те же страницы, но выборка тогда зависела бы от перелинковки —
 * то есть от кода, который приёмка и проверяет: сломанное меню давало бы не
 * падение, а другую (меньшую) выборку. Карта сайта по отношению к шаблонам
 * внешняя. Обратную сторону — «страница открыта в индекс, но в карту не
 * попала» — ловит `no-orphans.spec.ts` третьим источником (живые ответы обхода).
 *
 * ## Что утверждается
 *
 *   - у каждого адреса карты непустой title, ровно один H1 с непустым текстом и
 *     ровно один непустой `<meta name="description">` (у индексируемой страницы
 *     description обязателен — п. 22.1);
 *   - ни одно из трёх значений не повторяется на двух разных адресах.
 *
 * Сравнение идёт по нормализованному тексту (схлопнутые пробелы), а не по
 * совпадению байт в байт: дубль, отличающийся одним неразрывным пробелом,
 * остаётся дублем для поисковой системы.
 *
 * ## Чего spec не делает
 *
 * Не судит о СОДЕРЖАНИИ: «не получен заменой пары слов в шаблоне» (п. 23.4)
 * машиной не проверяется, и выдавать различие строк за выполнение этого условия
 * нельзя. Пустой прогон (в карте нет адресов) помечается аннотацией «проверено
 * нечем».
 */

import { expect, test } from '@playwright/test';

import { headingTexts, metaContents, titles } from './support/html.js';
import { fetchRaw } from './support/http.js';
import { annotateEmptyRun, readSitemapTree } from './support/sitemap-tree.js';
import { resolveAcceptanceTarget } from './support/target.js';

const target = resolveAcceptanceTarget();

test.describe.configure({ timeout: 300_000 });

/**
 * Схлопывает пробельные последовательности, включая неразрывный пробел.
 *
 * `\u00a0` записан escape-последовательностью намеренно: буквальный символ в
 * исходнике неотличим от обычного пробела при чтении и запрещён правилом
 * `no-irregular-whitespace`.
 */
function normalize(value: string): string {
  return value.replace(/[\s\u00a0]+/gu, ' ').trim();
}

interface Collected {
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly h1: string;
}

function duplicates(entries: readonly { url: string; value: string }[]): string[] {
  const seen = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.value === '') {
      continue;
    }
    seen.set(entry.value, [...(seen.get(entry.value) ?? []), entry.url]);
  }
  return [...seen.entries()]
    .filter(([, urls]) => urls.length > 1)
    .map(([value, urls]) => `«${value}» → ${urls.join(', ')}`);
}

test('title, H1 и description уникальны среди ВСЕХ страниц, открытых в индекс', async ({
  browser,
  request,
}, testInfo) => {
  const tree = await readSitemapTree(request, browser, target);

  if (tree.pageUrls.length === 0) {
    annotateEmptyRun(
      testInfo,
      'Уникальность title/H1/description среди индексируемых страниц НЕ проверена.',
    );
    return;
  }

  const collected: Collected[] = [];
  const problems: string[] = [];

  for (const loc of tree.pageUrls) {
    const response = await fetchRaw(request, loc);
    if (response.status !== 200) {
      // Статус адреса карты — предмет `sitemap-entries-are-indexable.spec.ts`.
      // Здесь он лишь означает, что сравнивать нечего, и молчать об этом нельзя.
      problems.push(
        `${loc} → ${String(response.status)}: тексты страницы не прочитаны. Нарушение статуса ` +
          'называет sitemap-entries-are-indexable.spec.ts, здесь оно только помечено.',
      );
      continue;
    }

    const title = normalize(titles(response.body)[0] ?? '');
    const headings = headingTexts(response.body, 1).map(normalize);
    const descriptions = metaContents(response.body, 'description').map(normalize);

    if (title === '') {
      problems.push(`${loc} — пустой или отсутствующий title у индексируемой страницы.`);
    }
    if (headings.length !== 1) {
      problems.push(
        `${loc} — H1 на странице ${String(headings.length)}, а обязан быть ровно один: ` +
          'второй H1 размывает тему страницы, ноль — оставляет её без заголовка.',
      );
    } else if (headings[0] === '') {
      problems.push(`${loc} — H1 есть, но его текст пуст.`);
    }
    if (descriptions.length !== 1) {
      problems.push(
        `${loc} — <meta name="description"> на странице ${String(descriptions.length)}. ` +
          'У индексируемой страницы он обязателен и обязан быть один (п. 22.1): ноль — нечем ' +
          'описать сниппет, два — какое значение возьмёт поисковая система, предсказать нельзя.',
      );
    } else if (descriptions[0] === '') {
      problems.push(`${loc} — description есть, но пуст.`);
    }

    collected.push({
      url: loc,
      title,
      description: descriptions[0] ?? '',
      h1: headings[0] ?? '',
    });
  }

  const duplicateTitles = duplicates(
    collected.map((entry) => ({ url: entry.url, value: entry.title })),
  );
  const duplicateH1 = duplicates(collected.map((entry) => ({ url: entry.url, value: entry.h1 })));
  const duplicateDescriptions = duplicates(
    collected.map((entry) => ({ url: entry.url, value: entry.description })),
  );

  console.log(
    `[уникальность индексируемых] проверено адресов карты сайта: ${String(collected.length)}.`,
  );

  expect(
    problems,
    `Полнота самоописания индексируемых страниц. Проверено адресов: ${String(
      tree.pageUrls.length,
    )}.`,
  ).toEqual([]);

  expect(
    duplicateTitles,
    'Совпадающий title у двух адресов, открытых в индекс. Поисковая система считает такие ' +
      'страницы дублями и выбирает каноническую сама — то есть вместо сайта. Исправляет ' +
      'владелец записи в админке (`payload-cms`), а не приёмка.',
  ).toEqual([]);

  expect(
    duplicateH1,
    'Совпадающий H1 у двух адресов, открытых в индекс: страницы заявляют одну и ту же тему, ' +
      'и условие п. 5.1.4 «уникальные title/H1/вводный текст» нарушено.',
  ).toEqual([]);

  expect(
    duplicateDescriptions,
    'Совпадающий description у двух адресов, открытых в индекс: одинаковый сниппет в выдаче — ' +
      'прямой признак шаблонного текста (запрет п. 23.4).',
  ).toEqual([]);
});
