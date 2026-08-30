/**
 * Требование (п. 22): на выборке страниц title, H1 и description УНИКАЛЬНЫ и не
 * пусты.
 *
 * Сила проверки на 2026-08-27: в инвентаре пять страниц (`/`, `/search`,
 * `/o-proekte`, `/usloviya`, `/kontakty`), то есть утверждение об уникальности
 * уже работает — но на страницах, тексты которых лежат в КОДЕ. Настоящую силу
 * оно получит, когда в выборку войдут карточка и подборки (Э3-13): именно там
 * шаблонный title вида «Открытки на <тема>» и порождает дубли. Записано и в
 * отчёте: spec, выглядящий как проверка, но ничего не проверяющий, — та же ошибка
 * отчётности, что и пропуск, выданный за прохождение.
 *
 * ## Про description, которого нет
 *
 * У информационных страниц (`/o-proekte`, `/usloviya`, `/kontakty`) тега
 * `<meta name="description">` нет вовсе: текст берётся из глобала настроек,
 * глобал — заглушка (Ч-19), а правило проекта «пустое поле — значит тега нет»
 * (Ч-10, Ч-17) убирает тег целиком, вместо того чтобы печатать `content=""`.
 *
 * Требовать непустой description на каждой странице выборки значило бы требовать,
 * чтобы описание придумал АГЕНТ вместо человека, — шаблонный SEO-текст, прямой
 * запрет п. 23.4. Поэтому наличие тега объявлено в инвентаре полем `description`
 * и проверяется в обе стороны:
 *
 *   - `present` — тег есть, непуст и участвует в проверке уникальности;
 *   - `absent` — тега НЕТ, и это утверждение: появившийся description валит spec
 *     с требованием объявить факт заново (значит человек заполнил глобал);
 *   - `absent` у ИНДЕКСИРУЕМОЙ страницы валит spec всегда: у индексируемой
 *     страницы description обязателен (п. 22.1). То есть в момент, когда человек
 *     по Ч-23 откроет `/o-proekte` в `index,follow`, приёмка потребует описания, а
 *     не промолчит.
 *
 * Ослаблением это не является: ни одна страница не выпадает из проверки молча —
 * состояние каждой объявлено строкой в `support/pages.ts`, и диф это показывает.
 */

import { expect, test } from '@playwright/test';

import { headingTexts, metaContents, titles } from './support/html.js';
import { fetchRaw } from './support/http.js';
import { ACCEPTANCE_PAGES, isIndexable } from './support/pages.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

interface Collected {
  readonly path: string;
  readonly title: string;
  /** `null` — тега description нет вовсе (объявленное состояние `absent`). */
  readonly description: string | null;
  readonly h1: string;
}

/** Пары «значение → страницы», где значение встретилось больше одного раза. */
function duplicates(values: readonly { readonly path: string; readonly value: string }[]): string[] {
  const seen = new Map<string, string[]>();
  for (const entry of values) {
    const key = entry.value.trim().toLowerCase();
    seen.set(key, [...(seen.get(key) ?? []), entry.path]);
  }
  return [...seen.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([value, paths]) => `«${value}» → ${paths.join(', ')}`);
}

test('title, description и H1 непусты и уникальны на выборке', async ({ request }) => {
  const collected: Collected[] = [];

  for (const page of ACCEPTANCE_PAGES) {
    const response = await fetchRaw(request, urlFor(target, page.path));
    expect(response.status, `Страница ${page.path} обязана отдавать 200.`).toBe(200);

    const title = titles(response.body)[0] ?? '';
    const descriptions = metaContents(response.body, 'description');
    const h1 = headingTexts(response.body, 1)[0] ?? '';

    expect(title.length, `Пустой title на ${page.path}.`).toBeGreaterThan(0);
    expect(h1.length, `Пустой H1 на ${page.path}.`).toBeGreaterThan(0);

    expect(
      descriptions.length,
      `На ${page.path} больше одного <meta name="description">: какое из значений возьмёт ` +
        'поисковая система, предсказать нельзя.',
    ).toBeLessThanOrEqual(1);

    if (page.description === 'absent') {
      expect(
        isIndexable(page),
        `Страница ${page.path} объявлена в инвентаре как «description отсутствует» и при этом ` +
          'индексируема. У индексируемой страницы description обязателен (п. 22.1): либо ' +
          'заполните поле в админке, либо страница остаётся noindex. Подставлять описание ' +
          'шаблоном запрещено (п. 23.4).',
      ).toBe(false);
      expect(
        descriptions,
        `Инвентарь приёмки объявляет ${page.path} без <meta name="description">, а в ответе ` +
          'тег есть. Значит человек заполнил текст в админке — объявите страницу ' +
          '`description: present` в tests/seo/support/pages.ts тем же коммитом и проверьте, ' +
          'не пора ли открыть её в индекс по Ч-23 (это решение человека, не агента).',
      ).toEqual([]);
      collected.push({ path: page.path, title, description: null, h1 });
      continue;
    }

    const description = descriptions[0] ?? '';
    expect(
      description.length,
      `Пустой или отсутствующий description на ${page.path}. Страница объявлена в инвентаре ` +
        'как `description: present`.',
    ).toBeGreaterThan(0);

    collected.push({ path: page.path, title, description, h1 });
  }

  expect(
    duplicates(collected.map((entry) => ({ path: entry.path, value: entry.title }))),
    'Совпадающие title на разных страницах.',
  ).toEqual([]);
  expect(
    duplicates(
      collected
        .filter((entry) => entry.description !== null)
        .map((entry) => ({ path: entry.path, value: entry.description ?? '' })),
    ),
    'Совпадающие description на разных страницах.',
  ).toEqual([]);
  expect(
    duplicates(collected.map((entry) => ({ path: entry.path, value: entry.h1 }))),
    'Совпадающие H1 на разных страницах.',
  ).toEqual([]);
});
