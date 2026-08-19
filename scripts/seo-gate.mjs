#!/usr/bin/env node
/**
 * Шлюз SEO-приёмки (`pnpm test:seo`).
 *
 * Приёмочные тесты из `tests/seo/` требуют работающего сайта. Пока сайта нет,
 * шлюз печатает ЯВНЫЙ ПРОПУСК и выходит с кодом 0, чтобы `pnpm verify` был
 * зелёным на скелете. Пропуск — не прохождение: в отчёте о завершении задачи
 * статус переносится дословно.
 *
 * Как только apps/web поднимается, задайте адрес и тесты станут обязательными:
 *   BASE_URL=http://localhost:4321 pnpm test:seo
 */
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const seoDir = join(root, 'tests', 'seo');

const specs = existsSync(seoDir)
  ? readdirSync(seoDir).filter((f) => f.endsWith('.spec.ts') || f.endsWith('.spec.js'))
  : [];

const baseUrl = process.env.BASE_URL ?? '';

function skip(reason) {
  console.log(`\nSEO_ACCEPTANCE: SKIPPED — ${reason}`);
  console.log('  Пропуск не равен прохождению. Переносите этот статус в отчёт дословно.');
  console.log('  Снять пропуск: поднять apps/web и задать BASE_URL.\n');
  process.exit(0);
}

if (specs.length === 0) {
  skip('в tests/seo/ нет ни одного spec-файла');
}

if (!baseUrl) {
  skip(`BASE_URL не задан (найдено spec-файлов: ${specs.length})`);
}

const playwright = spawnSync('pnpm', ['exec', 'playwright', 'test', '--config=tests/seo/playwright.config.ts'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: process.env,
});

if (playwright.status !== 0) {
  console.error('\nSEO_ACCEPTANCE: FAILED');
  console.error('  Приёмка SEO — блокирующая. Задача не считается выполненной.');
  console.error('  Если Playwright не установлен, его ставит агент seo-auditor:');
  console.error('    pnpm add -D -w @playwright/test && pnpm exec playwright install chromium\n');
  process.exit(playwright.status ?? 1);
}

console.log(`\nSEO_ACCEPTANCE: PASSED — ${baseUrl}\n`);
