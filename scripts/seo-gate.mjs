#!/usr/bin/env node
/**
 * Шлюз SEO-приёмки (`pnpm test:seo`).
 *
 * Приёмочные тесты из `tests/seo/` требуют работающего сайта. Пока сайта не
 * было, шлюз печатал ЯВНЫЙ ПРОПУСК и выходил с кодом 0, чтобы `pnpm verify` был
 * зелёным на скелете. Пропуск — не прохождение: в отчёте о завершении задачи
 * статус переносится дословно.
 *
 * ИЗМЕНЕНО НА ЭТАПЕ 3 (после вердикта `seo-auditor` на Э3-14): `apps/web`
 * поднимается, spec-файлы существуют, поэтому «BASE_URL не задан» перестало
 * быть законной причиной пропуска и стало ОТКАЗОМ. Причина: при пропуске по
 * незаданной переменной `pnpm verify` оставался зелёным, ничего не проверив, —
 * а это ровно тот ложный зелёный, который в этом проекте дороже упавшего теста.
 *
 * Адрес берётся из окружения, а при его отсутствии — из `.env` в корне
 * монорепозитория (файл не в репозитории, значение локальное). Значения по
 * умолчанию у адреса нет намеренно: хост не подставляется ни здесь, ни в
 * продуктовом коде.
 *
 *   BASE_URL=http://127.0.0.1:4321 pnpm test:seo
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const seoDir = join(root, 'tests', 'seo');

const specs = existsSync(seoDir)
  ? readdirSync(seoDir).filter((f) => f.endsWith('.spec.ts') || f.endsWith('.spec.js'))
  : [];

/**
 * Читает одну переменную из `.env` в корне. Полноценный парсер здесь не нужен и
 * вреден: чем меньше шлюз умеет, тем меньше в нём мест разойтись с тем, как
 * окружение читают `apps/cms` и `apps/web`.
 */
function fromEnvFile(name) {
  const envFile = join(root, '.env');
  if (!existsSync(envFile)) return '';
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && match[1] === name) return match[2].trim();
  }
  return '';
}

const baseUrl = process.env.BASE_URL || fromEnvFile('BASE_URL');

function skip(reason) {
  console.log(`\nSEO_ACCEPTANCE: SKIPPED — ${reason}`);
  console.log('  Пропуск не равен прохождению. Переносите этот статус в отчёт дословно.');
  process.exit(0);
}

function fail(reason, hints) {
  console.error(`\nSEO_ACCEPTANCE: FAILED — ${reason}`);
  console.error('  Приёмка SEO — блокирующая. Задача не считается выполненной.');
  for (const hint of hints) console.error(`  ${hint}`);
  console.error('');
  process.exit(1);
}

if (specs.length === 0) {
  // Остаётся единственной законной причиной пропуска: проверять физически нечем.
  skip('в tests/seo/ нет ни одного spec-файла');
}

if (!baseUrl) {
  fail(`BASE_URL не задан (найдено spec-файлов: ${specs.length})`, [
    'Сайт поднимается, spec-файлы есть — значит пропуск скрыл бы непроверенную приёмку.',
    'Задайте адрес в окружении или строкой BASE_URL=... в .env в корне репозитория.',
    'Приёмка гоняется против СОБРАННОГО сервера: в astro dev правило слеша ведёт себя иначе.',
  ]);
}

const playwright = spawnSync('pnpm', ['exec', 'playwright', 'test', '--config=tests/seo/playwright.config.ts'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, BASE_URL: baseUrl },
});

if (playwright.status !== 0) {
  fail(`прогон против ${baseUrl} не прошёл`, [
    'Если Playwright не установлен, его ставит агент seo-auditor:',
    '  pnpm add -D -w @playwright/test && pnpm exec playwright install chromium',
  ]);
}

console.log(`\nSEO_ACCEPTANCE: PASSED — ${baseUrl}\n`);
