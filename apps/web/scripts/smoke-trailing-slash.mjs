#!/usr/bin/env node
/**
 * Смоук правила завершающего слеша на ЖИВОМ сервере (задача Э3-01).
 *
 * Юнит-тесты в `tests/unit/web-path-policy.test.ts` проверяют решение по пути.
 * Этот скрипт проверяет то, что юнит-тестом проверить нельзя: что сервер
 * действительно отвечает ОДНИМ 301 и что переход по `Location` даёт 200, то есть
 * цепочки нет. Требование «одиночный 301, цепочки редиректов запрещены» —
 * `CLAUDE.md`, разделы «Правила URL» и «HTTP-статусы».
 *
 * В `pnpm verify` скрипт НЕ входит намеренно: ему нужен собранный сервер
 * (`pnpm --filter @otkritka/web run build`), а verify обязан работать на голом
 * репозитории. Запуск:
 *
 *   pnpm --filter @otkritka/web run build
 *   pnpm --filter @otkritka/web run smoke:slash
 *
 * По умолчанию скрипт сам поднимает `dist/server/entry.mjs` и сам его гасит.
 * Против уже поднятого сервера: `SMOKE_BASE_URL=http://localhost:4321`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(appDir, 'dist', 'server', 'entry.mjs');
const port = Number(process.env.PORT ?? '4321');
/**
 * Адрес привязки задан явно, а не оставлен на `localhost`: адаптер в этом случае
 * слушает только IPv6-петлю (`[::1]`), а `localhost` на Windows разрешается
 * сначала в `127.0.0.1` — запрос уходит в никуда, и смоук ложно сообщает «сервер
 * не поднялся». Переменную читает сам адаптер
 * (`@astrojs/node/dist/standalone.js`, `process.env.HOST`).
 */
const host = process.env.HOST ?? '127.0.0.1';
const externalBaseUrl = process.env.SMOKE_BASE_URL ?? '';

/**
 * Ожидания.
 *   - `expect` — обязательный статус ответа;
 *   - `location` — обязательное значение заголовка Location (только у 301).
 *
 * Про 404 у целей редиректа. Контентных маршрутов на этой задаче не создано
 * намеренно (`/otkrytki`, `/podborki` — задачи Э3-05…Э3-11; массовое создание
 * URL до готовности контента запрещено п. 23 ТЗ), поэтому по каноническому
 * адресу сервер честно отвечает 404. Проверяется здесь не 200, а ОТСУТСТВИЕ
 * второго перехода: цель редиректа обязана не быть 3xx. Именно это и означает
 * «цепочки нет».
 * @type {{ path: string, expect: number, location?: string, note: string }[]}
 */
const CASES = [
  { path: '/', expect: 200, note: 'корень — единственное исключение из правила' },
  {
    path: '/otkrytki/8-marta/',
    expect: 301,
    location: '/otkrytki/8-marta',
    note: 'маршрут страницы со слешем',
  },
  {
    path: '/podborki/prazdniki/8-marta/page/2/',
    expect: 301,
    location: '/podborki/prazdniki/8-marta/page/2',
    note: 'пагинация со слешем',
  },
  {
    path: '/otkrytki//',
    expect: 301,
    location: '/otkrytki',
    note: 'повторный слеш в конце — один редирект сразу в каноническую форму',
  },
  {
    path: '/podborki//prazdniki///8-marta/',
    expect: 301,
    location: '/podborki//prazdniki///8-marta',
    note: 'повторные слеши в середине: один 301 по правилу Astro, дальше 404 без второго шага',
  },
  {
    path: '/otkrytki//8-marta',
    expect: 404,
    note: 'пустой сегмент внутри пути — 404, а не второй редирект',
  },
  {
    path: '/robots.txt',
    expect: 404,
    note: 'URL файла не нормализуется: маршрут появится на этапе 4, но редиректа быть не должно',
  },
  {
    path: '/media/cards/a1b2c3/otkrytka-640.webp',
    expect: 404,
    note: 'URL производной изображения не нормализуется',
  },
];

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {string} baseUrl */
async function waitForServer(baseUrl) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(baseUrl, { redirect: 'manual' });
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error(`Сервер не поднялся на ${baseUrl}`);
}

/** @param {string} baseUrl */
async function runCases(baseUrl) {
  /** @type {string[]} */
  const failures = [];

  for (const testCase of CASES) {
    const response = await fetch(`${baseUrl}${testCase.path}`, { redirect: 'manual' });
    const location = response.headers.get('location');
    console.log(
      `  ${testCase.path} -> ${response.status}${location ? ` Location: ${location}` : ''}  (${testCase.note})`,
    );

    if (response.status !== testCase.expect) {
      failures.push(`${testCase.path}: ожидался ${testCase.expect}, получен ${response.status}`);
      continue;
    }
    if (testCase.location === undefined) {
      continue;
    }
    if (location !== testCase.location) {
      failures.push(`${testCase.path}: Location «${location ?? '—'}», ожидался «${testCase.location}»`);
      continue;
    }

    // Проверка отсутствия цепочки: цель редиректа обязана не быть 3xx.
    const followed = await fetch(`${baseUrl}${location}`, { redirect: 'manual' });
    console.log(`      следом ${location} -> ${followed.status}`);
    if (followed.status >= 300 && followed.status < 400) {
      failures.push(
        `${testCase.path}: цепочка редиректов — по Location «${location}» снова ${followed.status} ` +
          `на «${followed.headers.get('location') ?? '—'}»`,
      );
    }
  }

  return failures;
}

async function main() {
  /** @type {import('node:child_process').ChildProcess | null} */
  let server = null;
  let baseUrl = externalBaseUrl;

  if (baseUrl === '') {
    if (!existsSync(serverEntry)) {
      console.error(
        `\n  ✗ Не найден ${serverEntry}.\n` +
          '    Сначала соберите приложение: pnpm --filter @otkritka/web run build\n',
      );
      process.exit(1);
    }
    baseUrl = `http://${host}:${String(port)}`;
    server = spawn(process.execPath, [serverEntry], {
      cwd: appDir,
      env: { ...process.env, HOST: host, PORT: String(port) },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  }

  try {
    await waitForServer(baseUrl);
    console.log(`\nПравило завершающего слеша против ${baseUrl}:`);
    const failures = await runCases(baseUrl);

    if (failures.length > 0) {
      console.error('\n  ✗ TRAILING_SLASH_SMOKE: FAILED');
      for (const failure of failures) {
        console.error(`    - ${failure}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log('\n  ✓ TRAILING_SLASH_SMOKE: PASSED\n');
  } finally {
    server?.kill();
  }
}

await main();
