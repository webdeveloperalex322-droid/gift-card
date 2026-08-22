/**
 * Требование (раздел «Рендеринг» и п. 22): title, H1, canonical, основной текст
 * присутствуют в HTML-ответе сервера; страница полноценна при отключённом JS.
 *
 * Проверка идёт в двух формах, и это не дублирование:
 *   - утверждения по СЫРОМУ ответу: то, что пришло по проводу, до всякого
 *     браузера. Именно так видит страницу поисковый робот, который JS не
 *     исполняет;
 *   - одно утверждение в браузере с `javaScriptEnabled: false`: текст не просто
 *     присутствует в разметке, а виден — то есть не спрятан за скриптом,
 *     дорисовывающим класс видимости.
 *
 * Порог длины текста намеренно грубый (200 знаков видимого текста): задача
 * spec'а — отличить «содержание пришло с сервера» от «пришёл каркас, содержание
 * дорисует JS», а не оценивать объём контента. Требование п. 5.1 «достаточно
 * открыток» проверяется не здесь и решается человеком.
 */

import { expect, test } from '@playwright/test';

import { htmlLang, titles, visibleText } from './support/html.js';
import { fetchRaw } from './support/http.js';
import { ACCEPTANCE_PAGES } from './support/pages.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();
const MIN_VISIBLE_TEXT_LENGTH = 200;

for (const page of ACCEPTANCE_PAGES) {
  test(`ответ сервера полноценен без JS: ${page.path} (${page.task})`, async ({ request }) => {
    const response = await fetchRaw(request, urlFor(target, page.path));

    expect(
      response.status,
      `Страница из инвентаря приёмки обязана отдавать 200. ${page.note}`,
    ).toBe(200);
    expect(response.contentType ?? '', 'Ответ обязан быть HTML.').toContain('text/html');

    expect(htmlLang(response.body), 'Атрибут lang у <html> обязателен: сайт русскоязычный.').toBe(
      'ru',
    );

    const pageTitles = titles(response.body);
    expect(pageTitles, 'В ответе обязан быть ровно один <title>.').toHaveLength(1);
    expect((pageTitles[0] ?? '').length, '<title> не может быть пустым.').toBeGreaterThan(0);

    const text = visibleText(response.body);
    expect(
      text.length,
      'Основной текст обязан приходить в HTML-ответе сервера, а не дорисовываться JS ' +
        `(«НЕ скрывать контент за JavaScript», п. 23 ТЗ). Получено ${String(text.length)} знаков: ` +
        `«${text.slice(0, 120)}».`,
    ).toBeGreaterThanOrEqual(MIN_VISIBLE_TEXT_LENGTH);
  });
}

test.describe('в браузере с отключённым JS', () => {
  /**
   * Отдельный бюджет времени — не послабление проверки, а плата за запуск
   * браузера: первый старт chromium на холодной машине занимает секунды, и они
   * попадают в таймаут первого же теста, которому браузер понадобился. Сами
   * утверждения при этом ждут не дольше `expect.timeout` из конфига (5 с),
   * поэтому зависшее ожидание видимости H1 длинным таймаутом не спрячется.
   */
  test.describe.configure({ timeout: 180_000 });

  for (const acceptancePage of ACCEPTANCE_PAGES) {
    test(`содержание видно: ${acceptancePage.path} (${acceptancePage.task})`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ javaScriptEnabled: false });
      try {
        const browserPage = await context.newPage();
        const response = await browserPage.goto(urlFor(target, acceptancePage.path), {
          waitUntil: 'domcontentloaded',
        });

        expect(response?.status(), 'Страница обязана отдавать 200 и при отключённом JS.').toBe(200);

        const heading = browserPage.locator('h1');
        await expect(heading, 'H1 обязан быть виден без JS.').toBeVisible();
        await expect(heading, 'H1 обязан содержать текст.').not.toHaveText('');
      } finally {
        await context.close();
      }
    });
  }
});
