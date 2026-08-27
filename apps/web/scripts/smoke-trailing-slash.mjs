#!/usr/bin/env node
/**
 * Смоук правил URL на ЖИВОМ сервере.
 *
 * Юнит-тесты (`tests/unit/web-path-policy.test.ts`) проверяют решение по цели
 * запроса. Этот скрипт проверяет то, что юнит-тестом проверить нельзя: что
 * СЕРВЕР отвечает так же — одним переходом, с пустым телом у 3xx и без
 * `Location`, начинающегося с `//`. Требования — `CLAUDE.md`, разделы «Правила
 * URL» и «HTTP-статусы».
 *
 * ## Почему запрос идёт через node:http, а не через fetch
 *
 * `fetch` разбирает адрес парсером URL, и часть проверяемых форм до сервера не
 * доехала бы в исходном виде: парсер сворачивает dot-сегменты (`/%2e` → `/`) и
 * приводит адрес к нормальному виду. Проверять нужно именно СЫРУЮ цель запроса,
 * потому что ровно её теряли прежние обработчики (находки 1–3 контролёра
 * `url-guard`). `http.request({ path })` отправляет цель байт в байт.
 *
 * ## Почему против собранного сервера
 *
 * В `astro dev` встроенный обработчик Astro при `trailingSlash: 'never'` 301 не
 * отдаёт — показывает страницу-предупреждение со статусом 404 (замерено на
 * astro 7.2.4). Проверять правило слеша на dev-сервере нельзя: проверка упала бы
 * на верном коде.
 *
 * В `pnpm verify` скрипт НЕ входит намеренно: ему нужен собранный сервер, а
 * verify обязан работать на голом репозитории. Запуск:
 *
 *   pnpm --filter @otkritka/web run build
 *   pnpm --filter @otkritka/web run smoke:slash
 *
 * По умолчанию скрипт сам поднимает `dist/server/entry.mjs` и сам его гасит.
 * Против уже поднятого сервера: `SMOKE_BASE_URL=http://127.0.0.1:4321`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serverChildEnv } from './server-child-env.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(appDir, 'dist', 'server', 'entry.mjs');

/**
 * Адрес привязки задан явно, а не оставлен на `localhost`: Node привязывает
 * `localhost` к IPv6-петле (`[::1]`), а инструмент, резолвящий `localhost` в
 * `127.0.0.1`, до сервера не доходит — смоук ложно сообщал бы «сервер не
 * поднялся».
 */
const external = process.env.SMOKE_BASE_URL ?? '';
const externalUrl = external === '' ? null : new URL(external);
const host = externalUrl?.hostname ?? process.env.HOST ?? '127.0.0.1';
const port = Number((externalUrl?.port ?? '') || process.env.PORT || '4321');

/**
 * Ожидания по классам путей. `expect` — обязательный статус, `location` —
 * обязательное значение заголовка (только у 3xx).
 *
 * Про 404 у целей редиректа: контентных маршрутов на этом этапе нет намеренно
 * (`/otkrytki`, `/podborki` — задачи Э3-05…Э3-11; массовое создание URL до
 * готовности контента запрещено п. 23 ТЗ), поэтому по каноническому адресу
 * сервер честно отвечает 404. Проверяется здесь не 200, а ОТСУТСТВИЕ второго
 * перехода.
 *
 * @type {{ path: string, expect: number, location?: string, note: string }[]}
 */
const CASES = [
  { path: '/', expect: 200, note: 'корень — единственное исключение из правила слеша' },
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
    path: '/otkrytki/8-marta/?utm_source=test&from=vk',
    expect: 301,
    location: '/otkrytki/8-marta?utm_source=test&from=vk',
    note: 'query переносится в Location без изменений',
  },
  {
    path: '/otkrytki//',
    expect: 301,
    location: '/otkrytki',
    note: 'повторный слеш в хвосте — один переход сразу в каноническую форму',
  },
  {
    path: '//',
    expect: 301,
    location: '/',
    note: 'корень с двойным слешем: один переход, Location не начинается с //',
  },
  { path: '///', expect: 301, location: '/', note: 'прежняя сборка давала здесь цепочку из трёх' },
  { path: '////', expect: 301, location: '/', note: 'то же: один переход вместо трёх' },
  {
    path: '/%2F',
    expect: 400,
    note: 'прежняя сборка уходила здесь в бесконечный цикл 301 (/%2F и /%2F/)',
  },
  { path: '/%2F/', expect: 400, note: 'вторая половина того же цикла' },
  { path: '/%2f', expect: 400, note: 'регистр процентного кодирования значения не имеет' },
  { path: '/%2e', expect: 400, note: 'dot-сегмент не сворачивается на сервере' },
  { path: '/%2E', expect: 400, note: 'то же в верхнем регистре' },
  {
    path: '/%5Cevil.example',
    expect: 400,
    note: 'обратный слеш — тот же разделитель для парсера URL',
  },
  { path: '/%zz', expect: 400, note: 'битое процентное кодирование не роняет обработчик' },
  {
    path: '/index.html',
    expect: 404,
    note: 'прежняя сборка отдавала здесь 200 с содержимым главной — второй адрес материала',
  },
  { path: '/x.html', expect: 404, note: 'файл заранее отрендеренной страницы адресом не является' },
  { path: '/404.html', expect: 404, note: 'страница 404 недоступна как файл' },
  {
    path: '/404',
    expect: 404,
    note: 'у страницы 404 нет своего адреса: прежняя сборка отдавала здесь 200 с H1 «Страница не найдена»',
  },
  {
    path: '/404/',
    expect: 404,
    note: 'и нормализующего 301 на адрес с 404 тоже нет — прежняя сборка давала 301 → 200',
  },
  {
    path: '/otkrytki//8-marta',
    expect: 404,
    note: 'пустой сегмент внутри пути — 404, а не второй редирект',
  },
  {
    path: '/podborki//prazdniki/',
    expect: 404,
    note: 'пустой сегмент проверяется ДО снятия хвостового слеша: без 301 в никуда',
  },
  {
    path: '//evil.example/otkrytki/',
    expect: 404,
    note: 'ведущий двойной слеш не превращается в Location на чужой хост',
  },
  {
    path: '/robots.txt',
    expect: 404,
    note: 'URL файла не нормализуется: маршрут появится на этапе 4, но редиректа быть не должно',
  },
  { path: '/robots.txt/', expect: 404, note: 'URL файла с завершающим слешем — не адрес' },
  {
    path: '/media/cards/a1b2c3/otkrytka-640.webp',
    expect: 404,
    note: 'URL производной изображения не нормализуется',
  },
  { path: '/admin', expect: 404, note: 'маршруты админки Payload отдаёт apps/cms, не Astro' },
  { path: '/admin/', expect: 404, note: 'и нормализовать их Astro не должен — без Location' },
];

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Один запрос с СЫРОЙ целью. Ни следования за редиректом, ни разбора адреса
 * парсером URL.
 *
 * @param {string} target
 * @returns {Promise<{ status: number, location: string | null, body: string }>}
 */
function requestRaw(target) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method: 'GET', path: target }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          location: res.headers.location ?? null,
          body,
        });
      });
    });
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

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

async function runCases() {
  /** @type {string[]} */
  const failures = [];

  for (const testCase of CASES) {
    const response = await requestRaw(testCase.path);
    const shownLocation = response.location === null ? '' : ` Location: ${response.location}`;
    console.log(`  ${testCase.path} -> ${response.status}${shownLocation}  (${testCase.note})`);

    if (response.status !== testCase.expect) {
      failures.push(
        `${testCase.path}: ожидался ${testCase.expect}, получен ${response.status}${shownLocation}`,
      );
      continue;
    }

    if (!REDIRECT_STATUSES.includes(response.status)) {
      // Инвариант: ответ, не являющийся переходом, не несёт Location. Иначе
      // клиент, который смотрит на заголовок раньше статуса, всё равно уйдёт.
      if (response.location !== null) {
        failures.push(
          `${testCase.path}: статус ${response.status} не переход, но пришёл Location «${response.location}»`,
        );
      }
      continue;
    }

    if (response.location === null) {
      failures.push(`${testCase.path}: переход без Location`);
      continue;
    }

    // Инвариант: Location никогда не начинается с двойного слеша — иначе это
    // адрес ЧУЖОГО хоста, то есть открытый редирект.
    if (response.location.startsWith('//') || !response.location.startsWith('/')) {
      failures.push(
        `${testCase.path}: Location «${response.location}» не является путём на нашем хосте`,
      );
      continue;
    }

    // Инвариант: тело перехода пустое. Шаблон 3xx самого Astro кладёт в
    // `<meta http-equiv="refresh">` адрес-ИСТОЧНИК, то есть отправляет клиента
    // назад; проверка ловит возврат к чужому телу ответа.
    if (response.body !== '') {
      failures.push(
        `${testCase.path}: тело перехода не пусто (${String(response.body.length)} символов). ` +
          'В теле 3xx Astro meta-refresh указывает НАЗАД на источник — это цикл для клиента, ' +
          'который предпочитает его заголовку Location.',
      );
      continue;
    }

    if (testCase.location !== undefined && response.location !== testCase.location) {
      failures.push(
        `${testCase.path}: Location «${response.location}», ожидался «${testCase.location}»`,
      );
      continue;
    }

    // Инвариант: переход ровно один. Цель обязана отвечать сама, а не переходом.
    const followed = await requestRaw(response.location);
    console.log(`      следом ${response.location} -> ${followed.status}`);
    if (REDIRECT_STATUSES.includes(followed.status)) {
      failures.push(
        `${testCase.path}: цепочка переходов — по Location «${response.location}» снова ` +
          `${followed.status} на «${followed.location ?? '—'}»`,
      );
    }
  }

  return failures;
}

async function main() {
  /** @type {import('node:child_process').ChildProcess | null} */
  let server = null;

  if (externalUrl === null) {
    if (!existsSync(serverEntry)) {
      console.error(
        `\n  [x] Не найден ${serverEntry}.\n` +
          '      Сначала соберите приложение: pnpm --filter @otkritka/web run build\n',
      );
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
    console.log(`\nПравила URL против http://${host}:${String(port)}:`);
    const failures = await runCases();

    if (failures.length > 0) {
      console.error('\n  [x] URL_SMOKE: FAILED');
      for (const failure of failures) {
        console.error(`    - ${failure}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(`\n  [v] URL_SMOKE: PASSED (${String(CASES.length)} классов путей)\n`);
  } finally {
    server?.kill();
  }
}

await main();
