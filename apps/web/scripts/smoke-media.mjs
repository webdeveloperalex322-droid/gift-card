#!/usr/bin/env node
/**
 * Смоук отдачи производных `/media/<ключ>` на ЖИВОМ сервере (задача Э2-04b).
 *
 * Юнит-тесты (`tests/unit/web-media-route.test.ts`, `tests/unit/images-media.test.ts`)
 * проверяют решение по пути и форму ключа. Этот скрипт проверяет то, чего
 * юнит-тестом не проверить: НАСТОЯЩИЕ заголовки ответа, отсутствие листинга
 * каталога и недостижимость оригиналов по любому пути под `/media`.
 *
 * Требования, которые здесь замеряются (решение Ч-03, ТЗ §6.1, §6.3, §11):
 *   - `GET`/`HEAD` производной отдают файл с `Cache-Control: public,
 *     max-age=31536000, immutable` и `Content-Type` по расширению;
 *   - каталог не отдаётся ни списком, ни индексным файлом;
 *   - оригиналы недостижимы: ни dot-сегментом, ни процентным кодированием, ни
 *     хорошо сформированным ключом (корень оригиналов — другое дерево, условие C4);
 *   - у адреса файла нет других методов и нет второй формы (завершающий слеш —
 *     не адрес).
 *
 * Запрос идёт через `node:http` с СЫРОЙ целью по той же причине, что в
 * `smoke-trailing-slash.mjs`: `fetch` свернул бы dot-сегменты парсером URL, и до
 * сервера доехала бы уже нормализованная форма, то есть проверялось бы не то.
 *
 * В `pnpm verify` не входит: нужен собранный сервер и файлы на диске. Запуск:
 *
 *   pnpm --filter @otkritka/web run build
 *   pnpm --filter @otkritka/web run smoke:media
 *
 * Скрипт создаёт временные файлы в корнях хранилища и удаляет их за собой —
 * включая пустые каталоги, которые сам создал.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { derivativeCacheHeaders, IMMUTABLE_CACHE_CONTROL } from '@otkritka/images/media';

import { serverChildEnv } from './server-child-env.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appDir, '..', '..');
const serverEntry = path.join(appDir, 'dist', 'server', 'entry.mjs');

const envFile = path.join(repoRoot, '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

/** Корни хранилища — из окружения, без значений по умолчанию (условие C4). */
function requireRoot(name) {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') {
    console.error(`\n  [x] Переменная ${name} не задана: смоуку неоткуда взять корень хранилища.`);
    process.exit(1);
  }
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(repoRoot, raw);
}

const derivativesRoot = requireRoot('IMAGE_STORAGE_DERIVATIVES_ROOT');
const originalsRoot = requireRoot('IMAGE_STORAGE_ORIGINALS_ROOT');

const external = process.env.SMOKE_BASE_URL ?? '';
const externalUrl = external === '' ? null : new URL(external);
const host = externalUrl?.hostname ?? process.env.HOST ?? '127.0.0.1';
const port = Number((externalUrl?.port ?? '') || process.env.PORT || '4321');

/**
 * Ключ производной той же формы, что выдаёт пайплайн:
 * `cards/<revision>/<имя>-<ширина>.<расширение>`. Значения синтетические, но
 * форма — настоящая: её проверяет `assertStorageKey` из общего пакета, и он же
 * применяется к ключам из записей `card-images`.
 */
const KEY = 'cards/e2f04bsm/otkrytka-smoke-e2-04b-640.webp';
const DERIVATIVE_BYTES = Buffer.from('RIFF-smoke-e2-04b-derivative', 'utf8');

/** Оригинал в НЕПУБЛИЧНОМ дереве. Ни один ответ не должен содержать эти байты. */
const ORIGINAL_KEY = 'originals/e2f04bsmoke0000000000000000000.jpg';
const ORIGINAL_MARKER = 'ORIGINAL-MUST-NEVER-BE-SERVED-E2-04B';

const derivativeFile = path.join(derivativesRoot, ...KEY.split('/'));
const originalFile = path.join(originalsRoot, ...ORIGINAL_KEY.split('/'));

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Один запрос с сырой целью.
 *
 * @param {string} target
 * @param {{ method?: string, headers?: Record<string, string> }} [options]
 */
function requestRaw(target, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        headers: options.headers ?? {},
        host,
        method: options.method ?? 'GET',
        path: target,
        port,
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            body: Buffer.concat(chunks),
            headers: res.headers,
            status: res.statusCode ?? 0,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await requestRaw('/');
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error(`Сервер не поднялся на http://${host}:${String(port)}`);
}

/** @type {string[]} */
const failures = [];
let checks = 0;

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function record(name, ok, detail = '') {
  checks += 1;
  console.log(`  ${ok ? '[v]' : '[x]'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) {
    failures.push(`${name}${detail === '' ? '' : ` (${detail})`}`);
  }
}

async function checkDerivativeIsServed() {
  const expected = derivativeCacheHeaders(KEY);
  const response = await requestRaw(`/media/${KEY}`);

  record('GET производной отдаёт 200', response.status === 200, `статус ${response.status}`);
  record(
    'байты ответа совпадают с файлом',
    response.body.equals(DERIVATIVE_BYTES),
    `${String(response.body.length)} байт`,
  );
  record(
    'Cache-Control из контракта хранилища',
    response.headers['cache-control'] === IMMUTABLE_CACHE_CONTROL,
    String(response.headers['cache-control']),
  );
  record(
    'Content-Type по расширению ключа',
    response.headers['content-type'] === expected['Content-Type'],
    String(response.headers['content-type']),
  );
  record(
    'Content-Length задан',
    response.headers['content-length'] === String(DERIVATIVE_BYTES.length),
    String(response.headers['content-length']),
  );

  const etag = response.headers.etag;
  record('ETag задан', typeof etag === 'string' && etag !== '', String(etag));

  const head = await requestRaw(`/media/${KEY}`, { method: 'HEAD' });
  record('HEAD отдаёт 200 без тела', head.status === 200 && head.body.length === 0);
  record(
    'HEAD несёт те же заголовки кеширования',
    head.headers['cache-control'] === IMMUTABLE_CACHE_CONTROL,
    String(head.headers['cache-control']),
  );

  if (typeof etag === 'string') {
    const conditional = await requestRaw(`/media/${KEY}`, { headers: { 'If-None-Match': etag } });
    record(
      'повторный запрос с If-None-Match даёт 304',
      conditional.status === 304 && conditional.body.length === 0,
      `статус ${conditional.status}`,
    );
  }

  const post = await requestRaw(`/media/${KEY}`, { method: 'POST' });
  record('POST на адрес файла — 404, а не 200', post.status === 404, `статус ${post.status}`);

  const withSlash = await requestRaw(`/media/${KEY}/`);
  record(
    'адрес файла со слешем — 404 без Location (второй формы у файла нет)',
    withSlash.status === 404 && withSlash.headers.location === undefined,
    `статус ${withSlash.status}`,
  );
}

async function checkNoListing() {
  const root = await requestRaw('/media');
  record(
    '/media не отдаёт список: 404',
    root.status === 404,
    `статус ${root.status}`,
  );
  record(
    '/media не упоминает имён файлов в теле',
    !root.body.toString('utf8').includes('otkrytka-smoke'),
  );

  const rootSlash = await requestRaw('/media/');
  const location = rootSlash.headers.location;
  record(
    '/media/ — одиночный 301 на /media',
    rootSlash.status === 301 && location === '/media',
    `статус ${rootSlash.status}, Location ${String(location)}`,
  );

  for (const directory of ['/media/cards', '/media/cards/e2f04bsm']) {
    const response = await requestRaw(directory);
    record(
      `${directory} — каталог, а не адрес: 404`,
      response.status === 404,
      `статус ${response.status}`,
    );
    record(
      `${directory} не отдаёт содержимое каталога`,
      !response.body.toString('utf8').includes('otkrytka-smoke'),
    );
  }

  const missing = await requestRaw('/media/cards/e2f04bsm/net-takogo-fayla-640.webp');
  record(
    'несуществующая производная — 404 приложения, а не 200',
    missing.status === 404,
    `статус ${missing.status}`,
  );
}

async function checkOriginalsUnreachable() {
  const attempts = [
    ['/media/../uploads/originals/e2f04bsmoke0000000000000000000.jpg', 400],
    ['/media/cards/../../uploads/originals/e2f04bsmoke0000000000000000000.jpg', 400],
    ['/media/..%2Fuploads%2Foriginals%2Fe2f04bsmoke0000000000000000000.jpg', 400],
    ['/media/%2e%2e/uploads/originals/e2f04bsmoke0000000000000000000.jpg', 400],
    ['/media/..%5Cuploads%5Coriginals%5Ce2f04bsmoke0000000000000000000.jpg', 400],
    // Ключ правильной формы, указывающий в дерево оригиналов: он разрешается
    // ВНУТРИ корня производных, поэтому файла там нет. Это и есть условие C4 —
    // оригиналы недостижимы структурно, а не проверкой пути.
    [`/media/${ORIGINAL_KEY}`, 404],
  ];

  for (const [target, expected] of attempts) {
    const response = await requestRaw(target);
    const leaked = response.body.toString('utf8').includes(ORIGINAL_MARKER);
    record(
      `${target} -> ${String(expected)}`,
      response.status === expected,
      `статус ${response.status}`,
    );
    record(`${target} не отдал байты оригинала`, !leaked);
  }
}

/** Убирает за собой файлы и созданные каталоги. */
async function cleanup() {
  await rm(derivativeFile, { force: true });
  await rm(originalFile, { force: true });
  for (const root of [derivativesRoot, originalsRoot]) {
    for (const file of [derivativeFile, originalFile]) {
      let dir = path.dirname(file);
      while (dir.startsWith(root + path.sep)) {
        try {
          await rmdir(dir);
        } catch {
          break;
        }
        dir = path.dirname(dir);
      }
    }
  }
}

async function main() {
  /** @type {import('node:child_process').ChildProcess | null} */
  let server = null;

  await mkdir(path.dirname(derivativeFile), { recursive: true });
  await mkdir(path.dirname(originalFile), { recursive: true });
  await writeFile(derivativeFile, DERIVATIVE_BYTES);
  await writeFile(originalFile, `${ORIGINAL_MARKER}\n`);

  if (externalUrl === null) {
    if (!existsSync(serverEntry)) {
      console.error(
        `\n  [x] Не найден ${serverEntry}.\n` +
          '      Сначала соберите приложение: pnpm --filter @otkritka/web run build\n',
      );
      await cleanup();
      process.exit(1);
    }
    server = spawn(process.execPath, [serverEntry], {
      cwd: appDir,
      // Окружение конкретного входа собирает `./server-child-env.mjs` — одна
      // точка на все входы, поднимающие собранный сервер. Правки NODE_PATH там
      // больше нет: `drizzle-kit` объявлен зависимостью apps/web, разбор и замер
      // — в шапке того модуля.
      env: serverChildEnv(appDir, { HOST: host, PORT: String(port) }),
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  }

  try {
    await waitForServer();
    console.log(`\nОтдача /media против http://${host}:${String(port)}:`);
    console.log(`  корень производных: ${derivativesRoot}`);
    console.log(`  корень оригиналов:  ${originalsRoot}\n`);

    await checkDerivativeIsServed();
    await checkNoListing();
    await checkOriginalsUnreachable();

    // Файлы на месте: смоук не должен «доказывать» недостижимость тем, что
    // проверяемого файла нет вовсе.
    const stillThere = (await readFile(originalFile, 'utf8')).includes(ORIGINAL_MARKER);
    record('оригинал всё это время лежал на диске', stillThere);

    if (failures.length > 0) {
      console.error(`\n  [x] MEDIA_SMOKE: FAILED (${String(failures.length)} из ${String(checks)})`);
      for (const failure of failures) {
        console.error(`    - ${failure}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(`\n  [v] MEDIA_SMOKE: PASSED (${String(checks)} проверок)\n`);
  } finally {
    server?.kill();
    await cleanup();
  }
}

await main();
