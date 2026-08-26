/**
 * Смоук шаблонов карточки, подборки, пагинации и каталогов на СОБРАННОМ сервере
 * (задачи Э3-05 … Э3-08).
 *
 * ## Что здесь проверяется и почему только здесь
 *
 * Юнит-тесты доказывают свойства ЗНАЧЕНИЙ: состав разметки, соответствие
 * `ItemList` списку плиток, отбор похожих, поведение при пустом глобале и пустом
 * зеркале. Они не доказывают того, что проверяет этот скрипт:
 *
 *   - что страница действительно ОТДАЁТСЯ: 200 у опубликованной, 404 у черновика
 *     и у записи в `review` — при любых параметрах запроса;
 *   - что весь контент приехал в HTML-ответе сервера, без выполнения JS
 *     (`fetch` скриптов не исполняет вовсе, поэтому проверка честная);
 *   - что на странице ровно один `<h1>`, ровно одно изображение без
 *     `loading="lazy"` и ровно один `fetchpriority="high"`;
 *   - что self-canonical абсолютный, в канонической форме и совпадает с адресом
 *     запроса;
 *   - что в ответе нет исполняемого `<script>` и ни одного `href="#"`;
 *   - что `ItemList` совпал с видимой сеткой на ЖИВОМ ответе, а не в фикстуре;
 *   - что файл из `<img src>` и из кнопки «Скачать» действительно отдаётся;
 *   - что пагинация ведёт себя ровно так, как решено на Э3-07: `/page/2` — 200 с
 *     self-canonical на себя и `noindex,follow`, `/page/1` — одиночный 301 на
 *     базовый URL, номер вне диапазона — 404, а ссылки на `/page/1` не
 *     появляется ни на одной странице;
 *   - что каталоги `/otkrytki` и `/podborki` отдают 200, а меню с ссылками на
 *     оба каталога есть в ответе КАЖДОЙ страницы.
 *
 * Проверка идёт против собранного сервера (`dist/server/entry.mjs`), а не против
 * `astro dev`: порядок обработки запроса и правило слеша в dev ведут себя иначе
 * (разбор — в шапке `../src/routing/path-policy.ts`).
 *
 * ## Запуск
 *
 *   pnpm --filter @otkritka/web run build
 *   pnpm --filter @otkritka/web run smoke:pages
 *
 * ## Про то, что смоук ПУБЛИКУЕТ записи
 *
 * Публикует — иначе проверять нечего: страница существует только у
 * опубликованной записи. Публикация выполняется от лица администратора из базы,
 * относится к временным записям с префиксом `smoke-e3-05-` и снимается в
 * `finally` вместе со всем остальным; итог уборки печатается числами, включая
 * число опубликованных записей в каталоге (обязано быть нулём). Граница
 * автоматизации из `CLAUDE.md` этим не сдвигается: продуктовый код не публикует
 * ничего, публикация живёт в одноразовом скрипте проверки на локальной базе.
 *
 * Тем же порядком и по той же причине смоук выдаёт решение «уникально» в калитке
 * визуальных дублей. С задачи Э3-07 калитка срабатывает штатно, и это осознанно:
 * чтобы проверить пагинацию на ЖИВОМ сервере, нужен корпус больше одной страницы
 * (`DEFAULT_CARDS_PER_PAGE` + 1 открытка), а структурно разных композиций у
 * генератора фикстур три. Остальные различаются сдвигом яркости, то есть для
 * pHash «похожи» — ровно тот случай, в котором решение принимает редактор.
 * Решение «уникально» здесь относится к синтетическим узорам во временных
 * записях локальной базы; продуктовой границы автоматизации это не сдвигает.
 *
 * ## Порядок уборки значим
 *
 * Сначала карточки, потом изображения: `apps/cms` отказывает в удалении
 * изображения, на которое ссылается карточка (`rule=image-in-use`). Обратный
 * порядок оставил бы файлы и записи в базе.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Payload } from 'payload';

import type { Collection } from '@otkritka/cms/types';

import { createPngFixture } from '../../cms/src/images/png-fixture.js';
import { DEFAULT_CARDS_PER_PAGE, payloadClient } from '../src/data/index.js';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(appDir, 'dist', 'server', 'entry.mjs');

/**
 * Хост и порт стенда. `SITE_URL` серверу задаётся РАВНЫМ этому адресу: только
 * тогда сравнение self-canonical остаётся сравнением, а не проверкой «оканчивается
 * на путь» (то же правило, что у стенда SEO-приёмки).
 */
const HOST = '127.0.0.1';
const PORT = Number(process.env.SMOKE_PAGES_PORT ?? '4399');
const ORIGIN = `http://${HOST}:${String(PORT)}`;

const PREFIX = 'smoke-e3-05';

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
 * `smoke-media.mjs` и `smoke-trailing-slash.mjs`).
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
/* Разбор ответа как ТЕКСТА: JS не исполняется вовсе                  */
/* ------------------------------------------------------------------ */

function tags(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((match) => match[0]);
}

function attr(tag: string, name: string): string | null {
  const quoted = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return quoted === null ? null : (quoted[1] ?? null);
}

/** Атрибут присутствует — в том числе БЕЗ значения (`<img … alt>`). */
function hasAttr(tag: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`, 'i').test(tag);
}

function headings(html: string): string[] {
  return [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((match) =>
    (match[1] ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/gu, ' ').trim(),
  );
}

function canonicalOf(html: string): string | null {
  const link = tags(html, 'link').find((tag) => attr(tag, 'rel') === 'canonical');
  return link === undefined ? null : attr(link, 'href');
}

function metaOf(html: string, name: string): string | null {
  const tag = tags(html, 'meta').find((candidate) => attr(candidate, 'name') === name);
  return tag === undefined ? null : attr(tag, 'content');
}

function anchors(html: string): { readonly tag: string; readonly href: string | null }[] {
  return tags(html, 'a').map((tag) => ({ href: attr(tag, 'href'), tag }));
}

function images(html: string): string[] {
  return tags(html, 'img');
}

/** Все блоки `application/ld+json`, разобранные в значения. */
function jsonLdBlocks(html: string): unknown[] {
  return [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1] ?? '')
    .map((text) => JSON.parse(text) as unknown);
}

function findByType(blocks: readonly unknown[], type: string): Record<string, unknown> | null {
  for (const block of blocks) {
    const found = findNodeByType(block, type);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/**
 * Поиск узла по `@type` в глубину.
 *
 * Именно в глубину: `ItemList` живёт свойством `mainEntity` внутри
 * `CollectionPage`, а `ImageObject` — отдельным узлом `@graph`. Плоский поиск по
 * верхнему уровню находил бы один и не находил другой — так и вышло при первом
 * прогоне смоука.
 */
function findNodeByType(value: unknown, type: string): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNodeByType(item, type);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const node = value as Record<string, unknown>;
  if (node['@type'] === type) {
    return node;
  }
  for (const nested of Object.values(node)) {
    const found = findNodeByType(nested, type);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/** Текст страницы без head, скриптов и стилей: содержание, приехавшее в ответе. */
function visibleText(html: string): string {
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return (body?.[1] ?? html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Общие для всех страниц инварианты — критерии вето V5.
 *
 * Проверяются на КАЖДОЙ отданной странице: один H1, абсолютный self-canonical в
 * канонической форме, явная директива робота, отсутствие клиентского JS и
 * отсутствие `href="#"`.
 */
function checkPageInvariants(label: string, response: RawResponse, expected: {
  readonly path: string;
  readonly robots: string;
  readonly heading: string;
}): void {
  const html = response.body;

  record(`${label}: 200`, response.status === 200, `status=${String(response.status)}`);
  const h1 = headings(html);
  record(`${label}: ровно один H1`, h1.length === 1 && h1[0] === expected.heading, JSON.stringify(h1));
  record(
    `${label}: абсолютный self-canonical без завершающего слеша`,
    canonicalOf(html) === `${ORIGIN}${expected.path}`,
    String(canonicalOf(html)),
  );
  record(
    `${label}: директива робота из записи`,
    metaOf(html, 'robots') === expected.robots,
    String(metaOf(html, 'robots')),
  );

  const scripts = tags(html, 'script');
  const executable = scripts.filter((tag) => attr(tag, 'type') !== 'application/ld+json');
  record(`${label}: исполняемого <script> нет`, executable.length === 0, executable.join(' '));
  record(`${label}: директив client:* нет`, !/\bclient:[a-z]+/i.test(html));

  const hashLinks = anchors(html).filter(
    (anchor) => anchor.href === null || anchor.href === '' || anchor.href.startsWith('#'),
  );
  record(`${label}: ни одного href="#" и ни одной ссылки без href`, hashLinks.length === 0, hashLinks.map((a) => a.tag).join(' '));

  // Меню обязано быть в ответе КАЖДОЙ страницы: «страница входит в навигацию» —
  // условие п. 5.1 ТЗ, и проверяется он на живом ответе, а не на исходниках.
  const navHrefs = anchors(html).map((anchor) => anchor.href);
  record(
    `${label}: меню со ссылками на оба каталога в ответе сервера`,
    navHrefs.includes('/otkrytki') && navHrefs.includes('/podborki') && navHrefs.includes('/'),
    `есть /otkrytki=${String(navHrefs.includes('/otkrytki'))} /podborki=${String(navHrefs.includes('/podborki'))}`,
  );

  const crumbs = findByType(jsonLdBlocks(html), 'BreadcrumbList');
  record(`${label}: разметка BreadcrumbList в ответе`, crumbs !== null);
  record(
    `${label}: крошки в видимом HTML`,
    /aria-label="Хлебные крошки"/.test(html) && /aria-current="page"/.test(html),
  );
}

/** Вводный текст подборки: абзац, внутренняя ссылка и ссылка-документ текстом. */
const INTRO: NonNullable<Collection['intro']> = {
  root: {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          {
            type: 'text',
            detail: 0,
            format: 0,
            mode: 'normal',
            style: '',
            text: 'Вводный текст смоука Э3-05: ',
            version: 1,
          },
          {
            type: 'link',
            fields: { linkType: 'custom', newTab: false, url: '/podborki/smoke-e3-05-gruppa' },
            children: [
              {
                type: 'text',
                detail: 0,
                format: 1,
                mode: 'normal',
                style: '',
                text: 'ссылка внутрь сайта',
                version: 1,
              },
            ],
            direction: 'ltr',
            format: '',
            indent: 0,
            version: 3,
          },
          {
            type: 'text',
            detail: 0,
            format: 0,
            mode: 'normal',
            style: '',
            text: ' и обычный текст после неё.',
            version: 1,
          },
        ],
        direction: 'ltr',
        format: '',
        indent: 0,
        version: 1,
      },
    ],
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
  },
};

/**
 * Уборка следов ПРЕДЫДУЩЕГО прогона — до создания фикстур.
 *
 * Нужна ровно для одного случая: прогон, оборванный снаружи (таймаут, снятие
 * процесса), до `finally` не доходит, и в базе остаются опубликованные записи. На
 * этом проекте незакрытая уборка однажды означала бы опубликованную заглушку в
 * каталоге, поэтому уборка идёт с двух сторон: своё — в `finally`, чужое
 * (оборванное) — здесь, по префиксу временных записей.
 *
 * Порядок тот же и по той же причине: карточки раньше изображений, глубокие узлы
 * раньше родителей.
 */
async function sweepLeftovers(payload: Payload): Promise<void> {
  const removed = { cards: 0, claims: 0, collections: 0, images: 0 };

  const cards = await payload.find({
    collection: 'cards',
    depth: 0,
    limit: 100,
    where: { slug: { like: PREFIX } },
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
    where: { slug: { like: PREFIX } },
  });
  for (const node of collections.docs) {
    await payload.delete({ collection: 'collections', id: node.id }).catch(() => undefined);
    removed.collections += 1;
  }

  const images = await payload.find({
    collection: 'card-images',
    depth: 0,
    limit: 100,
    where: { nameStem: { like: 'smouk-e3-05' } },
  });
  for (const image of images.docs) {
    await payload.delete({ collection: 'card-images', id: image.id }).catch(() => undefined);
    removed.images += 1;
  }

  const claims = await payload.find({
    collection: 'image-name-claims',
    depth: 0,
    limit: 100,
    where: { stem: { like: 'smouk-e3-05' } },
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

async function main(): Promise<void> {
  const payload: Payload = await payloadClient();
  await sweepLeftovers(payload);

  const created = {
    cardImages: [] as number[],
    cards: [] as number[],
    collections: [] as number[],
  };
  const claimedStems: string[] = [];
  let server: ReturnType<typeof spawn> | null = null;

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
    const adminId = adminDoc.id;

    const uploadImage = async (
      title: string,
      composition: 'grid' | 'rings' | 'stripes',
    ): Promise<number> => {
      const bytes = createPngFixture({ composition, height: 500, width: 800 });
      const image = await payload.create({
        collection: 'card-images',
        data: { title },
        file: { data: bytes, mimetype: 'image/png', name: `${composition}.png`, size: bytes.byteLength },
        ...asAdmin,
      });
      created.cardImages.push(image.id);
      if (typeof image.nameStem === 'string') {
        claimedStems.push(image.nameStem);
      }
      return image.id;
    };

    /**
     * Переход в `review`. Решение «уникально» выдаётся ТОЛЬКО если калитка
     * визуальных дублей сработала: три композиции фикстуры структурно разные,
     * поэтому в норме до второй попытки дело не доходит.
     */
    const toReview = async (collection: 'cards' | 'collections', id: number): Promise<void> => {
      try {
        await payload.update({ collection, id, data: { status: 'review' }, ...asAdmin });
      } catch (error) {
        if (collection !== 'cards') {
          throw error;
        }
        await payload.update({
          collection,
          id,
          data: {
            status: 'review',
            visualDuplicate: { confirm: true, decision: 'unique' },
          },
          ...asAdmin,
        });
      }
    };

    const publish = async (collection: 'cards' | 'collections', id: number): Promise<void> => {
      await toReview(collection, id);
      await payload.update({ collection, id, data: { status: 'published' }, ...asAdmin });
    };

    /* ------------------------------------------------------------ */
    /* Подборки: группа → повод (с карточками) и повод БЕЗ карточек  */
    /* ------------------------------------------------------------ */

    const group = await payload.create({
      collection: 'collections',
      data: {
        intro: INTRO,
        metaDescription: 'Смоук Э3-05: группирующий узел таксономии.',
        nodeKind: 'group',
        responsibleEditor: adminId,
        robots: 'noindex,follow',
        slug: `${PREFIX}-gruppa`,
        status: 'draft',
        title: 'Смоук Э3-05: группа',
      },
      ...asAdmin,
    });
    created.collections.push(group.id);

    const makeNode = async (slug: string, title: string): Promise<Collection> => {
      const node = await payload.create({
        collection: 'collections',
        data: {
          intro: INTRO,
          metaDescription: `Смоук Э3-05: ${title}`,
          nodeKind: 'occasion',
          parent: group.id,
          related: [group.id],
          responsibleEditor: adminId,
          robots: 'noindex,follow',
          slug,
          status: 'draft',
          title,
          updatedContentAt: '2026-02-14T10:00:00.000Z',
        },
        ...asAdmin,
      });
      created.collections.push(node.id);
      return node;
    };

    const occasion = await makeNode(`${PREFIX}-povod`, 'Смоук Э3-05: повод с открытками');

    await payload.update({
      collection: 'collections',
      id: group.id,
      data: { related: [occasion.id] },
      ...asAdmin,
    });

    /* ------------------------------------------------------------ */
    /* Карточки: корпус на две страницы, одна draft, одна review    */
    /* ------------------------------------------------------------ */
    //
    // ПОРЯДОК ЗНАЧИМ: открытки публикуются РАНЬШЕ узлов. CMS не даёт опубликовать
    // подборку, у которой опубликованных открыток меньше порога Ч-06
    // (`assertPublishableVolume`, `COLLECTION_MIN_PUBLISHED_CARDS`), а карточка
    // публикуется независимо от статуса своих подборок. Обратный порядок —
    // прежний в этом смоуке — теперь получает отказ `thin-content-for-publish`.
    //
    // Узла «повод без открыток» в фикстурах больше нет по той же причине: пустую
    // подборку CMS публиковать не даёт вовсе, поэтому состояние «опубликованная
    // подборка без содержания» через админку и API недостижимо. Ветка 404 в
    // шаблоне остаётся защитной и проверяется юнит-тестом
    // (`collectionPageContent` возвращает null).

    const makeCard = async (args: {
      readonly composition?: 'grid' | 'rings' | 'stripes';
      readonly slug: string;
      readonly title: string;
    }): Promise<number> => {
      const imageId =
        args.composition === undefined ? undefined : await uploadImage(args.title, args.composition);
      const card = await payload.create({
        collection: 'cards',
        data: {
          alt: `Синтетический узор фикстуры: ${args.title}`,
          caption: `Подпись смоука: ${args.title}`,
          collections: [occasion.id, group.id],
          description: `Видимое описание открытки «${args.title}».`,
          ...(imageId === undefined ? {} : { image: imageId }),
          metaDescription: `Смоук Э3-05, meta description: ${args.title}`,
          robots: 'noindex,follow',
          slug: args.slug,
          status: 'draft',
          title: args.title,
        },
        ...asAdmin,
      });
      created.cards.push(card.id);
      return card.id;
    };

    const mainCardId = await makeCard({
      composition: 'grid',
      slug: `${PREFIX}-otkrytka-odna`,
      title: 'Смоук Э3-05: открытка первая',
    });
    const secondCardId = await makeCard({
      composition: 'rings',
      slug: `${PREFIX}-otkrytka-dva`,
      title: 'Смоук Э3-05: открытка вторая',
    });
    const thirdCardId = await makeCard({
      composition: 'stripes',
      slug: `${PREFIX}-otkrytka-tri`,
      title: 'Смоук Э3-05: открытка третья',
    });
    // Черновик остаётся в `draft`: идентификатор дальше не нужен — запись
    // проверяется по её адресу, который обязан отвечать 404.
    await makeCard({
      slug: `${PREFIX}-otkrytka-draft`,
      title: 'Смоук Э3-05: открытка в draft',
    });
    const reviewCardId = await makeCard({
      composition: 'grid',
      slug: `${PREFIX}-otkrytka-review`,
      title: 'Смоук Э3-05: открытка в review',
    });

    for (const id of [mainCardId, secondCardId, thirdCardId]) {
      await publish('cards', id);
    }
    await toReview('cards', reviewCardId);

    /* ------------------------------------------------------------ */
    /* Корпус для пагинации: страниц ровно две                      */
    /* ------------------------------------------------------------ */

    // Ровно на одну открытку больше страницы — так проверяется и граница расчёта
    // (24 открытки дают ОДНУ страницу, 25 — две), и то, что на второй странице
    // сетка не пуста.
    const COMPOSITIONS = ['grid', 'rings', 'stripes'] as const;
    const filler = DEFAULT_CARDS_PER_PAGE + 1 - 3;
    for (let index = 0; index < filler; index += 1) {
      const number = index + 4;
      const bytes = createPngFixture({
        composition: COMPOSITIONS[index % COMPOSITIONS.length] ?? 'grid',
        height: 500,
        luminanceShift: (index % 9) * 7 - 28,
        width: 800,
      });
      const image = await payload.create({
        collection: 'card-images',
        data: { title: `Смоук Э3-05: открытка ${String(number)}` },
        file: { data: bytes, mimetype: 'image/png', name: 'filler.png', size: bytes.byteLength },
        ...asAdmin,
      });
      created.cardImages.push(image.id);
      if (typeof image.nameStem === 'string') {
        claimedStems.push(image.nameStem);
      }
      const card = await payload.create({
        collection: 'cards',
        data: {
          alt: `Синтетический узор фикстуры номер ${String(number)}`,
          caption: `Подпись смоука: открытка ${String(number)}`,
          collections: [occasion.id],
          description: `Видимое описание открытки номер ${String(number)}.`,
          image: image.id,
          metaDescription: `Смоук Э3-05, открытка ${String(number)}`,
          robots: 'noindex,follow',
          slug: `${PREFIX}-otkrytka-${String(number)}`,
          status: 'draft',
          title: `Смоук Э3-05: открытка ${String(number)}`,
        },
        ...asAdmin,
      });
      created.cards.push(card.id);
      await publish('cards', card.id);
    }
    console.log(`Корпус пагинации: ${String(filler + 3)} открыток в подборке`);

    // Узлы публикуются последними: теперь порог Ч-06 выполнен. Родитель раньше
    // ребёнка — ссылки на неопубликованный узел не бывает.
    await publish('collections', group.id);
    await publish('collections', occasion.id);

    /* ------------------------------------------------------------ */
    /* Собранный сервер                                             */
    /* ------------------------------------------------------------ */

    server = spawn(process.execPath, [serverEntry], {
      cwd: appDir,
      env: { ...process.env, HOST, PORT: String(PORT), SITE_URL: ORIGIN },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitForServer();
    console.log(`\nПроверки против ${ORIGIN}\n`);

    /* ------------------------------------------------------------ */
    /* 1. Карточка                                                  */
    /* ------------------------------------------------------------ */

    const cardPath = `/otkrytki/${PREFIX}-otkrytka-odna`;
    const cardResponse = await request(cardPath);
    const cardHtml = cardResponse.body;

    checkPageInvariants('карточка', cardResponse, {
      heading: 'Смоук Э3-05: открытка первая',
      path: cardPath,
      robots: 'noindex,follow',
    });

    const cardText = visibleText(cardHtml);
    record(
      'карточка: подпись и описание в HTML-ответе сервера',
      cardText.includes('Подпись смоука: Смоук Э3-05: открытка первая') &&
        cardText.includes('Видимое описание открытки'),
    );

    const cardImages = images(cardHtml);
    const eager = cardImages.filter((tag) => !hasAttr(tag, 'loading'));
    record(
      'карточка: ровно одно изображение без loading',
      eager.length === 1,
      `всего=${String(cardImages.length)} без loading=${String(eager.length)}`,
    );
    record(
      'карточка: ровно один fetchpriority="high"',
      cardImages.filter((tag) => attr(tag, 'fetchpriority') === 'high').length === 1,
    );
    record(
      'карточка: у каждого <img> есть src, width, height и alt',
      cardImages.every(
        (tag) =>
          (attr(tag, 'src') ?? '').startsWith('/media/') &&
          attr(tag, 'width') !== null &&
          attr(tag, 'height') !== null &&
          hasAttr(tag, 'alt'),
      ),
      `изображений=${String(cardImages.length)}`,
    );
    record(
      'карточка: у остальных изображений loading="lazy"',
      cardImages.filter((tag) => attr(tag, 'loading') === 'lazy').length === cardImages.length - 1,
    );
    record('карточка: <picture> с source AVIF и WebP', /<source[^>]*image\/avif/.test(cardHtml) && /<source[^>]*image\/webp/.test(cardHtml));

    const mainImg = eager[0] ?? '';
    const mainSrc = attr(mainImg, 'src') ?? '';
    const fileResponse = await request(mainSrc);
    record(
      'карточка: файл из <img src> действительно отдаётся',
      fileResponse.status === 200 && fileResponse.headers['cache-control'] === 'public, max-age=31536000, immutable',
      `${mainSrc} → ${String(fileResponse.status)}`,
    );

    const download = anchors(cardHtml).find((anchor) => hasAttr(anchor.tag, 'download'));
    record(
      'карточка: кнопка «Скачать» — прямая ссылка на файл, без JS',
      download !== undefined && (download.href ?? '').startsWith('/media/') && (download.href ?? '').endsWith('.jpg'),
      String(download?.href),
    );

    const shareHosts = ['api.whatsapp.com', 't.me', 'vk.com', 'connect.ok.ru'];
    const shareLinks = anchors(cardHtml).filter((anchor) =>
      shareHosts.some((host) => (anchor.href ?? '').includes(host)),
    );
    record(
      'карточка: четыре ссылки «поделиться» через share-URL, все с rel=nofollow',
      shareLinks.length === 4 && shareLinks.every((anchor) => (attr(anchor.tag, 'rel') ?? '').includes('nofollow')),
      `найдено=${String(shareLinks.length)}`,
    );
    record(
      'карточка: внешних SDK не подключается',
      !/<script[^>]+src=/i.test(cardHtml),
    );

    const similarLinks = anchors(cardHtml).filter(
      (anchor) => (anchor.href ?? '').startsWith('/otkrytki/') && anchor.href !== cardPath,
    );
    record(
      'карточка: блок «Похожие» ссылается на соседние карточки (Ч-04-8)',
      similarLinks.length > 0 && similarLinks.length <= 12,
      `${String(similarLinks.length)} ссылок`,
    );
    record(
      'карточка: атрибуты-ссылки ведут на подборки',
      anchors(cardHtml).some((anchor) => anchor.href === `/podborki/${PREFIX}-gruppa/${PREFIX}-povod`) &&
        anchors(cardHtml).some((anchor) => anchor.href === `/podborki/${PREFIX}-gruppa`),
    );

    const cardBlocks = jsonLdBlocks(cardHtml);
    const webPage = findByType(cardBlocks, 'WebPage');
    const imageObject = findByType(cardBlocks, 'ImageObject');
    record('карточка: разметка WebPage и ImageObject', webPage !== null && imageObject !== null);
    record(
      'карточка: WebPage.url совпадает с self-canonical',
      webPage?.['url'] === `${ORIGIN}${cardPath}`,
      String(webPage?.['url']),
    );
    record(
      'карточка: ImageObject.contentUrl — абсолютный адрес ТОГО файла, что в кнопке «Скачать»',
      imageObject?.['contentUrl'] === `${ORIGIN}${String(download?.href)}`,
      String(imageObject?.['contentUrl']),
    );
    record(
      'карточка: незаполненный глобал не даёт лицензионных свойств (Ч-10)',
      ['creator', 'creditText', 'copyrightNotice', 'license', 'acquireLicensePage'].every(
        (property) => !(property in (imageObject ?? {})),
      ),
      Object.keys(imageObject ?? {}).join(','),
    );

    const slashResponse = await request(`${cardPath}/`);
    record(
      'карточка: обращение со слешем даёт одиночный 301 на форму без слеша',
      slashResponse.status === 301 && slashResponse.headers.location === cardPath,
      `${String(slashResponse.status)} → ${String(slashResponse.headers.location)}`,
    );

    /* ------------------------------------------------------------ */
    /* 2. Подборка с открытками                                     */
    /* ------------------------------------------------------------ */

    const collectionPath = `/podborki/${PREFIX}-gruppa/${PREFIX}-povod`;
    const collectionResponse = await request(collectionPath);
    const collectionHtml = collectionResponse.body;

    checkPageInvariants('подборка', collectionResponse, {
      heading: 'Смоук Э3-05: повод с открытками',
      path: collectionPath,
      robots: 'noindex,follow',
    });

    const gridLinks = anchors(collectionHtml)
      .filter((anchor) => (anchor.href ?? '').startsWith('/otkrytki/'))
      .map((anchor) => anchor.href ?? '');
    record(
      'подборка: первая страница вмещает ровно размер страницы',
      gridLinks.length === DEFAULT_CARDS_PER_PAGE,
      `${String(gridLinks.length)} из ${String(DEFAULT_CARDS_PER_PAGE)}`,
    );

    const collectionImages = images(collectionHtml);
    record(
      'подборка: первая плитка без loading, остальные ленивые',
      collectionImages.filter((tag) => !hasAttr(tag, 'loading')).length === 1 &&
        collectionImages.filter((tag) => attr(tag, 'loading') === 'lazy').length ===
          collectionImages.length - 1,
      `изображений=${String(collectionImages.length)}`,
    );

    const itemList = findByType(jsonLdBlocks(collectionHtml), 'ItemList');
    const elements = (itemList?.['itemListElement'] ?? []) as { name: string; url: string }[];
    record(
      'подборка: ItemList совпадает с видимой сеткой — состав, порядок, количество',
      itemList?.['numberOfItems'] === gridLinks.length &&
        elements.length === gridLinks.length &&
        elements.every((element, index) => element.url === `${ORIGIN}${gridLinks[index] ?? ''}`),
      JSON.stringify(elements.map((element) => element.url)),
    );
    record(
      'подборка: разметка CollectionPage',
      findByType(jsonLdBlocks(collectionHtml), 'CollectionPage') !== null,
    );

    const collectionText = visibleText(collectionHtml);
    record(
      'подборка: вводный текст в HTML-ответе сервера',
      collectionText.includes('Вводный текст смоука Э3-05'),
    );
    record(
      'подборка: внутренняя ссылка вводного текста — <a href> на путь',
      anchors(collectionHtml).some((anchor) => anchor.href === `/podborki/${PREFIX}-gruppa`),
    );
    record(
      'подборка: во вводном тексте нет ни одного href="#"',
      !collectionHtml.includes('href="#"') && !cardHtml.includes('href="#"'),
    );
    // Сравниваются ВИДИМАЯ дата и `dateModified` друг с другом, а не с датой
    // фикстуры: значение `updatedContentAt` может проставить сама CMS при
    // публикации, и проверять надо соответствие разметки экрану, а не то, какую
    // дату записал смоук.
    const visibleDate = /<time datetime="([^"]+)"/.exec(collectionHtml)?.[1] ?? '';
    const dateModified = findByType(jsonLdBlocks(collectionHtml), 'CollectionPage')?.['dateModified'];
    record(
      'подборка: дата содержательного обновления видна и совпадает с dateModified',
      visibleDate !== '' &&
        !Number.isNaN(new Date(visibleDate).getTime()) &&
        dateModified === visibleDate,
      `видимая=${visibleDate} dateModified=${String(dateModified)}`,
    );
    record(
      'подборка: перелинковка вверх на родителя и вбок на смежные',
      anchors(collectionHtml).some((anchor) => anchor.href === `/podborki/${PREFIX}-gruppa`),
    );
    // Фикстура нарочно указывает родителя ещё и в `related`: так проверяется, что
    // блок перелинковки не выводит две одинаковые ссылки на один адрес.
    const alsoBlock = /<nav class="page-section"[^>]*aria-label="Смежные подборки"[\s\S]*?<\/nav>/.exec(collectionHtml)?.[0] ?? '';
    const alsoLinks = anchors(alsoBlock).map((anchor) => anchor.href ?? '');
    record(
      'подборка: в блоке «Смотрите также» нет двух ссылок на один адрес',
      alsoLinks.length === new Set(alsoLinks).size && alsoLinks.length > 0,
      alsoLinks.join(' '),
    );
    record('подборка: ссылок на /page/1 нет нигде (решение Ч-05)', !collectionHtml.includes('/page/1'));

    /* ------------------------------------------------------------ */
    /* 3. Группирующий узел: содержание — дети                      */
    /* ------------------------------------------------------------ */

    const groupPath = `/podborki/${PREFIX}-gruppa`;
    const groupResponse = await request(groupPath);

    checkPageInvariants('группирующий узел', groupResponse, {
      heading: 'Смоук Э3-05: группа',
      path: groupPath,
      robots: 'noindex,follow',
    });
    record(
      'группирующий узел: в списке — дочерние узлы, ItemList из них же',
      anchors(groupResponse.body).some((anchor) => anchor.href === collectionPath) &&
        (findByType(jsonLdBlocks(groupResponse.body), 'ItemList')?.['numberOfItems'] as number) >= 1,
    );

    /* ------------------------------------------------------------ */
    /* 4. Пагинация списка подборки (задача Э3-07)                  */
    /* ------------------------------------------------------------ */

    record(
      'подборка: блок пагинации есть и ведёт на страницу 2',
      /aria-label="Страницы подборки"/.test(collectionHtml) &&
        anchors(collectionHtml).some((anchor) => anchor.href === `${collectionPath}/page/2`),
    );

    const pageTwoPath = `${collectionPath}/page/2`;
    const pageTwo = await request(pageTwoPath);
    const pageTwoHtml = pageTwo.body;

    checkPageInvariants('подборка, страница 2', pageTwo, {
      heading: 'Смоук Э3-05: повод с открытками — страница 2',
      path: pageTwoPath,
      robots: 'noindex,follow',
    });

    record(
      'страница 2: в сетке остаток списка',
      anchors(pageTwoHtml).filter((anchor) => (anchor.href ?? '').startsWith('/otkrytki/')).length === 1,
    );
    const pagingBlock = /<nav class="pagination"[\s\S]*?<\/nav>/.exec(pageTwoHtml)?.[0] ?? '';
    const pagingHrefs = anchors(pagingBlock).map((anchor) => anchor.href);
    record(
      'страница 2: «предыдущая» ведёт на БАЗОВЫЙ URL, а не на /page/1',
      pagingHrefs.includes(collectionPath) && !pageTwoHtml.includes('/page/1'),
      pagingHrefs.join(' '),
    );
    record(
      'страница 2: rel=next и rel=prev не выводятся (решение Э3-07)',
      !/rel="(next|prev)"/.test(pageTwoHtml),
    );
    record(
      'страница 2: description не выводится вовсе, а не повторяет первую страницу',
      metaOf(pageTwoHtml, 'description') === null,
      String(metaOf(pageTwoHtml, 'description')),
    );
    record(
      'страница 2: вводный текст подборки не повторяется',
      !visibleText(pageTwoHtml).includes('Вводный текст смоука Э3-05'),
    );
    const crumbsBlock =
      /<nav class="breadcrumbs"[\s\S]*?<\/nav>/.exec(pageTwoHtml)?.[0] ?? '';
    record(
      'страница 2: последняя крошка — номер страницы, а сам список стал ссылкой',
      visibleText(crumbsBlock).endsWith('Страница 2') &&
        /aria-current="page"/.test(crumbsBlock) &&
        anchors(crumbsBlock).some((anchor) => anchor.href === collectionPath),
      visibleText(crumbsBlock),
    );

    const pageOne = await request(`${collectionPath}/page/1`);
    record(
      '/page/1 подборки — одиночный 301 на базовый URL (решение Э3-07)',
      pageOne.status === 301 && pageOne.headers.location === collectionPath,
      `${String(pageOne.status)} → ${String(pageOne.headers.location)}`,
    );
    const afterHop = await request(String(pageOne.headers.location));
    record(
      '/page/1: переход один, а не цепочка — цель отвечает 200',
      afterHop.status === 200,
      `status=${String(afterHop.status)}`,
    );

    const badPages = [
      `${collectionPath}/page/3`,
      `${collectionPath}/page/999`,
      `${collectionPath}/page/0`,
      `${collectionPath}/page/01`,
      `${collectionPath}/page/-1`,
      `${collectionPath}/page/dva`,
      `${collectionPath}/page`,
      `/otkrytki/page/0`,
      `/otkrytki/page/01`,
      `/otkrytki/page/999`,
      `/otkrytki/page`,
      '/podborki/page/2',
    ];
    for (const target of badPages) {
      const response = await request(target);
      record(
        `номер вне диапазона — 404 без редиректа: ${target}`,
        response.status === 404 && response.headers.location === undefined,
        `status=${String(response.status)}`,
      );
    }

    /* ------------------------------------------------------------ */
    /* 5. Каталоги разделов (задача Э3-08)                          */
    /* ------------------------------------------------------------ */

    const cardsCatalog = await request('/otkrytki');
    checkPageInvariants('каталог /otkrytki', cardsCatalog, {
      heading: 'Все открытки',
      path: '/otkrytki',
      robots: 'noindex,follow',
    });
    // Ссылка на страницу пагинации тоже начинается с `/otkrytki/`, но плиткой не
    // является — иначе счёт сетки зависел бы от наличия блока пагинации.
    const catalogTiles = anchors(cardsCatalog.body).filter(
      (anchor) =>
        (anchor.href ?? '').startsWith('/otkrytki/') && !(anchor.href ?? '').includes('/page/'),
    );
    record(
      'каталог /otkrytki: сетка открыток и блок пагинации',
      catalogTiles.length === DEFAULT_CARDS_PER_PAGE &&
        anchors(cardsCatalog.body).some((anchor) => anchor.href === '/otkrytki/page/2'),
      `плиток=${String(catalogTiles.length)} из ${String(DEFAULT_CARDS_PER_PAGE)}`,
    );
    record('каталог /otkrytki: ссылок на /page/1 нет нигде', !cardsCatalog.body.includes('/page/1'));

    const cardsCatalogTwo = await request('/otkrytki/page/2');
    checkPageInvariants('каталог /otkrytki, страница 2', cardsCatalogTwo, {
      heading: 'Все открытки — страница 2',
      path: '/otkrytki/page/2',
      robots: 'noindex,follow',
    });
    record(
      'каталог /otkrytki: «предыдущая» ведёт на базовый URL каталога',
      anchors(cardsCatalogTwo.body).some((anchor) => anchor.href === '/otkrytki') &&
        !cardsCatalogTwo.body.includes('/page/1'),
    );

    const catalogRedirect = await request('/otkrytki/page/1');
    record(
      '/otkrytki/page/1 — одиночный 301 на /otkrytki',
      catalogRedirect.status === 301 && catalogRedirect.headers.location === '/otkrytki',
      `${String(catalogRedirect.status)} → ${String(catalogRedirect.headers.location)}`,
    );

    const nodesCatalog = await request('/podborki');
    checkPageInvariants('каталог /podborki', nodesCatalog, {
      heading: 'Подборки открыток',
      path: '/podborki',
      robots: 'noindex,follow',
    });
    record(
      'каталог /podborki: в списке узел верхнего уровня и его ребёнок',
      anchors(nodesCatalog.body).some((anchor) => anchor.href === groupPath) &&
        anchors(nodesCatalog.body).some((anchor) => anchor.href === collectionPath),
    );
    const catalogList = findByType(jsonLdBlocks(nodesCatalog.body), 'ItemList');
    record(
      'каталог /podborki: ItemList соответствует видимому списку',
      (catalogList?.['numberOfItems'] as number) >= 2,
      JSON.stringify(catalogList?.['numberOfItems']),
    );

    /* ------------------------------------------------------------ */
    /* 6. Отказы: пустая подборка, draft, review                    */
    /* ------------------------------------------------------------ */

    const draftTargets = [
      `/otkrytki/${PREFIX}-otkrytka-draft`,
      `/otkrytki/${PREFIX}-otkrytka-draft?utm_source=test`,
      `/otkrytki/${PREFIX}-otkrytka-draft?draft=true&preview=1`,
      `/otkrytki/${PREFIX}-otkrytka-review`,
      `/otkrytki/${PREFIX}-otkrytka-review?draft=true`,
    ];
    for (const target of draftTargets) {
      const response = await request(target);
      record(
        `черновик/review не отдаётся: ${target}`,
        response.status === 404 && response.headers.location === undefined,
        `status=${String(response.status)}`,
      );
    }

    /* ------------------------------------------------------------ */
    /* 7. Браузер с ОТКЛЮЧЁННЫМ JS                                  */
    /* ------------------------------------------------------------ */

    await checkWithJavaScriptDisabled([
      { path: cardPath, withImages: true },
      { path: collectionPath, withImages: true },
      { path: pageTwoPath, withImages: true },
      { path: '/otkrytki', withImages: true },
      // Каталог подборок — карта разделов ссылками; изображений на нём нет вовсе,
      // и требовать их означало бы требовать сетку там, где её не должно быть.
      { path: '/podborki', withImages: false },
    ]);

    // Задержка перед уборкой — для ручной проверки curl'ом по живым страницам.
    // Ограничена по времени намеренно: уборка обязана произойти сама, а не
    // зависеть от того, вспомнит ли о ней человек.
    const holdMs = Number(process.env.SMOKE_PAGES_HOLD_MS ?? '0');
    if (Number.isInteger(holdMs) && holdMs > 0) {
      console.log(
        `\nСервер держится ${String(holdMs)} мс для ручной проверки:\n` +
          `  curl -i ${ORIGIN}${collectionPath}\n` +
          `  curl -i ${ORIGIN}${collectionPath}/page/2\n` +
          `  curl -i ${ORIGIN}${collectionPath}/page/1\n` +
          `  curl -i ${ORIGIN}${collectionPath}/page/999\n` +
          `  curl -i ${ORIGIN}${collectionPath}/page/0\n` +
          `  curl -i ${ORIGIN}${collectionPath}/page/01\n` +
          `  curl -i ${ORIGIN}/otkrytki\n` +
          `  curl -i ${ORIGIN}/podborki\n`,
      );
      await delay(holdMs);
    }
  } finally {
    if (server !== null) {
      server.kill();
    }

    const cleanup = await payloadClient();
    // Порядок значим: карточки раньше изображений — CMS отказывает в удалении
    // изображения, на которое ссылается карточка (rule=image-in-use).
    for (const id of created.cards) {
      await cleanup.delete({ collection: 'cards', id }).catch(() => undefined);
      await cleanup
        .delete({
          collection: 'seo-history',
          where: {
            and: [{ documentCollection: { equals: 'cards' } }, { documentId: { equals: String(id) } }],
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
      cards: (await cleanup.count({ collection: 'cards' })).totalDocs,
      claims: (await cleanup.count({ collection: 'image-name-claims' })).totalDocs,
      collections: (await cleanup.count({ collection: 'collections' })).totalDocs,
      history: (await cleanup.count({ collection: 'seo-history' })).totalDocs,
      images: (await cleanup.count({ collection: 'card-images' })).totalDocs,
      publishedCards: (
        await cleanup.count({ collection: 'cards', where: { status: { equals: 'published' } } })
      ).totalDocs,
      publishedNodes: (
        await cleanup.count({
          collection: 'collections',
          where: { status: { equals: 'published' } },
        })
      ).totalDocs,
    };
    console.log(
      `\nПосле уборки: cards=${String(counts.cards)} collections=${String(counts.collections)} ` +
        `card-images=${String(counts.images)} image-name-claims=${String(counts.claims)} ` +
        `seo-history=${String(counts.history)} ` +
        `published=${String(counts.publishedCards)}/${String(counts.publishedNodes)}`,
    );

    const failed = checks.filter((check) => !check.ok);
    console.log(`\nПроверок: ${String(checks.length)}, провалено: ${String(failed.length)}`);
    for (const check of failed) {
      console.log(`  - ${check.name}${check.detail === '' ? '' : ` (${check.detail})`}`);
    }
    if (
      failed.length > 0 ||
      counts.publishedCards > 0 ||
      counts.publishedNodes > 0 ||
      counts.cards > 0 ||
      counts.collections > 0 ||
      counts.images > 0
    ) {
      process.exitCode = 1;
    }
  }
}

/**
 * Проверка в настоящем браузере с ОТКЛЮЧЁННЫМ JS.
 *
 * Playwright — devDependency корня, а не `apps/web`, поэтому импорт динамический:
 * недоступность браузера обязана давать честную строку «не проверено», а не
 * зелёный смоук и не падение из-за отсутствующей зависимости. Текстовые проверки
 * выше и без браузера показывают, что контент приехал в ответе сервера (`fetch`
 * скриптов не исполняет вовсе); браузер добавляет то, чего текстом не показать —
 * что страница ОТОБРАЖАЕТСЯ без JS.
 */
interface JsDisabledTarget {
  readonly path: string;
  /** Есть ли на странице изображения. У карты разделов их нет. */
  readonly withImages: boolean;
}

async function checkWithJavaScriptDisabled(
  targets: readonly JsDisabledTarget[],
): Promise<void> {
  // Тип берётся выводом из динамического импорта, а не аннотацией
  // `typeof import(...)`: аннотации такого вида запрещены правилом
  // `consistent-type-imports`, а статический импорт значения сделал бы playwright
  // обязательной зависимостью смоука.
  const playwright = await import('@playwright/test').catch((error: unknown) => {
    record(
      'браузер с отключённым JS: НЕ ПРОВЕРЕНО',
      false,
      `playwright недоступен: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  });
  if (playwright === null) {
    return;
  }
  const { chromium } = playwright;

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    for (const target of targets) {
      await page.goto(`${ORIGIN}${target.path}`, { waitUntil: 'domcontentloaded' });
      const h1 = await page.locator('h1').allInnerTexts();
      const images_ = page.locator('img');
      const count = await images_.count();
      const first = images_.first();
      const alt = count === 0 ? null : await first.getAttribute('alt');
      const visible = count === 0 ? false : await first.isVisible();
      const crumbs = await page.locator('nav[aria-label="Хлебные крошки"] a').count();
      // Меню обязано работать без JS на каждой странице: раскрывающихся панелей
      // в нём нет вовсе, поэтому ссылки видны сразу.
      const nav = await page.locator('nav[aria-label="Основная навигация"] a').count();
      const imagesOk = target.withImages ? visible : count === 0;

      record(
        `браузер без JS: ${target.path} — H1, меню, крошки и содержание видны`,
        h1.length === 1 && h1[0] !== '' && crumbs >= 1 && nav >= 3 && imagesOk,
        `h1=${String(h1.length)} меню=${String(nav)} крошек=${String(crumbs)} ` +
          `изображений=${String(count)} alt=${JSON.stringify(alt)}`,
      );
    }
    await context.close();
  } finally {
    await browser.close();
  }
}

await main();
process.exit(process.exitCode ?? 0);
