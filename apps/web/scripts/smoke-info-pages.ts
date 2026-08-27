/**
 * Смоук служебных страниц, настоящей 404 и режима обслуживания на СОБРАННОМ
 * сервере (задача Э3-11).
 *
 * ## Что здесь проверяется и почему только здесь
 *
 * Юнит-тесты доказывают свойства ЗНАЧЕНИЙ: обе ветки конъюнкции Ч-23, поведение
 * при пустом глобале, тело и заголовки 503, выключенный по умолчанию режим
 * обслуживания. Они не доказывают того, что проверяет этот скрипт:
 *
 *   - что служебная страница действительно ОТДАЁТСЯ: 200 и с заполненным
 *     текстом, и с пустым глобалом;
 *   - что текст из глобала приехал в HTML-ответе СЕРВЕРА, без выполнения JS
 *     (`node:http` скриптов не исполняет вовсе, поэтому проверка честная);
 *   - что self-canonical абсолютный и совпадает с адресом запроса, а `<h1>` ровно
 *     один;
 *   - что страница 404 у сайта ОДНА: тело совпадает у четырёх разных путей, по
 *     которым 404 приходит из разных мест кода (политика пути, маршрут админки,
 *     SSR-маршрут с пустым телом, форма номера страницы);
 *   - что в режиме обслуживания 503 с `Retry-After` приходит на ЛЮБОЙ класс
 *     адреса, включая неканоническую форму (то есть 301 не выдаётся) и файл в
 *     `/media`.
 *
 * ## Запуск
 *
 *   pnpm --filter @otkritka/web run build
 *   pnpm --filter @otkritka/web run smoke:info
 *
 * ## Про временные данные и уборку
 *
 * Скрипт правит ОДНУ запись — глобал настроек, — и правит в ней только ТЕКСТЫ
 * служебных страниц (`infoPages.*.title|h1|metaDescription|body`). Прежнее
 * значение группы читается до правки и возвращается в `finally`; итог печатается
 * числами, и несовпадение восстановленного значения с исходным даёт ненулевой код
 * выхода. Записей в `cards` и `collections` смоук не создаёт вовсе, поэтому и
 * публиковать ему нечего.
 *
 * ЧЕГО СКРИПТ НЕ ДЕЛАЕТ НИКОГДА: не трогает выключатель `allowIndexing`. Это
 * решение человека об индексации (п. 7.1 и п. 23 ТЗ), и «временно включить, потом
 * вернуть» здесь не годится — оборванный прогон оставил бы выключатель включённым,
 * то есть агент открыл бы страницу в индекс. Поэтому ветка Ч-23 «выключатель
 * включён И текст есть → index,follow» проверяется юнит-тестом
 * (`tests/unit/web-info-pages.test.ts`), а живой сервер проверяется в том
 * состоянии, в котором он и находится: текст есть, выключатель выключен, значит
 * `noindex,follow`.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { inspect } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Payload } from 'payload';

import {
  INFO_PAGE_KEYS,
  INFO_PAGE_MIN_TEXT_LENGTH,
  INFO_PAGE_PATHS,
  SITE_SETTINGS_SLUG,
} from '@otkritka/shared';

import { payloadClient } from '../src/data/index.js';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(appDir, 'dist', 'server', 'entry.mjs');

const HOST = '127.0.0.1';
const PORT = Number(process.env['SMOKE_INFO_PORT'] ?? '4601');
const ORIGIN = `http://${HOST}:${String(PORT)}`;

/** Значение `Retry-After`, которое смоук задаёт серверу режима обслуживания. */
const RETRY_AFTER = 90;

interface Check {
  readonly detail: string;
  readonly name: string;
  readonly ok: boolean;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail = ''): void {
  checks.push({ detail, name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Итог уборки. Считается один раз, читается на верхнем уровне. */
interface CleanupOutcome {
  /** Тексты глобала возвращены и следов смоука в нём нет. */
  readonly clean: boolean;
}

let outcomeValue: CleanupOutcome | null = null;

/**
 * Чтение итога ФУНКЦИЕЙ: присваивание живёт внутри вложенной функции, и анализ
 * потока управления TypeScript на верхнем уровне модуля сузил бы переменную до
 * `never` после проверки на `null`.
 */
function readOutcome(): CleanupOutcome | null {
  return outcomeValue;
}

/**
 * Ждёт, пока stdout уйдёт в дескриптор: `process.exit` очередь вывода не
 * дожидается, а перехваченный stdout на Windows — конвейер, и теряются именно
 * последние строки.
 */
function flushStdout(): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write('', () => {
      resolve();
    });
  });
}

interface RawResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/**
 * Один запрос СЫРОЙ целью через `node:http`.
 *
 * Не `fetch`: тот сворачивает путь парсером URL, и до сервера доехала бы уже
 * нормализованная форма — то есть проверялось бы не то (та же причина, что в
 * `smoke-pages.ts`).
 */
function request(port: number, target: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, method: 'GET', path: target, port }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
          status: res.statusCode ?? 0,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForServer(port: number): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      await request(port, '/');
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error(`Сервер не поднялся на http://${HOST}:${String(port)}`);
}

function tags(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((match) => match[0]);
}

function attr(tag: string, name: string): string | null {
  const quoted = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return quoted === null ? null : (quoted[1] ?? null);
}

function canonicalOf(html: string): string | null {
  const link = tags(html, 'link').find((tag) => attr(tag, 'rel') === 'canonical');
  return link === undefined ? null : attr(link, 'href');
}

function metaOf(html: string, name: string): string | null {
  const tag = tags(html, 'meta').find((candidate) => attr(candidate, 'name') === name);
  return tag === undefined ? null : attr(tag, 'content');
}

function headings(html: string): string[] {
  return [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((match) =>
    (match[1] ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/gu, ' ').trim(),
  );
}

function anchors(html: string): (string | null)[] {
  return tags(html, 'a').map((tag) => attr(tag, 'href'));
}

/** Видимый текст: теги и содержимое `<style>`/`<script>` выброшены. */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Лексический документ с одним абзацем — так же, как его хранит Payload. */
function lexical(text: string): Record<string, unknown> {
  return {
    root: {
      type: 'root',
      direction: 'ltr',
      format: '',
      indent: 0,
      version: 1,
      children: [
        {
          type: 'paragraph',
          direction: 'ltr',
          format: '',
          indent: 0,
          version: 1,
          children: [
            { type: 'text', detail: 0, format: 0, mode: 'normal', style: '', text, version: 1 },
          ],
        },
      ],
    },
  };
}

/**
 * Тексты, которыми смоук наполняет три страницы.
 *
 * Написаны по одной на страницу и содержат узнаваемую метку прогона: по ней
 * проверяется, что в ответе сервера именно ЭТОТ текст, а не что-нибудь похожее.
 *
 * Длина не меньше порога Ч-23 ({@link INFO_PAGE_MIN_TEXT_LENGTH}) — и это не
 * подгонка, а условие проверяемого состояния: при более коротком тексте страница
 * считается НЕ наполненной, печатает заглушку и остаётся `noindex`. Первый прогон
 * смоука упал ровно на этом (тексты были короче порога), и падение было
 * справедливым: проверка «заглушки нет» на ненаполненной странице требовала
 * невозможного. Добивка идёт осмысленным предложением, а не повтором символа:
 * текст читает разбор lexical, и он же попадает в видимый ответ.
 */
const MARK = 'SMOKE-E3-11';

const FILLER =
  ' Этот абзац существует только на время прогона смоука: он проверяет, что текст из глобала ' +
  'настроек попадает в HTML-ответ сервера целиком и без выполнения JavaScript, что разбор ' +
  'lexical-документа доходит до видимой разметки, и что длина текста превышает порог решения ' +
  'Ч-23 — иначе страница считалась бы ненаполненной и печатала бы заглушку вместо текста. ' +
  'Сразу после проверок исходное значение группы возвращается на место.';

function fixtureText(subject: string): string {
  const text = `Смоук Э3-11 (${MARK}): временный текст ${subject}.${FILLER}`;
  if (text.length < INFO_PAGE_MIN_TEXT_LENGTH) {
    throw new Error(
      `Фикстура текста короче порога Ч-23: ${String(text.length)} < ` +
        `${String(INFO_PAGE_MIN_TEXT_LENGTH)}. Такой текст не считается наполнением, страница ` +
        'осталась бы заглушкой, и проверка «заглушки нет» падала бы на верном коде.',
    );
  }
  return text;
}

const FIXTURE_TEXTS: Readonly<Record<(typeof INFO_PAGE_KEYS)[number], string>> = {
  about: fixtureText('страницы о проекте'),
  contacts: fixtureText('страницы контактов'),
  terms: fixtureText('условий использования'),
};

async function main(): Promise<void> {
  const payload: Payload = await payloadClient();

  const admins = await payload.find({
    collection: 'users',
    limit: 1,
    where: { role: { equals: 'admin' } },
  });
  const adminDoc = admins.docs[0];
  if (adminDoc === undefined) {
    throw new Error('В базе нет администратора: запустите CMS один раз, чтобы создался первый.');
  }
  const asAdmin = {
    overrideAccess: false as const,
    user: { ...adminDoc, collection: 'users' as const },
  };

  // Исходное значение читается ЦЕЛИКОМ и правами администратора: группа аудита у
  // глобала закрыта на уровне поля, и восстановление обязано вернуть ровно то,
  // что было.
  const before = await payload.findGlobal({ slug: SITE_SETTINGS_SLUG, depth: 0, ...asAdmin });
  const originalInfoPages = structuredClone(before.infoPages ?? {});
  console.log('Исходные тексты служебных страниц прочитаны и будут возвращены в finally.');

  let server: ReturnType<typeof spawn> | null = null;
  let maintenanceServer: ReturnType<typeof spawn> | null = null;

  /**
   * Уборка выполняется ровно один раз — из `finally` штатного пути ИЛИ из
   * обработчика сигнала. Обещание запоминается ДО разрешения: сигнал посреди
   * штатной уборки ждёт её же.
   */
  let cleanupStarted: Promise<CleanupOutcome> | null = null;
  const cleanupOnce = (): Promise<CleanupOutcome> => {
    cleanupStarted ??= runCleanup();
    return cleanupStarted;
  };

  /**
   * УБОРКА ПО СИГНАЛУ. `finally` при `Ctrl+C` не исполняется, а этот смоук
   * ПОДМЕНЯЕТ тексты служебных страниц в глобале: без обработчика прерванный
   * прогон оставлял бы на локальном сайте страницы с пометкой смоука.
   */
  const onSignal = (signal: NodeJS.Signals): void => {
    void (async (): Promise<void> => {
      console.log(`\nПрогон прерван сигналом ${signal}: выполняется уборка, дождитесь её конца.`);
      await cleanupOnce();
      await flushStdout();
      process.exit(1);
    })();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, onSignal);
  }

  try {
    /* ------------------------------------------------------------ */
    /* Наполнение: только ТЕКСТЫ, выключатель не трогаем            */
    /* ------------------------------------------------------------ */

    const filled: Record<string, unknown> = {};
    for (const key of INFO_PAGE_KEYS) {
      const previous = (originalInfoPages as Record<string, Record<string, unknown> | undefined>)[
        key
      ];
      filled[key] = {
        // Выключатель переносится ИЗ ИСХОДНОГО значения, а не задаётся: решение об
        // индексации принимает человек, и смоук его не меняет ни в одну сторону.
        allowIndexing: previous?.['allowIndexing'] ?? false,
        body: lexical(FIXTURE_TEXTS[key]),
        h1: `Смоук Э3-11: заголовок ${key}`,
        metaDescription: `Смоук Э3-11: описание страницы ${key} (${MARK}).`,
        title: `Смоук Э3-11: title ${key}`,
      };
    }

    await payload.updateGlobal({
      slug: SITE_SETTINGS_SLUG,
      data: { infoPages: filled },
      ...asAdmin,
    });

    /* ------------------------------------------------------------ */
    /* Обычный сервер                                               */
    /* ------------------------------------------------------------ */

    server = spawn(process.execPath, [serverEntry], {
      cwd: appDir,
      env: { ...process.env, HOST, PORT: String(PORT), SITE_URL: ORIGIN },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitForServer(PORT);
    console.log(`\nПроверки против ${ORIGIN}\n`);

    for (const key of INFO_PAGE_KEYS) {
      const target = INFO_PAGE_PATHS[key];
      const response = await request(PORT, target);
      const html = response.body;

      record(
        `${target}: 200 с заполненным текстом`,
        response.status === 200,
        `статус=${String(response.status)}`,
      );
      record(
        `${target}: текст из глобала приехал в HTML-ответе СЕРВЕРА`,
        visibleText(html).includes(FIXTURE_TEXTS[key]),
      );
      record(
        `${target}: ровно один <h1>, и это заголовок из записи`,
        headings(html).length === 1 && headings(html)[0] === `Смоук Э3-11: заголовок ${key}`,
        `h1=${JSON.stringify(headings(html))}`,
      );
      record(
        `${target}: title и description из записи`,
        html.includes(`<title>Смоук Э3-11: title ${key}</title>`) &&
          metaOf(html, 'description') ===
            `Смоук Э3-11: описание страницы ${key} (${MARK}).`,
      );
      record(
        `${target}: абсолютный self-canonical на себя`,
        canonicalOf(html) === `${ORIGIN}${target}`,
        `canonical=${String(canonicalOf(html))}`,
      );
      // Директива — та, что решил человек. Выключатель смоук не менял, поэтому
      // ожидается ровно текущее состояние выключателя в базе.
      const previous = (originalInfoPages as Record<string, Record<string, unknown> | undefined>)[
        key
      ];
      const expectedRobots =
        previous?.['allowIndexing'] === true ? 'index,follow' : 'noindex,follow';
      record(
        `${target}: директива робота = ${expectedRobots} (решение человека, не кода)`,
        metaOf(html, 'robots') === expectedRobots,
        `robots=${String(metaOf(html, 'robots'))}`,
      );
      record(
        `${target}: заглушки нет — текст заполнен`,
        !visibleText(html).includes('Текст этой страницы ещё не заполнен'),
      );
      record(
        `${target}: навигация и подвал в ответе, ни одного href="#"`,
        anchors(html).includes('/otkrytki') &&
          anchors(html).includes('/podborki') &&
          anchors(html).includes('/o-proekte') &&
          !html.includes('href="#"'),
      );
      record(
        `${target}: ни одного исполняемого <script>`,
        !/<script(?![^>]*type="application\/ld\+json")/i.test(html),
      );
      const withSlash = await request(PORT, `${target}/`);
      record(
        `${target}/: одиночный 301 в каноническую форму`,
        withSlash.status === 301 && withSlash.headers.location === target,
        `статус=${String(withSlash.status)} location=${String(withSlash.headers.location)}`,
      );
    }

    /* ------------------------------------------------------------ */
    /* Пустой глобал: 200 с заглушкой, а не 404                     */
    /* ------------------------------------------------------------ */

    // Поля обнуляются ПОШТУЧНО и явным `null`. `{ infoPages: {} }` группу не
    // очищает: Payload сливает частичные данные с уже сохранёнными, поэтому
    // пустой объект — это отсутствие изменений. Первый прогон смоука на этом и
    // ошибся: сервер продолжал отдавать заполненный текст, а проверка «пустого
    // глобала» проверяла заполненную страницу.
    const emptied: Record<string, unknown> = {};
    for (const key of INFO_PAGE_KEYS) {
      const previous = (originalInfoPages as Record<string, Record<string, unknown> | undefined>)[
        key
      ];
      emptied[key] = {
        allowIndexing: previous?.['allowIndexing'] ?? false,
        body: null,
        h1: null,
        metaDescription: null,
        title: null,
      };
    }

    await payload.updateGlobal({
      slug: SITE_SETTINGS_SLUG,
      data: { infoPages: emptied },
      ...asAdmin,
    });

    // Постусловие: без него проверка «пустого глобала» может проверять
    // заполненный. Метка прогона в значении означала бы, что обнуление не
    // применилось.
    const emptyCheck = await payload.findGlobal({
      slug: SITE_SETTINGS_SLUG,
      depth: 0,
      ...asAdmin,
    });
    record(
      'глобал действительно опустошён перед проверкой заглушки',
      !JSON.stringify(emptyCheck.infoPages ?? {}).includes(MARK),
    );

    for (const key of INFO_PAGE_KEYS) {
      const target = INFO_PAGE_PATHS[key];
      const response = await request(PORT, target);
      const html = response.body;

      record(
        `${target} с пустым глобалом: 200 с заглушкой, а не 404`,
        response.status === 200,
        `статус=${String(response.status)}`,
      );
      record(
        `${target} с пустым глобалом: заглушка говорит, что текста нет`,
        visibleText(html).includes('Текст этой страницы ещё не заполнен'),
      );
      record(
        `${target} с пустым глобалом: noindex — условия Ч-23 не выполнены`,
        metaOf(html, 'robots') === 'noindex,follow',
        `robots=${String(metaOf(html, 'robots'))}`,
      );
      record(
        `${target} с пустым глобалом: title непустой (имя раздела)`,
        /<title>[^<]{3,}<\/title>/.test(html),
      );
      record(
        `${target} с пустым глобалом: ровно один <h1>`,
        headings(html).length === 1,
        `h1=${JSON.stringify(headings(html))}`,
      );
    }

    // Ссылка из `acquireLicensePage` (решение Ч-10) ведёт на `/usloviya`, и она
    // обязана вести на 200 в любом состоянии текста — иначе лицензионная отсылка
    // карточки обрывается.
    const terms = await request(PORT, INFO_PAGE_PATHS.terms);
    record(
      'адрес из acquireLicensePage отвечает 200 даже с пустым текстом',
      terms.status === 200,
      `${INFO_PAGE_PATHS.terms} → ${String(terms.status)}`,
    );

    /* ------------------------------------------------------------ */
    /* Настоящая 404: одна страница на все пути                     */
    /* ------------------------------------------------------------ */

    const notFoundTargets: readonly { readonly path: string; readonly why: string }[] = [
      { path: '/takoy-stranicy-net-e3-11', why: 'несовпавший маршрут (страница 404 приложения)' },
      { path: '/admin/collections/cards', why: 'маршрут админки: решение not-served' },
      { path: '/otkrytki/net-takoy-otkrytki-e3-11', why: 'SSR-маршрут, Response(null, 404)' },
      { path: '/otkrytki/page/0', why: 'форма номера страницы: не адрес' },
    ];

    const bodies: string[] = [];
    for (const target of notFoundTargets) {
      const response = await request(PORT, target.path);
      record(
        `404 на «${target.path}» — ${target.why}`,
        response.status === 404,
        `статус=${String(response.status)}`,
      );
      bodies.push(response.body);
    }

    const first = bodies[0] ?? '';
    record(
      'страница 404 у сайта ОДНА: тело совпадает у всех четырёх путей',
      bodies.every((body) => body === first),
    );
    record('страница 404: <html lang="ru">', first.includes('<html lang="ru">'));
    record(
      'страница 404: настоящая навигация — меню, подвал и каталоги',
      anchors(first).includes('/') &&
        anchors(first).includes('/otkrytki') &&
        anchors(first).includes('/podborki') &&
        anchors(first).includes('/o-proekte'),
    );
    record('страница 404: ровно один <h1>', headings(first).length === 1);
    record(
      'страница 404: НЕТ canonical — канонического адреса у неё не существует',
      canonicalOf(first) === null,
      `canonical=${String(canonicalOf(first))}`,
    );
    record('страница 404: noindex,follow', metaOf(first, 'robots') === 'noindex,follow');
    record(
      'страница 404: не редирект на главную (запрет п. 23 ТЗ)',
      !first.includes('http-equiv="refresh"'),
    );

    server.kill();
    server = null;
    await delay(500);

    /* ------------------------------------------------------------ */
    /* Режим обслуживания: 503 на любой класс адреса                */
    /* ------------------------------------------------------------ */

    const maintenancePort = PORT + 1;
    maintenanceServer = spawn(process.execPath, [serverEntry], {
      cwd: appDir,
      env: {
        ...process.env,
        HOST,
        MAINTENANCE_MODE: 'on',
        MAINTENANCE_RETRY_AFTER: String(RETRY_AFTER),
        PORT: String(maintenancePort),
        SITE_URL: `http://${HOST}:${String(maintenancePort)}`,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitForServer(maintenancePort);

    const maintenanceTargets: readonly { readonly path: string; readonly why: string }[] = [
      { path: '/', why: 'главная' },
      { path: '/o-proekte', why: 'служебная страница' },
      { path: '/otkrytki', why: 'каталог' },
      // Неканоническая форма: 503, а НЕ 301. Утверждений о канонической форме
      // адреса сервис, объявивший себя недоступным, не делает.
      { path: '/otkrytki/', why: 'неканоническая форма — 503, а не 301' },
      { path: '/media/cards/a1b2c3d4/otkrytka-640.webp', why: 'файл производной' },
      { path: '/takoy-stranicy-net-e3-11', why: 'несуществующий адрес — 503, а не 404' },
      { path: '/admin', why: 'маршрут админки' },
    ];

    for (const target of maintenanceTargets) {
      const response = await request(maintenancePort, target.path);
      record(
        `обслуживание: 503 + Retry-After на «${target.path}» (${target.why})`,
        response.status === 503 && response.headers['retry-after'] === String(RETRY_AFTER),
        `статус=${String(response.status)} retry-after=${String(response.headers['retry-after'])}`,
      );
    }

    const maintenanceBody = (await request(maintenancePort, '/')).body;
    record(
      'страница 503 не зависит от БД: ни ссылок, ни canonical, ни скриптов',
      !maintenanceBody.includes('<a ') &&
        !maintenanceBody.includes('rel="canonical"') &&
        !maintenanceBody.includes('<script'),
    );
    record(
      'страница 503 закрыта от индексации',
      metaOf(maintenanceBody, 'robots') === 'noindex,nofollow',
    );

    maintenanceServer.kill();
    maintenanceServer = null;
    await delay(500);

    /* ------------------------------------------------------------ */
    /* Режим выключен по умолчанию                                  */
    /* ------------------------------------------------------------ */

    const defaultPort = PORT + 2;
    server = spawn(process.execPath, [serverEntry], {
      cwd: appDir,
      env: {
        ...process.env,
        HOST,
        // Переменная НЕ задана вовсе — именно это и проверяется.
        MAINTENANCE_MODE: '',
        PORT: String(defaultPort),
        SITE_URL: `http://${HOST}:${String(defaultPort)}`,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitForServer(defaultPort);

    const home = await request(defaultPort, '/');
    record(
      'режим обслуживания ВЫКЛЮЧЕН по умолчанию: главная отдаёт 200',
      home.status === 200 && home.headers['retry-after'] === undefined,
      `статус=${String(home.status)}`,
    );
  } finally {
    await cleanupOnce();
  }

  /**
   * Тело уборки. Кода выхода НЕ ставит: `process.exit(1)` из `finally` при
   * исключении в полёте съедал бы саму ошибку.
   */
  async function runCleanup(): Promise<CleanupOutcome> {
    server?.kill();
    maintenanceServer?.kill();

    /* ------------------------------------------------------------ */
    /* Уборка: возврат исходных текстов                             */
    /* ------------------------------------------------------------ */

    const cleanup = await payloadClient();
    const admins2 = await cleanup.find({
      collection: 'users',
      limit: 1,
      where: { role: { equals: 'admin' } },
    });
    const adminDoc2 = admins2.docs[0];
    if (adminDoc2 !== undefined) {
      await cleanup.updateGlobal({
        slug: SITE_SETTINGS_SLUG,
        data: { infoPages: originalInfoPages },
        overrideAccess: false,
        user: { ...adminDoc2, collection: 'users' },
      });
    }

    const after = await cleanup.findGlobal({
      slug: SITE_SETTINGS_SLUG,
      depth: 0,
      overrideAccess: false,
      ...(adminDoc2 === undefined
        ? {}
        : { user: { ...adminDoc2, collection: 'users' as const } }),
    });
    const restored = JSON.stringify(after.infoPages ?? {}) === JSON.stringify(originalInfoPages);
    const marks = JSON.stringify(after.infoPages ?? {}).includes(MARK);

    // Записей в контентных коллекциях смоук не создаёт вовсе, поэтому счётчик
    // здесь один и он про то, что скрипт действительно правил: тексты глобала.
    console.log(
      `\nПосле уборки: тексты служебных страниц восстановлены=${String(restored)} ` +
        `следов смоука (${MARK}) в глобале=${String(marks)} ` +
        `создано записей cards=0 collections=0 published=0`,
    );

    outcomeValue = { clean: restored && !marks };
    return outcomeValue;
  }
}

/* ------------------------------------------------------------------ */
/* Верхний уровень: итог и код выхода                                 */
/* ------------------------------------------------------------------ */
//
// КОД ВЫХОДА СЧИТАЕТСЯ ЗДЕСЬ, а не в `finally`: `process.exit(1)` из `finally`
// при исключении в полёте гасит саму ошибку, и красный смоук докладывает
// «не сошлись числа» вместо настоящей причины.
//
// `process.exit`, а не `process.exitCode`: смоук запускается через `payload run`,
// а тот в конце делает `process.exit(0)` безусловно
// (`payload/dist/bin/index.js`) — выставленный код он затирает.

/**
 * Текст непойманного исключения для итоговой строки.
 *
 * Не шаблонная подстановка значения: у объекта, не являющегося `Error`,
 * стандартное приведение к строке даёт «[object Object]», то есть скрывает
 * причину падения ровно в тот момент, когда она нужнее всего.
 */
function describeCrash(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : inspect(error, { depth: 3 });
}

let crashed: unknown = null;
try {
  await main();
} catch (error) {
  crashed = error;
}

const failed = checks.filter((check) => !check.ok);
console.log(`\nПроверок: ${String(checks.length)}, провалено: ${String(failed.length)}`);
for (const check of failed) {
  console.log(`  - ${check.name}${check.detail === '' ? '' : ` (${check.detail})`}`);
}
if (crashed !== null) {
  console.error(
    `\nСмоук прерван ошибкой:\n${describeCrash(crashed)}`,
  );
}

const outcome = readOutcome();
if (outcome === null) {
  console.error(
    '\nУборка не выполнялась вовсе: в глобале могли остаться тексты смоука. Проверьте ' +
      'служебные страницы в настройках сайта.',
  );
}

const ok = crashed === null && outcome !== null && outcome.clean && failed.length === 0;
await flushStdout();
process.exit(ok ? 0 : 1);
