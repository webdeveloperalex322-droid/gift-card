#!/usr/bin/env node
/**
 * Поднимает apps/web для SEO-приёмки: сначала СОБИРАЕТ, потом запускает
 * production-сервер приложения.
 *
 * ## Почему не `astro dev`
 *
 * В dev-режиме при `trailingSlash: 'never'` Astro не отдаёт 301: он показывает
 * страницу-предупреждение со статусом 404 (замерено на astro 7.2.4, отмечено в
 * `apps/web/src/routing/path-policy.ts`). Spec на одиночный 301 упал бы на
 * ВЕРНОМ коде, а это худший вид падения — он учит не верить тестам. Приёмка
 * поэтому идёт только против собранного сервера.
 *
 * ## Почему сборка каждый раз
 *
 * Приёмка обязана проверять текущий код, а не тот, что кто-то собрал вчера.
 * Пропуска сборки флагом здесь нет намеренно: он бы дал зелёный отчёт по
 * устаревшему артефакту — то же самое, что зелёный отчёт по пропущенным тестам.
 *
 * ## Контракт с apps/web
 *
 * Приёмка НЕ знает, как именно приложение поднимает сервер, и знать не должна:
 * это внутреннее устройство слоя `astro-web`, и оно уже менялось — standalone-адаптер
 * сменился на `mode: 'middleware'` со своим тонким Node-сервером, а вместе с ним
 * сменился и путь до точки входа. Контракт узкий и держится на двух скриптах в
 * `apps/web/package.json`:
 *
 *   - `build` — собирает всё, что нужно серверу;
 *   - `start` — поднимает production-сервер, читая `HOST`, `PORT` и `SITE_URL`
 *     из окружения.
 *
 * Пока `start` есть, приёмка переживает любую перестройку внутренностей. Если
 * его нет, используется прежний путь (импорт standalone-точки входа), и при
 * неудаче печатается ровно то, что нужно добавить, — а не «сервер не поднялся».
 *
 * Значений по умолчанию для `SITE_URL`, `HOST` и `PORT` здесь нет: подставленный
 * хост означал бы canonical, собранный не на том хосте, против которого гоняется
 * приёмка.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const webPackageJson = fileURLToPath(new URL('../../../apps/web/package.json', import.meta.url));
const standaloneEntry = fileURLToPath(
  new URL('../../../apps/web/dist/server/entry.mjs', import.meta.url),
);

/** @param {string[]} args */
function run(args) {
  const label = `pnpm ${args.join(' ')}`;
  console.log(`[seo-acceptance] ${label}`);
  const result = spawnSync('pnpm', args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });
  if (result.status !== 0) {
    console.error(`[seo-acceptance] «${label}» завершилась с кодом ${String(result.status)}.`);
    console.error('[seo-acceptance] Приёмка гоняется только против собранного сервера, поэтому');
    console.error('[seo-acceptance] дальше идти нельзя: это был бы прогон по старому артефакту.');
    process.exit(1);
  }
}

/** Есть ли в apps/web скрипт `start` — контракт подъёма сервера. */
function hasStartScript() {
  try {
    /** @type {{ scripts?: Record<string, string> }} */
    const manifest = JSON.parse(readFileSync(webPackageJson, 'utf8'));
    const start = manifest.scripts?.start;
    return typeof start === 'string' && start.trim() !== '';
  } catch {
    return false;
  }
}

for (const key of ['SITE_URL', 'HOST', 'PORT']) {
  if ((process.env[key] ?? '').trim() === '') {
    console.error(
      `[seo-acceptance] Переменная ${key} не задана. Этот скрипт запускается конфигом ` +
        'tests/seo/playwright.config.ts, который задаёт её сам; вручную его звать не нужно.',
    );
    process.exit(1);
  }
}

const baseUrl = `http://${process.env.HOST}:${process.env.PORT}`;

// Собираются РОВНО те пакеты, которые нужны серверу apps/web. Корневой
// `build:libs` (`tsc -b tsconfig.json`) собрал бы ещё и проект `tests/`, и
// тогда ошибка типов в чужом юнит-тесте не давала бы даже стартовать
// SEO-приёмке — то есть приёмка молчала бы о состоянии сайта по причине, к
// сайту не относящейся. Типы всего монорепозитория проверяет `pnpm check`, и он
// входит в `pnpm verify` перед `test:seo`.
run(['exec', 'tsc', '-b', 'packages/shared', 'packages/images']);
run(['--filter', '@otkritka/web', 'run', 'build']);

console.log(
  `[seo-acceptance] старт собранного сервера на ${baseUrl}, SITE_URL=${process.env.SITE_URL}`,
);

if (hasStartScript()) {
  const child = spawn('pnpm', ['--filter', '@otkritka/web', 'run', 'start'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });

  process.on('exit', () => {
    if (child.exitCode === null) {
      child.kill();
    }
  });
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));

  child.on('exit', (code) => {
    process.exit(code ?? 1);
  });
} else {
  // Прежний путь: standalone-точка входа адаптера сама вызывает `startServer()`
  // на верхнем уровне, поэтому `import()` поднимает сервер В ЭТОМ процессе.
  if (!existsSync(standaloneEntry)) {
    console.error(
      `[seo-acceptance] Ни скрипта «start» в apps/web/package.json, ни ${standaloneEntry}.\n` +
        '[seo-acceptance] Приёмке нужен один контракт подъёма сервера — скрипт «start» в\n' +
        '[seo-acceptance] apps/web/package.json, поднимающий production-сервер по HOST и PORT\n' +
        '[seo-acceptance] из окружения. Владелец слоя: astro-web.',
    );
    process.exit(1);
  }

  await import(pathToFileURL(standaloneEntry).href);

  let listening = false;
  for (let attempt = 0; attempt < 20 && !listening; attempt += 1) {
    try {
      await fetch(baseUrl, { redirect: 'manual' });
      listening = true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!listening) {
    console.error(
      `[seo-acceptance] ${standaloneEntry} импортирован, но сервер на ${baseUrl} не слушает.\n` +
        '[seo-acceptance] Так бывает, когда адаптер собран в mode: "middleware" — такая точка\n' +
        '[seo-acceptance] входа экспортирует обработчик и сама сервер не поднимает. Нужен\n' +
        '[seo-acceptance] скрипт «start» в apps/web/package.json. Владелец слоя: astro-web.',
    );
    process.exit(1);
  }
}
