/**
 * Конфигурация SEO-приёмки. Именно этот файл зовёт шлюз `scripts/seo-gate.mjs`
 * (`pnpm exec playwright test --config=tests/seo/playwright.config.ts`), поэтому
 * контракт с ним держится здесь:
 *   - шлюз печатает `SEO_ACCEPTANCE: SKIPPED`, пока нет spec-файлов или не задан
 *     `BASE_URL`. Пропуск не равен прохождению;
 *   - ненулевой код выхода Playwright шлюз превращает в `FAILED`;
 *   - нулевой — в `PASSED`.
 *
 * Отсюда правило: любая проблема окружения обязана давать ненулевой код, а не
 * тихо уменьшать число проверок. Поэтому здесь нет ни `testIgnore`, ни
 * `grep`-фильтров, ни условных пропусков, а `BASE_URL` разбирается на этапе
 * загрузки конфига — некорректное значение валит запуск с внятной ошибкой.
 *
 * Корневой `.env` подмешивается тем же способом, что и в apps/web
 * (`process.loadEnvFile` не перезаписывает уже заданные переменные, поэтому
 * `BASE_URL=... pnpm test:seo` из командной строки сильнее файла). Нужен он ради
 * `PAYLOAD_ADMIN_PATH`: приёмка проверяет, что Astro не обслуживает маршруты
 * админки, и путь обязана брать из того же источника, что и код, а не из
 * зашитой строки `/admin`.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig } from '@playwright/test';

import { resolveAcceptanceTarget } from './support/target.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const envFile = fileURLToPath(new URL('../../.env', import.meta.url));

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const target = resolveAcceptanceTarget();

/**
 * Сервер приёмки. Поднимается собранный (`astro build` + standalone entry) —
 * причина в `support/serve-built-web.mjs`.
 *
 * `SITE_URL` передаётся равным origin BASE_URL: `CLAUDE.md`, раздел
 * «SEO-тесты», требует, чтобы на окружении приёмки эти хосты совпадали. Это
 * настройка ОКРУЖЕНИЯ, а не ослабление проверки: spec сравнивает абсолютный
 * canonical целиком, и расхождение хостов всё равно проверяется на живом ответе
 * (`environment-hosts-match.spec.ts`) — иначе режим `SEO_REUSE_SERVER=1`
 * оставался бы без контроля.
 */
const webServer = {
  command: 'node tests/seo/support/serve-built-web.mjs',
  cwd: repoRoot,
  url: target.origin,
  // Переиспользование чужого сервера по умолчанию запрещено: на этом же порту
  // легко оказаться `astro dev` (он не отдаёт 301 при trailingSlash: 'never') или
  // сборке с другим SITE_URL, и приёмка проверила бы не то, что думает.
  reuseExistingServer: false,
  // Сборка packages/shared и packages/images + astro build + старт. Запас взят
  // с учётом холодного tsc.
  timeout: 240_000,
  stdout: 'pipe' as const,
  stderr: 'pipe' as const,
  env: {
    HOST: target.serverHost,
    PORT: String(target.serverPort),
    SITE_URL: target.origin,
  },
};

export default defineConfig({
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  outputDir: fileURLToPath(new URL('../../test-results/seo/', import.meta.url)),
  fullyParallel: true,
  // Повторов нет намеренно: SEO-проверки детерминированы (статус, заголовок,
  // разметка). Повтор здесь не лечил бы флаки, а прятал бы настоящую нестабильность
  // ответа сервера — то есть проблему, о которой обязан узнать владелец слоя.
  retries: 0,
  // `.only`, забытый в коммите, тихо сокращает приёмку до одного теста, а отчёт
  // остаётся зелёным. Это ровно тот ложный зелёный статус, которого здесь быть
  // не должно.
  forbidOnly: true,
  // Бюджет на тест. Запросов в тесте единицы, поэтому запас идёт на холодный
  // ответ сервера, а не на ожидание. Тесты, которым нужен браузер, поднимают
  // свой бюджет локально: там в него попадает первый запуск chromium.
  timeout: 45_000,
  // Ожидание УТВЕРЖДЕНИЯ короткое и общее для всех: длинный expect-таймаут
  // прятал бы «контент дорисовался позже», а это ровно то, что проверяется.
  expect: { timeout: 5_000 },
  // Только `list`. HTML-отчёт Playwright кладёт в репозиторий собственные
  // бандлы браузерного JS, и корневой `eslint .` начинает их линтовать: ~1000
  // ошибок `no-undef` в чужом коде, из-за которых падает `pnpm check`. Добавить
  // каталог в игнор eslint значило бы править корневой конфиг — чужую зону.
  // Разбор упавшего теста и без HTML-отчёта полный: сообщение печатает `list`,
  // а трассировка сохраняется в `test-results/seo/` и открывается командой
  // `pnpm exec playwright show-trace <путь к trace.zip>`.
  reporter: [['list']],
  use: {
    baseURL: target.origin,
    trace: 'retain-on-failure',
  },
  ...(target.reuseExistingServer ? {} : { webServer }),
});
