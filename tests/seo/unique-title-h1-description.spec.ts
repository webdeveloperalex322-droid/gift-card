/**
 * Требование (п. 22): на выборке страниц title, H1 и description УНИКАЛЬНЫ и не
 * пусты.
 *
 * Честная оговорка о текущей силе проверки: в инвентаре пока одна страница
 * (`/` — техническая заглушка Э3-01), поэтому утверждение об уникальности
 * выполняется тривиально. Работать оно начнёт, когда в инвентарь войдут карточка
 * и подборки (Э3-05…Э3-09) — именно там шаблонный title вида
 * «Открытки на <тема>» и порождает дубли. Утверждение о непустоте работает уже
 * сейчас. Это записано и в отчёте: spec, выглядящий как проверка, но ничего не
 * проверяющий, — та же ошибка отчётности, что и пропуск, выданный за
 * прохождение.
 */

import { expect, test } from '@playwright/test';

import { headingTexts, metaContents, titles } from './support/html.js';
import { fetchRaw } from './support/http.js';
import { ACCEPTANCE_PAGES } from './support/pages.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

interface Collected {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly h1: string;
}

/** Пары «значение → страницы», где значение встретилось больше одного раза. */
function duplicates(entries: readonly Collected[], field: keyof Omit<Collected, 'path'>): string[] {
  const seen = new Map<string, string[]>();
  for (const entry of entries) {
    const key = entry[field].trim().toLowerCase();
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
    const description = metaContents(response.body, 'description')[0] ?? '';
    const h1 = headingTexts(response.body, 1)[0] ?? '';

    expect(title.length, `Пустой title на ${page.path}.`).toBeGreaterThan(0);
    expect(description.length, `Пустой description на ${page.path}.`).toBeGreaterThan(0);
    expect(h1.length, `Пустой H1 на ${page.path}.`).toBeGreaterThan(0);

    collected.push({ path: page.path, title, description, h1 });
  }

  expect(duplicates(collected, 'title'), 'Совпадающие title на разных страницах.').toEqual([]);
  expect(
    duplicates(collected, 'description'),
    'Совпадающие description на разных страницах.',
  ).toEqual([]);
  expect(duplicates(collected, 'h1'), 'Совпадающие H1 на разных страницах.').toEqual([]);
});
