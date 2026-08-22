/**
 * Требование: на окружении приёмки `SITE_URL` и `BASE_URL` указывают на ОДИН
 * хост (`CLAUDE.md`, раздел «SEO-тесты»).
 *
 * Проверяется не переменная окружения, а результат: origin абсолютного
 * self-canonical, который сервер реально положил в HTML. Так проверка ловит два
 * разных случая одним утверждением:
 *   - стенд поднят с чужим `SITE_URL` (ошибка конфигурации окружения);
 *   - в шаблоне появился второй источник хоста (`Astro.site`, захардкоженный
 *     домен, фолбэк на `localhost`) — тогда origin разойдётся даже при верном
 *     `SITE_URL`.
 *
 * Падение здесь означает: остальные проверки canonical недостоверны. Ослаблять
 * их (сравнивать «оканчивается на путь» вместо абсолютного адреса) запрещено —
 * расхождение хостов является ошибкой окружения, а не теста.
 */

import { expect, test } from '@playwright/test';

import { canonicalHrefs } from './support/html.js';
import { fetchRaw } from './support/http.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

test('origin self-canonical равен origin BASE_URL', async ({ request }) => {
  const response = await fetchRaw(request, urlFor(target, '/'));

  expect(
    response.status,
    `Корень стенда обязан отдавать 200, получен ${String(response.status)}.`,
  ).toBe(200);

  const hrefs = canonicalHrefs(response.body);
  expect(hrefs, 'На корне обязан быть ровно один <link rel="canonical">.').toHaveLength(1);

  const href = hrefs[0] ?? '';
  expect(
    /^https?:\/\//i.test(href),
    `canonical «${href}» не абсолютный: сравнить хосты невозможно, и это само по себе ` +
      'нарушение требования «абсолютный self-canonical».',
  ).toBe(true);

  expect(
    new URL(href).origin,
    'Расхождение хостов SITE_URL и BASE_URL — ошибка конфигурации ОКРУЖЕНИЯ, не теста.\n' +
      `  BASE_URL:  ${target.origin}\n` +
      `  canonical: ${href}\n` +
      '  Как починить, не ослабляя проверку:\n' +
      '   - дать стенду SITE_URL, равный BASE_URL (режим по умолчанию делает это сам —\n' +
      '     значит стенд поднят снаружи, с SEO_REUSE_SERVER=1);\n' +
      '   - либо гонять приёмку по адресу из SITE_URL: отобразить otkritka.test на порт\n' +
      '     приложения (hosts + обратный прокси) и задать BASE_URL=http://otkritka.test.\n' +
      '  Сравнение canonical при расхождении НЕ ослабляется.',
  ).toBe(target.origin);
});
