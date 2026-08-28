/**
 * Смоук `robots.txt` и карты сайта на СОБРАННОМ сервере (задачи Э4-03, Э4-04).
 *
 * ## Что здесь проверяется и почему только здесь
 *
 * Юнит-тесты доказывают свойства ЗНАЧЕНИЙ: три условия включения, разбиение на
 * файлы, форму XML, состав директив `Disallow`. Они не доказывают того, что
 * проверяет этот скрипт:
 *
 *   - что `/robots.txt` и `/sitemap.xml` действительно ОТДАЮТСЯ собранным
 *     сервером, с верным типом содержимого и без редиректов;
 *   - что абсолютные адреса в них собраны на хосте ЭТОГО сервера, а не на том,
 *     где выполнялась сборка (маршруты не пререндерятся именно поэтому);
 *   - что путь админки не попал в публичный файл;
 *   - что несуществующая часть карты сайта отвечает 404, а форма номера строгая;
 *   - что состав карты объясним: сколько страниц рассмотрено и что именно их
 *     отсеяло.
 *
 * ## ГЛАВНОЕ ПРО ПУСТУЮ КАРТУ САЙТА
 *
 * На ненаполненной базе карта сайта пуста ЗАКОННО: ни одна страница пока не
 * открыта в `index,follow`, потому что это решение человека (п. 7.1 и п. 23 ТЗ).
 * Пустой результат сам по себе ничего не доказывает — он одинаково выглядит и
 * тогда, когда отбор сломан и выбрасывает всё подряд. Поэтому смоук различает
 * два состояния явно:
 *
 *   1. читает КАНДИДАТОВ (`collectSitemapFacts`) и печатает их число. Если
 *      кандидатов ноль — публиковать действительно нечего;
 *   2. печатает разбор исключений. Если каждый кандидат исключён ровно по
 *      директиве (`noindex`), значит отбор работает и ждёт решения человека, а не
 *      теряет страницы по ошибке в canonical или в проверке ответа 200;
 *   3. прогоняет тот же набор кандидатов через отбор с ОТКРЫТОЙ директивой,
 *      подставленной В ПАМЯТИ СКРИПТА. Так проверяется всё остальное: реальные
 *      адреса страниц, реальные адреса изображений, форма XML, разбиение на
 *      файлы — на живых записях и без единой правки данных.
 *
 * ЧЕГО СКРИПТ НЕ ДЕЛАЕТ НИКОГДА: не выставляет `index,follow` ни одной записи —
 * ни временно, ни «с откатом в finally». Оборванный прогон оставил бы запись
 * открытой в индекс, то есть агент принял бы решение за человека. По той же
 * причине и тем же способом (юнит-тест вместо живой правки) обходится смоук
 * служебных страниц с выключателем Ч-23 (`./smoke-info-pages.ts`).
 *
 * Следствие, названное в отчёте: НЕПУСТОЙ файл карты сайта на HTTP-уровне этим
 * смоуком не проверяется — только на уровне модели. Закроет этот разрыв первая
 * страница, открытая человеком в `index,follow`; тогда же его закроет и приёмка.
 *
 * ## Запуск
 *
 *   pnpm --filter @otkritka/web run build
 *   pnpm --filter @otkritka/web run smoke:sitemap
 *
 * ## Про временные записи и уборку
 *
 * Скрипт создаёт узел-черновик и три ОПУБЛИКОВАННЫЕ карточки с изображениями:
 * без опубликованных записей карта сайта не увидит ни одного кандидата, и
 * проверять было бы нечего. Публикация относится к записям с префиксом
 * `smoke-e4-04`, снимается в `finally` и по сигналу, а итог печатается числами —
 * число опубликованных остатков обязано быть нулём. Уборка идёт с двух сторон:
 * своё — в `finally`, следы оборванного прогона — перед созданием фикстур.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';

import type { Payload } from 'payload';

import { parseAdminPath, PAYLOAD_ADMIN_PATH_ENV_KEY, type SharedEnv } from '@otkritka/shared';

import { createPngFixture } from '../../cms/src/images/png-fixture.js';
import {
  collectSitemapFacts,
  payloadClient,
  sitemapIndexEntries,
  sitemapModelFrom,
} from '../src/data/index.js';
import { canonicalUrlFor } from '../src/routing/canonical.js';
import { resolvePageRobots } from '../src/seo/robots-directive.js';
import {
  renderImageUrlset,
  renderSitemapIndex,
  renderUrlset,
  type SitemapPageFacts,
} from '../src/seo/sitemap.js';
import { serverChildEnv } from './server-child-env.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(appDir, 'dist', 'server', 'entry.mjs');

const HOST = '127.0.0.1';
const PORT = Number(process.env.SMOKE_SITEMAP_PORT ?? '4397');
const ORIGIN = `http://${HOST}:${String(PORT)}`;

/** Окружение проверок модели: тот же хост, что у поднятого сервера. */
const ENV: SharedEnv = { ...process.env, SITE_URL: ORIGIN };

const PREFIX = 'smoke-e4-04';
/** Основа имени файла: пайплайн собирает его транслитерацией заголовка. */
const IMAGE_STEM_PREFIX = 'smouk-e4-04';

const LEFTOVER_FILTERS = {
  cards: { slug: { like: PREFIX } },
  claims: { stem: { like: IMAGE_STEM_PREFIX } },
  collections: { slug: { like: PREFIX } },
  images: { nameStem: { like: IMAGE_STEM_PREFIX } },
} as const;

interface Check {
  readonly detail: string;
  readonly name: string;
  readonly ok: boolean;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail = ''): void {
  checks.push({ detail, name, ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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
 * Запрос СЫРОЙ целью через `node:http`: `fetch` нормализовал бы путь парсером
 * URL, и до сервера доехала бы уже исправленная форма (та же причина, что в
 * остальных смоуках).
 */
function request(target: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, method: 'GET', path: target, port: PORT }, (res) => {
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

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await request('/');
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error(`Сервер не поднялся на ${ORIGIN}`);
}

/* ------------------------------------------------------------------ */
/* Разбор XML настоящим парсером                                      */
/* ------------------------------------------------------------------ */

interface XmlReport {
  readonly ok: boolean;
  readonly root: string;
  readonly detail: string;
  readonly locs: readonly string[];
  readonly imageLocs: readonly string[];
}

/**
 * Разбор XML в браузере, а не регулярными выражениями.
 *
 * Смысл проверки — «файл РАЗБИРАЕТСЯ», и доказать это может только настоящий
 * парсер: незакрытый тег, неэкранированный `&` и неверное пространство имён
 * регулярным выражением не ловятся вовсе. Playwright лежит в devDependencies
 * корня, поэтому импорт динамический: его недоступность обязана давать честную
 * строку «не проверено», а не зелёный смоук.
 */
async function parseXmlAll(documents: Readonly<Record<string, string>>): Promise<
  Record<string, XmlReport> | null
> {
  const playwright = await import('@playwright/test').catch((error: unknown) => {
    record(
      'разбор XML настоящим парсером: НЕ ПРОВЕРЕНО',
      false,
      `playwright недоступен: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  });
  if (playwright === null) {
    return null;
  }

  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage();
    return await page.evaluate((docs: Record<string, string>) => {
      const result: Record<string, XmlReport> = {};
      for (const [name, xml] of Object.entries(docs)) {
        const parsed = new DOMParser().parseFromString(xml, 'application/xml');
        const failure = parsed.querySelector('parsererror');
        const root = parsed.documentElement.tagName;
        result[name] = {
          detail: failure === null ? '' : (failure.textContent ?? 'parsererror'),
          imageLocs: [...parsed.getElementsByTagName('image:loc')].map(
            (node) => node.textContent ?? '',
          ),
          locs: [...parsed.getElementsByTagName('loc')].map((node) => node.textContent ?? ''),
          ok: failure === null,
          root,
        };
      }
      return result;
    }, documents as Record<string, string>);
  } finally {
    await browser.close();
  }
}

/* ------------------------------------------------------------------ */
/* Уборка следов прошлого прогона                                     */
/* ------------------------------------------------------------------ */

async function sweepLeftovers(payload: Payload): Promise<void> {
  const removed = { cards: 0, claims: 0, collections: 0, images: 0 };

  const cards = await payload.find({
    collection: 'cards',
    depth: 0,
    limit: 100,
    where: LEFTOVER_FILTERS.cards,
  });
  for (const card of cards.docs) {
    await payload.delete({ collection: 'cards', id: card.id }).catch(() => undefined);
    removed.cards += 1;
  }

  const collections = await payload.find({
    collection: 'collections',
    depth: 0,
    limit: 100,
    sort: ['-path'],
    where: LEFTOVER_FILTERS.collections,
  });
  for (const node of collections.docs) {
    await payload.delete({ collection: 'collections', id: node.id }).catch(() => undefined);
    removed.collections += 1;
  }

  const images = await payload.find({
    collection: 'card-images',
    depth: 0,
    limit: 100,
    where: LEFTOVER_FILTERS.images,
  });
  for (const image of images.docs) {
    await payload.delete({ collection: 'card-images', id: image.id }).catch(() => undefined);
    removed.images += 1;
  }

  const claims = await payload.find({
    collection: 'image-name-claims',
    depth: 0,
    limit: 100,
    where: LEFTOVER_FILTERS.claims,
  });
  for (const claim of claims.docs) {
    await payload.delete({ collection: 'image-name-claims', id: claim.id }).catch(() => undefined);
    removed.claims += 1;
  }

  if (removed.cards + removed.collections + removed.images + removed.claims > 0) {
    console.log(
      `Уборка следов прошлого прогона: cards=${String(removed.cards)} ` +
        `collections=${String(removed.collections)} card-images=${String(removed.images)} ` +
        `image-name-claims=${String(removed.claims)}`,
    );
  }
}

interface CleanupOutcome {
  readonly clean: boolean;
}

let outcomeValue: CleanupOutcome | null = null;

function readOutcome(): CleanupOutcome | null {
  return outcomeValue;
}

async function main(): Promise<void> {
  const payload: Payload = await payloadClient();
  await sweepLeftovers(payload);

  const created = { cardImages: [] as number[], cards: [] as number[], collections: [] as number[] };
  const claimedStems: string[] = [];
  let server: ReturnType<typeof spawn> | null = null;

  let cleanupStarted: Promise<CleanupOutcome> | null = null;
  const cleanupOnce = (): Promise<CleanupOutcome> => {
    cleanupStarted ??= runCleanup();
    return cleanupStarted;
  };

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

    // Узел остаётся ЧЕРНОВИКОМ: карточке нужна хотя бы одна подборка для перехода
    // в review (проверка полноты), а публикация узла потребовала бы двадцати
    // открыток (порог Ч-06). Черновик публичному рендеру не виден, поэтому в
    // кандидатах карты сайта его не будет — и это тоже проверяется ниже.
    const node = await payload.create({
      collection: 'collections',
      data: {
        metaDescription: 'Смоук Э4-04: узел-черновик для привязки карточек.',
        nodeKind: 'group',
        responsibleEditor: adminDoc.id,
        robots: 'noindex,follow',
        slug: `${PREFIX}-gruppa`,
        status: 'draft',
        title: 'Смоук Э4-04: группа',
      },
      ...asAdmin,
    });
    created.collections.push(node.id);

    const compositions = ['grid', 'rings', 'stripes'] as const;
    const cardSlugs: string[] = [];

    for (const [index, composition] of compositions.entries()) {
      const title = `Смоук Э4-04: открытка ${String(index + 1)}`;
      const bytes = createPngFixture({ composition, height: 500, width: 800 });
      const image = await payload.create({
        collection: 'card-images',
        data: { title },
        file: {
          data: bytes,
          mimetype: 'image/png',
          name: `${composition}.png`,
          size: bytes.byteLength,
        },
        ...asAdmin,
      });
      created.cardImages.push(image.id);
      if (typeof image.nameStem === 'string') {
        claimedStems.push(image.nameStem);
      }

      const slug = `${PREFIX}-otkrytka-${String(index + 1)}`;
      const card = await payload.create({
        collection: 'cards',
        data: {
          alt: `Синтетический узор фикстуры: ${title}`,
          caption: `Подпись смоука: ${title}`,
          collections: [node.id],
          description: `Видимое описание открытки «${title}».`,
          image: image.id,
          metaDescription: `Смоук Э4-04, meta description: ${title}`,
          // Директива записи — закрытая. Открыть её может только человек, и смоук
          // этого не делает (см. шапку файла).
          robots: 'noindex,follow',
          slug,
          status: 'draft',
          title,
          updatedContentAt: '2026-03-08T09:30:00.000Z',
        },
        ...asAdmin,
      });
      created.cards.push(card.id);
      cardSlugs.push(slug);

      // Публикация: без опубликованных записей у карты сайта нет кандидатов.
      try {
        await payload.update({
          collection: 'cards',
          id: card.id,
          data: { status: 'review' },
          ...asAdmin,
        });
      } catch {
        await payload.update({
          collection: 'cards',
          id: card.id,
          data: { status: 'review', visualDuplicate: { confirm: true, decision: 'unique' } },
          ...asAdmin,
        });
      }
      await payload.update({
        collection: 'cards',
        id: card.id,
        data: { status: 'published' },
        ...asAdmin,
      });
    }

    // Сервер поднимается СРАЗУ после фикстур, хотя первые проверки его не
    // требуют: проверка «файл из image sitemap действительно отдаётся» ходит по
    // HTTP, и порядок «сначала модель, потом сервер» уронил бы её отказом
    // соединения — то есть проверял бы порядок в скрипте, а не сервер.
    server = spawn(process.execPath, [serverEntry], {
      cwd: appDir,
      env: serverChildEnv(appDir, { HOST, PORT: String(PORT), SITE_URL: ORIGIN }),
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitForServer();
    console.log(`\nПроверки против ${ORIGIN}\n`);

    /* ------------------------------------------------------------ */
    /* 1. Кандидаты и разбор отбора (модель, живая база)            */
    /* ------------------------------------------------------------ */

    const facts = await collectSitemapFacts(ENV);
    const model = sitemapModelFrom(facts, ENV);
    const candidates = [...facts.sections, ...facts.cards];

    console.log(
      `\nКандидатов: ${String(candidates.length)} ` +
        `(разделы ${String(facts.sections.length)}, карточки ${String(facts.cards.length)})\n` +
        `Отбор: включено ${String(model.diagnostics.included)}, ` +
        `исключено по причинам ${JSON.stringify(model.diagnostics.excludedBy)}\n`,
    );

    record(
      'кандидаты видны: карта сайта читает живые записи, а не пустоту',
      facts.cards.length >= compositions.length,
      `карточек среди кандидатов: ${String(facts.cards.length)}`,
    );
    record(
      'ПУСТО ПОТОМУ ЧТО ЗАКРЫТО: каждый кандидат исключён по директиве',
      model.diagnostics.included === 0 &&
        model.diagnostics.excludedBy.noindex === candidates.length,
      `noindex=${String(model.diagnostics.excludedBy.noindex)} из ` +
        `${String(candidates.length)}, включено ${String(model.diagnostics.included)}`,
    );
    record(
      'ни одна страница не отсеяна ошибкой в canonical или в пути',
      model.diagnostics.excludedBy['not-self-canonical'] === 0 &&
        model.diagnostics.excludedBy['not-a-path'] === 0,
      JSON.stringify(model.diagnostics.excludedBy),
    );

    const cardFacts = facts.cards.filter((fact) =>
      cardSlugs.some((slug) => fact.pagePath === `/otkrytki/${slug}`),
    );
    record(
      'у карточек смоука ответ 200 и по одному изображению',
      cardFacts.length === compositions.length &&
        cardFacts.every((fact) => fact.respondsOk && (fact.images ?? []).length === 1),
      `карточек ${String(cardFacts.length)}`,
    );
    record(
      'lastmod берётся из updatedContentAt записи, а не из updatedAt',
      cardFacts.every((fact) => fact.lastmod === '2026-03-08T09:30:00.000Z'),
      JSON.stringify(cardFacts.map((fact) => fact.lastmod)),
    );

    const catalogFact = facts.sections.find((fact) => fact.pagePath === '/otkrytki');
    const nodesFact = facts.sections.find((fact) => fact.pagePath === '/podborki');
    record(
      'условие «отвечает 200» посчитано по живым данным: /otkrytki да, /podborki нет',
      catalogFact?.respondsOk === true && nodesFact?.respondsOk === false,
      `otkrytki=${String(catalogFact?.respondsOk)} podborki=${String(nodesFact?.respondsOk)}`,
    );
    record(
      'узел-черновик в кандидаты не попал: публичный рендер его не видит',
      !facts.sections.some((fact) => fact.pagePath.includes(`${PREFIX}-gruppa`)),
    );

    /* ------------------------------------------------------------ */
    /* 2. Тот же набор с ОТКРЫТОЙ директивой — в памяти скрипта     */
    /* ------------------------------------------------------------ */
    //
    // Директива подставляется здесь и только здесь: ни одна запись в базе не
    // меняется. Так проверяется всё, что не проверить на закрытых страницах, —
    // адреса, изображения, форма XML и разбиение на файлы.

    const opened = (fact: SitemapPageFacts): SitemapPageFacts => ({
      ...fact,
      robots: resolvePageRobots({
        declared: 'index,follow',
        description: 'Синтетическое описание проверки: в базу оно не попадает.',
      }).robots,
    });
    const openedModel = sitemapModelFrom(
      { cards: facts.cards.map(opened), sections: facts.sections.map(opened) },
      ENV,
    );

    const cardUrls = openedModel.cardShards[0] ?? [];
    const imageUrls = openedModel.imageShards[0] ?? [];
    record(
      'при открытой директиве адрес карточки собирается абсолютным на хосте сервера',
      cardUrls.some((url) => url.loc === `${ORIGIN}/otkrytki/${String(cardSlugs[0])}`),
      String(cardUrls.at(0)?.loc),
    );
    record(
      'image sitemap описывает файл, который страница показывает',
      imageUrls.every((url) => url.images.every((image) => image.loc.startsWith(`${ORIGIN}/media/`))),
      String(imageUrls.at(0)?.images.at(0)?.loc),
    );

    const mediaLoc = imageUrls.at(0)?.images.at(0)?.loc;
    if (mediaLoc !== undefined) {
      const mediaResponse = await request(new URL(mediaLoc).pathname);
      record(
        'файл из image sitemap действительно отдаётся сервером',
        mediaResponse.status === 200,
        `${new URL(mediaLoc).pathname} → ${String(mediaResponse.status)}`,
      );
    }

    const indexEntries = sitemapIndexEntries(openedModel, (target) => canonicalUrlFor(target, ENV));
    record(
      'индекс перечисляет разделы, карточки и изображения — и только непустые файлы',
      indexEntries.some((entry) => entry.loc === `${ORIGIN}/sitemap-sections.xml`) &&
        indexEntries.some((entry) => entry.loc === `${ORIGIN}/sitemap-cards-1.xml`) &&
        indexEntries.some((entry) => entry.loc === `${ORIGIN}/sitemap-images-1.xml`),
      indexEntries.map((entry) => entry.loc).join(' '),
    );

    /* ------------------------------------------------------------ */
    /* 3. Живые ответы сервера                                      */
    /* ------------------------------------------------------------ */

    const robots = await request('/robots.txt');
    record(
      'robots.txt: 200, текст, без редиректа',
      robots.status === 200 &&
        String(robots.headers['content-type']).startsWith('text/plain') &&
        robots.headers.location === undefined,
      `${String(robots.status)} ${String(robots.headers['content-type'])}`,
    );
    record(
      'robots.txt: закрыты ровно три служебных пути и в префиксной форме (Ч-22)',
      robots.body
        .split('\n')
        .filter((line) => line.startsWith('Disallow:'))
        .join('|') === 'Disallow: /search|Disallow: /account|Disallow: /generator/preview',
      robots.body.split('\n').filter((line) => line.startsWith('Disallow:')).join(' '),
    );
    record(
      'robots.txt: абсолютная ссылка на индекс собрана на хосте ЭТОГО сервера',
      robots.body.includes(`Sitemap: ${ORIGIN}/sitemap.xml`),
      robots.body.split('\n').find((line) => line.startsWith('Sitemap:')) ?? '—',
    );

    const adminPath = parseAdminPath(process.env[PAYLOAD_ADMIN_PATH_ENV_KEY]);
    record(
      'robots.txt: путь админки не назван (решение Ч-22)',
      !robots.body.includes(adminPath) && !robots.body.includes(adminPath.split('/')[1] ?? '—'),
    );

    const index = await request('/sitemap.xml');
    record(
      'sitemap-индекс: 200 и XML',
      index.status === 200 && String(index.headers['content-type']).includes('xml'),
      `${String(index.status)} ${String(index.headers['content-type'])}`,
    );

    // Части карты сайта сейчас пусты (все страницы закрыты), поэтому их файлов не
    // существует. Это условие, а не совпадение: индекс не ссылается на пустой
    // файл, а пустой файл не выкладывается.
    for (const target of [
      '/sitemap-sections.xml',
      '/sitemap-cards-1.xml',
      '/sitemap-images-1.xml',
      '/sitemap-cards-2.xml',
      '/sitemap-cards-0.xml',
      '/sitemap-cards-01.xml',
      '/sitemap-cards--1.xml',
      '/sitemap-cards-odin.xml',
    ]) {
      const response = await request(target);
      record(
        `пустой или несуществующей части нет: ${target} — 404 без Location`,
        response.status === 404 && response.headers.location === undefined,
        `status=${String(response.status)}`,
      );
    }

    for (const target of ['/robots.txt/', '/sitemap.xml/', '/sitemap', '/sitemap-cards-1.xml/']) {
      const response = await request(target);
      record(
        `URL файла не нормализуется, а форма со слешем не адрес: ${target} — 404`,
        response.status === 404 && response.headers.location === undefined,
        `status=${String(response.status)}`,
      );
    }

    /* ------------------------------------------------------------ */
    /* 4. Разбор XML настоящим парсером                             */
    /* ------------------------------------------------------------ */

    const parsed = await parseXmlAll({
      cards: renderUrlset(cardUrls),
      images: renderImageUrlset(imageUrls),
      index: index.body,
      openedIndex: renderSitemapIndex(indexEntries),
      sections: renderUrlset(openedModel.sections),
    });

    if (parsed !== null) {
      for (const [name, report] of Object.entries(parsed)) {
        record(`XML разбирается парсером: ${name}`, report.ok, report.detail.slice(0, 120));
      }
      record(
        'индекс живого сервера — sitemapindex (пустой: включать нечего)',
        parsed['index']?.root === 'sitemapindex' && (parsed['index']?.locs.length ?? -1) === 0,
        `root=${String(parsed['index']?.root)} locs=${String(parsed['index']?.locs.length)}`,
      );
      record(
        'urlset карточек: адресов столько же, сколько отобрано',
        parsed['cards']?.locs.length === cardUrls.length,
        `${String(parsed['cards']?.locs.length)} против ${String(cardUrls.length)}`,
      );
      record(
        'image sitemap: у каждого адреса есть image:loc',
        (parsed['images']?.imageLocs.length ?? 0) === imageUrls.length,
        `${String(parsed['images']?.imageLocs.length)} против ${String(imageUrls.length)}`,
      );
    }
  } finally {
    await cleanupOnce();
  }

  async function runCleanup(): Promise<CleanupOutcome> {
    if (server !== null) {
      server.kill();
    }

    const cleanup = await payloadClient();
    // Порядок значим: карточки раньше изображений (CMS отказывает в удалении
    // изображения, на которое ссылается карточка).
    for (const id of created.cards) {
      await cleanup.delete({ collection: 'cards', id }).catch(() => undefined);
      await cleanup
        .delete({
          collection: 'seo-history',
          where: {
            and: [
              { documentCollection: { equals: 'cards' } },
              { documentId: { equals: String(id) } },
            ],
          },
        })
        .catch(() => undefined);
    }
    for (const id of [...created.collections].reverse()) {
      await cleanup.delete({ collection: 'collections', id }).catch(() => undefined);
      await cleanup
        .delete({
          collection: 'seo-history',
          where: {
            and: [
              { documentCollection: { equals: 'collections' } },
              { documentId: { equals: String(id) } },
            ],
          },
        })
        .catch(() => undefined);
    }
    for (const id of created.cardImages) {
      await cleanup.delete({ collection: 'card-images', id }).catch(() => undefined);
    }
    for (const stem of claimedStems) {
      await cleanup
        .delete({ collection: 'image-name-claims', where: { stem: { equals: stem } } })
        .catch(() => undefined);
    }

    const counts = {
      cards: (await cleanup.count({ collection: 'cards', where: LEFTOVER_FILTERS.cards })).totalDocs,
      claims: (
        await cleanup.count({ collection: 'image-name-claims', where: LEFTOVER_FILTERS.claims })
      ).totalDocs,
      collections: (
        await cleanup.count({ collection: 'collections', where: LEFTOVER_FILTERS.collections })
      ).totalDocs,
      images: (await cleanup.count({ collection: 'card-images', where: LEFTOVER_FILTERS.images }))
        .totalDocs,
      publishedCards: (
        await cleanup.count({
          collection: 'cards',
          where: { and: [LEFTOVER_FILTERS.cards, { status: { equals: 'published' } }] },
        })
      ).totalDocs,
    };
    console.log(
      `\nОстатки смоука после уборки: cards=${String(counts.cards)} ` +
        `collections=${String(counts.collections)} card-images=${String(counts.images)} ` +
        `image-name-claims=${String(counts.claims)} published=${String(counts.publishedCards)}`,
    );

    outcomeValue = {
      clean:
        counts.publishedCards === 0 &&
        counts.cards === 0 &&
        counts.collections === 0 &&
        counts.claims === 0 &&
        counts.images === 0,
    };
    return outcomeValue;
  }
}

/* ------------------------------------------------------------------ */
/* Верхний уровень: итог и код выхода                                 */
/* ------------------------------------------------------------------ */

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
  console.error(`\nСмоук прерван ошибкой:\n${describeCrash(crashed)}`);
}
const outcome = readOutcome();
if (outcome === null) {
  console.error(
    '\nУборка не выполнялась вовсе: в базе могли остаться ОПУБЛИКОВАННЫЕ фикстуры смоука. ' +
      'Проверьте записи с префиксом «smoke-e4-04».',
  );
}

const ok = crashed === null && outcome !== null && outcome.clean && failed.length === 0;
await flushStdout();
process.exit(ok ? 0 : 1);
