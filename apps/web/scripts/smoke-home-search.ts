/**
 * Смоук главной, внутреннего поиска, фильтра представления и рекламных мест на
 * СОБРАННОМ сервере (задачи Э3-09, Э3-10, Э3-12).
 *
 * ## Что проверяется только здесь
 *
 * Юнит-тесты доказывают свойства ЗНАЧЕНИЙ: состав разметки главной, окно показа
 * сезонного блока, нормализацию запроса, независимость canonical от параметров,
 * отбор рекламных мест. Они не доказывают того, что проверяет этот скрипт:
 *
 *   - что главная СОБИРАЕТСЯ НА ЗАПРОСЕ: сезонный блок переключается датами из
 *     CMS без пересборки — это критерий готовности Э3-09, и проверить его можно
 *     только сдвигая границы окна у живой записи;
 *   - что при ПУСТОМ глобале в ответе нет даже строки `Organization`, а при
 *     заполненном узел появляется (решение Ч-17);
 *   - что `/search` отвечает 200 и `noindex` при любом запросе, а его canonical
 *     не зависит от параметров;
 *   - что фильтр `?format=…` меняет ТОЛЬКО представление: canonical чистый,
 *     директива закрывается, число плиток меняется, `ItemList` следует за
 *     видимой сеткой, а ссылок на `/page/1` не появляется;
 *   - что рекламный ряд встаёт между H1 и сеткой, блок без размеров не выводится
 *     вовсе, и в разметке рекламы нет ни `<script>`, ни `<iframe>`;
 *   - что на странице 404 есть ссылка на поиск (ТЗ §5.6).
 *
 * ## Запуск
 *
 *   pnpm --filter @otkritka/web run build
 *   pnpm --filter @otkritka/web run smoke:home
 *
 * ## Про то, что смоук ПУБЛИКУЕТ записи и правит глобал
 *
 * Публикует: страница подборки существует только у опубликованной записи.
 * Публикация выполняется от лица администратора из базы, относится к временным
 * записям с префиксом `smoke-e3-09-` и снимается в `finally`; итог уборки
 * печатается числами, включая число опубликованных записей (обязано быть нулём).
 * Граница автоматизации не сдвигается: продуктовый код не публикует ничего.
 *
 * ЗАМЕЧЕНО ЗДЕСЬ: `updateGlobal` с `organization: {}` группу НЕ очищает, а
 * сливает данные — поле, которого нет в объекте, остаётся прежним. Поэтому и
 * обнуление, и восстановление перечисляют поля по именам ({@link
 * EMPTY_ORGANIZATION}), а результат восстановления ПРОВЕРЯЕТСЯ повторным чтением
 * глобала. Первый прогон этого смоука оставлял в базе тестовое название
 * организации и докладывал «восстановлены: да».
 *
 * Правит глобал «Настройки сайта» — группу `organization` и ряды `adSlots`, —
 * потому что оба состояния (пусто / заполнено) проверяемы только на живом
 * ответе. Прежние значения снимаются в начале и восстанавливаются в `finally`
 * тем же вызовом; при обрыве прогона в базе остаются ТЕСТОВЫЕ значения глобала,
 * и об этом печатается явное предупреждение — молча оставить чужие настройки
 * нельзя.
 *
 * ## Порядок уборки значим
 *
 * Карточки раньше изображений: CMS отказывает в удалении изображения, на которое
 * ссылается карточка (`rule=image-in-use`). Узлы — от листа к корню.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Payload } from 'payload';

import type { Collection, SiteSetting } from '@otkritka/cms/types';

import { createPngFixture } from '../../cms/src/images/png-fixture.js';
import { payloadClient } from '../src/data/index.js';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(appDir, 'dist', 'server', 'entry.mjs');

const HOST = '127.0.0.1';
const PORT = Number(process.env.SMOKE_HOME_PORT ?? '4401');
const ORIGIN = `http://${HOST}:${String(PORT)}`;

const PREFIX = 'smoke-e3-09';
/** Основа имени файла: пайплайн собирает её транслитерацией заголовка. */
const IMAGE_STEM_PREFIX = 'smouk-e3-09';

const LEFTOVER_FILTERS = {
  cards: { slug: { like: PREFIX } },
  claims: { stem: { like: IMAGE_STEM_PREFIX } },
  collections: { slug: { like: PREFIX } },
  images: { nameStem: { like: IMAGE_STEM_PREFIX } },
} as const;

/**
 * Вводный текст узла: без него CMS не пускает подборку в `review`
 * (`incomplete-for-review` — проверка полноты, ТЗ §8.2). Один абзац достаточен:
 * смоук проверяет не редактуру, а маршруты.
 */
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
            text: 'Вводный текст смоука Э3-09: временная подборка для проверки маршрутов.',
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
 * ПУСТАЯ группа организации — с ЯВНЫМИ `null` по каждому полю.
 *
 * Найдено этим смоуком: `updateGlobal` с `organization: {}` не очищает группу, а
 * СЛИВАЕТ данные — отсутствующее в объекте поле остаётся прежним. Поэтому и
 * «обнуление перед проверкой пустого глобала», и восстановление снимка обязаны
 * перечислять поля по именам. Иначе тестовые значения остаются в базе, а смоук
 * докладывает, что настройки восстановлены.
 */
const EMPTY_ORGANIZATION: NonNullable<SiteSetting['organization']> = {
  email: null,
  legalName: null,
  logo: null,
  name: null,
  sameAs: [],
  telephone: null,
};

/** Заполненное значение или `null` — форма, в которой поле уходит в глобал. */
function orNull(value: string | null | undefined): string | null {
  const text = value?.trim() ?? '';
  return text === '' ? null : text;
}

/** Снимок группы организации в форме, пригодной для точного восстановления. */
function organizationRestore(
  snapshot: SiteSetting['organization'],
): NonNullable<SiteSetting['organization']> {
  return {
    email: orNull(snapshot?.email),
    legalName: orNull(snapshot?.legalName),
    logo: orNull(snapshot?.logo),
    name: orNull(snapshot?.name),
    sameAs: snapshot?.sameAs ?? [],
    telephone: orNull(snapshot?.telephone),
  };
}

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

/** Один запрос СЫРОЙ целью через `node:http`: `fetch` свернул бы путь парсером URL. */
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

function hrefs(html: string): string[] {
  return tags(html, 'a')
    .map((tag) => attr(tag, 'href'))
    .filter((href): href is string => href !== null);
}

function jsonLdBlocks(html: string): unknown[] {
  return [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1] ?? '')
    .map((text) => JSON.parse(text) as unknown);
}

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
 * Разметка ОДНОГО блока `<nav>` по его подписи.
 *
 * Нужна, потому что проверять сезонный блок по всему ответу нельзя: ссылки на те
 * же узлы законно печатает блок «Разделы сайта» (он перечисляет детей узлов
 * верхнего уровня). Первый прогон смоука на этом и споткнулся — утверждение
 * «узла вне окна на странице нет» было неверным по формулировке, а не по коду.
 */
function navSection(html: string, ariaLabel: string): string | null {
  const found = new RegExp(`<nav[^>]*aria-label="${ariaLabel}"[\\s\\S]*?</nav>`, 'i').exec(html);
  return found === null ? null : found[0];
}

/** Число плиток сетки открыток в ответе. */
function gridTiles(html: string): number {
  return [...html.matchAll(/class="card-grid__link"/g)].length;
}

/** Число зарезервированных рекламных коробок в ответе. */
function adBoxes(html: string): number {
  return [...html.matchAll(/class="ad-row__slot"/g)].length;
}

/** Общие инварианты любой отданной страницы. */
function checkPageInvariants(
  label: string,
  response: RawResponse,
  expected: { readonly canonicalPath: string; readonly robots: string },
): void {
  const html = response.body;
  record(`${label}: 200`, response.status === 200, `status=${String(response.status)}`);
  record(`${label}: ровно один H1`, headings(html).length === 1, JSON.stringify(headings(html)));
  record(
    `${label}: абсолютный self-canonical на чистый путь`,
    canonicalOf(html) === `${ORIGIN}${expected.canonicalPath}`,
    String(canonicalOf(html)),
  );
  record(
    `${label}: директива робота`,
    metaOf(html, 'robots') === expected.robots,
    String(metaOf(html, 'robots')),
  );
  const executable = tags(html, 'script').filter(
    (tag) => attr(tag, 'type') !== 'application/ld+json',
  );
  record(`${label}: исполняемого <script> нет`, executable.length === 0, executable.join(' '));
  record(`${label}: директив client:* нет`, !/\bclient:[a-z]+/i.test(html));
  record(`${label}: <iframe> нет`, tags(html, 'iframe').length === 0);
  const hashLinks = hrefs(html).filter((href) => href === '' || href.startsWith('#'));
  record(`${label}: ни одного href="#"`, hashLinks.length === 0, hashLinks.join(' '));
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
  let settingsSnapshot: {
    organization: SiteSetting['organization'];
    adSlots: SiteSetting['adSlots'];
  } | null = null;
  let settingsRestored = false;

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

    /* ------------------------------------------------------------ */
    /* Снимок глобала: он же условие «пустой Organization»          */
    /* ------------------------------------------------------------ */

    const before = await payload.findGlobal({ slug: 'site-settings', depth: 0 });
    settingsSnapshot = { adSlots: before.adSlots, organization: before.organization };

    const writeSettings = async (data: Partial<SiteSetting>): Promise<void> => {
      await payload.updateGlobal({ slug: 'site-settings', data, ...asAdmin });
    };

    // Пустой глобал — состояние, в котором блок Organization не выводится ВОВСЕ
    // (Ч-17). Рекламные ряды на этом шаге тоже пусты: их проверка идёт ниже.
    await writeSettings({ adSlots: [], organization: EMPTY_ORGANIZATION });

    /* ------------------------------------------------------------ */
    /* Фикстуры: узлы и открытки трёх форматов                      */
    /* ------------------------------------------------------------ */

    const uploadImage = async (
      title: string,
      composition: 'grid' | 'rings' | 'stripes',
      size: { readonly width: number; readonly height: number },
    ): Promise<number> => {
      const bytes = createPngFixture({ composition, height: size.height, width: size.width });
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
      return image.id;
    };

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
          data: { status: 'review', visualDuplicate: { confirm: true, decision: 'unique' } },
          ...asAdmin,
        });
      }
    };

    const publish = async (collection: 'cards' | 'collections', id: number): Promise<void> => {
      await toReview(collection, id);
      await payload.update({ collection, id, data: { status: 'published' }, ...asAdmin });
    };

    const group = await payload.create({
      collection: 'collections',
      data: {
        intro: INTRO,
        metaDescription: 'Смоук Э3-09: группирующий узел таксономии.',
        nodeKind: 'group',
        responsibleEditor: adminId,
        robots: 'noindex,follow',
        slug: `${PREFIX}-gruppa`,
        status: 'draft',
        title: 'Смоук Э3-09: группа',
      },
      ...asAdmin,
    });
    created.collections.push(group.id);

    // Окно показа сезонного блока: со вчера по завтра — то есть накрывает
    // СЕГОДНЯШНИЙ день. Границы считаются от текущего момента, потому что смоук
    // проверяет именно переключение по датам из CMS без пересборки.
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const yesterday = new Date(now - day).toISOString();
    const tomorrow = new Date(now + day).toISOString();
    const nextWeek = new Date(now + 7 * day).toISOString();

    const seasonal = await payload.create({
      collection: 'collections',
      data: {
        intro: INTRO,
        metaDescription: 'Смоук Э3-09: сезонная подборка в окне показа.',
        nodeKind: 'occasion',
        parent: group.id,
        related: [group.id],
        responsibleEditor: adminId,
        robots: 'noindex,follow',
        seasonal: { holidayDate: tomorrow, showFrom: yesterday, showUntil: tomorrow },
        slug: `${PREFIX}-sezonnaya`,
        status: 'draft',
        title: 'Смоук Э3-09: сезонная подборка',
      },
      ...asAdmin,
    });
    created.collections.push(seasonal.id);

    // Узел с ОДНОЙ границей: в сезонный блок он не попадает никогда. Пустое поле
    // означает «показывать не по календарю», и догадываться за редактора нельзя.
    const halfOpen = await payload.create({
      collection: 'collections',
      data: {
        intro: INTRO,
        metaDescription: 'Смоук Э3-09: узел с одной границей показа.',
        nodeKind: 'occasion',
        parent: group.id,
        related: [group.id],
        responsibleEditor: adminId,
        robots: 'noindex,follow',
        seasonal: { showFrom: yesterday },
        slug: `${PREFIX}-poluotkrytaya`,
        status: 'draft',
        title: 'Смоук Э3-09: полуоткрытое окно',
      },
      ...asAdmin,
    });
    created.collections.push(halfOpen.id);

    // Узел, окно которого ещё не началось: тоже вне блока.
    const future = await payload.create({
      collection: 'collections',
      data: {
        intro: INTRO,
        metaDescription: 'Смоук Э3-09: узел с будущим окном показа.',
        nodeKind: 'occasion',
        parent: group.id,
        related: [group.id],
        responsibleEditor: adminId,
        robots: 'noindex,follow',
        seasonal: { holidayDate: nextWeek, showFrom: tomorrow, showUntil: nextWeek },
        slug: `${PREFIX}-budushchaya`,
        status: 'draft',
        title: 'Смоук Э3-09: будущее окно',
      },
      ...asAdmin,
    });
    created.collections.push(future.id);

    /**
     * Открытки трёх форматов: вертикальная, горизонтальная, квадратная.
     * Композиции разные — калитка визуальных дублей на них не срабатывает.
     */
    const makeCard = async (args: {
      readonly composition: 'grid' | 'rings' | 'stripes';
      readonly size: { readonly width: number; readonly height: number };
      readonly slug: string;
      readonly title: string;
      readonly collections: readonly number[];
    }): Promise<number> => {
      const imageId = await uploadImage(args.title, args.composition, args.size);
      const card = await payload.create({
        collection: 'cards',
        data: {
          alt: `Синтетический узор фикстуры: ${args.title}`,
          caption: `Подпись смоука: ${args.title}`,
          collections: [...args.collections],
          description: `Видимое описание открытки «${args.title}».`,
          image: imageId,
          metaDescription: `Смоук Э3-09, meta description: ${args.title}`,
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

    const verticalId = await makeCard({
      collections: [seasonal.id, group.id],
      composition: 'grid',
      size: { height: 900, width: 640 },
      slug: `${PREFIX}-vertikalnaya`,
      title: 'Смоук Э3-09: вертикальная открытка тюльпаны',
    });
    const horizontalId = await makeCard({
      collections: [seasonal.id, group.id],
      composition: 'rings',
      size: { height: 500, width: 900 },
      slug: `${PREFIX}-gorizontalnaya`,
      title: 'Смоук Э3-09: горизонтальная открытка тюльпаны',
    });
    const squareId = await makeCard({
      collections: [seasonal.id, group.id],
      composition: 'stripes',
      size: { height: 700, width: 700 },
      slug: `${PREFIX}-kvadratnaya`,
      title: 'Смоук Э3-09: квадратная открытка тюльпаны',
    });

    // Смежная подборка у группы — обязательное поле полноты перед review.
    // Заполняется после создания сезонного узла: до него ссылаться не на что.
    await payload.update({
      collection: 'collections',
      id: group.id,
      data: { related: [seasonal.id] },
      ...asAdmin,
    });

    // Открытки публикуются РАНЬШЕ узлов: CMS не даёт опубликовать пустой узел.
    for (const id of [verticalId, horizontalId, squareId]) {
      await publish('cards', id);
    }
    // Узлы: родитель раньше детей — ссылки на неопубликованный узел не бывает.
    await publish('collections', group.id);
    await publish('collections', seasonal.id);
    // Полуоткрытому и будущему узлу нужна хотя бы одна открытка, иначе CMS
    // откажет в публикации (пустой узел отдавал бы 404).
    const halfOpenCardId = await makeCard({
      collections: [halfOpen.id],
      composition: 'grid',
      size: { height: 640, width: 900 },
      slug: `${PREFIX}-poluotkrytaya-otkrytka`,
      title: 'Смоук Э3-09: открытка полуоткрытого узла',
    });
    await publish('cards', halfOpenCardId);
    await publish('collections', halfOpen.id);
    const futureCardId = await makeCard({
      collections: [future.id],
      composition: 'rings',
      size: { height: 660, width: 900 },
      slug: `${PREFIX}-budushchaya-otkrytka`,
      title: 'Смоук Э3-09: открытка будущего узла',
    });
    await publish('cards', futureCardId);
    await publish('collections', future.id);

    const seasonalPath = `/podborki/${PREFIX}-gruppa/${PREFIX}-sezonnaya`;
    const halfOpenPath = `/podborki/${PREFIX}-gruppa/${PREFIX}-poluotkrytaya`;
    const futurePath = `/podborki/${PREFIX}-gruppa/${PREFIX}-budushchaya`;

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
    /* 1. Главная при ПУСТОМ глобале                                */
    /* ------------------------------------------------------------ */

    const home = await request('/');
    checkPageInvariants('главная (глобал пуст)', home, {
      canonicalPath: '/',
      robots: 'noindex,follow',
    });

    const homeBlocks = jsonLdBlocks(home.body);
    record(
      'главная: разметка WebSite в ответе сервера',
      findByType(homeBlocks, 'WebSite') !== null,
      JSON.stringify(findByType(homeBlocks, 'WebSite')?.['url']),
    );
    record(
      'главная при пустом глобале: строки «Organization» в ответе НЕТ (Ч-17)',
      !home.body.includes('Organization'),
    );
    record(
      'главная: вводный блок и сетка свежих открыток в HTML-ответе',
      home.body.includes('Открытки на этом сайте разложены по поводам') && gridTiles(home.body) > 0,
      `плиток=${String(gridTiles(home.body))}`,
    );
    // Сезонный блок проверяется ИМЕННО как блок: ссылки на те же узлы законно
    // печатает «Разделы сайта», поэтому поиск по всему ответу ничего не доказывает.
    const seasonalBlock = navSection(home.body, 'Сезонные подборки');
    record(
      'главная: сезонный блок показывает узел в окне и НЕ показывает остальные',
      seasonalBlock !== null &&
        seasonalBlock.includes(seasonalPath) &&
        !seasonalBlock.includes(halfOpenPath) &&
        !seasonalBlock.includes(futurePath),
      `блок=${String(seasonalBlock !== null)} в окне=${String(
        seasonalBlock?.includes(seasonalPath) ?? false,
      )} полуоткрытый=${String(seasonalBlock?.includes(halfOpenPath) ?? false)} будущий=${String(
        seasonalBlock?.includes(futurePath) ?? false,
      )}`,
    );
    record(
      'главная: прямая ссылка на праздничный узел (следствие Ч-04-5)',
      hrefs(home.body).includes(seasonalPath),
    );
    record(
      'главная: корень не редиректит и остаётся единственным адресом со слешем',
      home.status === 200 && home.headers.location === undefined,
    );

    /* ------------------------------------------------------------ */
    /* 2. Сезонное окно закрывается ДАТАМИ, без пересборки          */
    /* ------------------------------------------------------------ */

    await payload.update({
      collection: 'collections',
      id: seasonal.id,
      data: { seasonal: { holidayDate: nextWeek, showFrom: tomorrow, showUntil: nextWeek } },
      ...asAdmin,
    });
    const homeAfterShift = await request('/');
    const shiftedBlock = navSection(homeAfterShift.body, 'Сезонные подборки');
    record(
      'сезонный блок переключился по датам из CMS без пересборки (критерий Э3-09)',
      homeAfterShift.status === 200 &&
        (shiftedBlock === null || !shiftedBlock.includes(seasonalPath)),
      `блок=${String(shiftedBlock !== null)} ссылка осталась=${String(
        shiftedBlock?.includes(seasonalPath) ?? false,
      )}`,
    );
    // Возврат окна: дальнейшие проверки идут на исходном состоянии.
    await payload.update({
      collection: 'collections',
      id: seasonal.id,
      data: { seasonal: { holidayDate: tomorrow, showFrom: yesterday, showUntil: tomorrow } },
      ...asAdmin,
    });

    /* ------------------------------------------------------------ */
    /* 3. Главная при ЗАПОЛНЕННОМ глобале                           */
    /* ------------------------------------------------------------ */

    await writeSettings({
      organization: {
        email: 'smoke@otkritka.test',
        logo: '/media/site/smoke-logo.png',
        name: 'Смоук Э3-09: организация',
      },
    });
    const homeWithOrg = await request('/');
    const orgNode = findByType(jsonLdBlocks(homeWithOrg.body), 'Organization');
    record(
      'главная при заполненном глобале: узел Organization появился (Ч-17)',
      orgNode !== null &&
        orgNode['name'] === 'Смоук Э3-09: организация' &&
        orgNode['logo'] === `${ORIGIN}/media/site/smoke-logo.png`,
      JSON.stringify(orgNode),
    );
    record(
      'главная: незаполненные свойства организации в разметку не попали',
      orgNode !== null && !('telephone' in orgNode) && !('legalName' in orgNode),
      JSON.stringify(orgNode === null ? null : Object.keys(orgNode)),
    );
    await writeSettings({ organization: EMPTY_ORGANIZATION });

    /* ------------------------------------------------------------ */
    /* 4. Внутренний поиск                                          */
    /* ------------------------------------------------------------ */

    const searchEmpty = await request('/search');
    checkPageInvariants('поиск без запроса', searchEmpty, {
      canonicalPath: '/search',
      robots: 'noindex,follow',
    });
    record(
      'поиск: серверная форма method="get" в ответе',
      /<form[^>]+method="get"[^>]*>/i.test(searchEmpty.body) &&
        /name="q"/.test(searchEmpty.body),
    );

    const searchFound = await request('/search?q=%D1%82%D1%8E%D0%BB%D1%8C%D0%BF%D0%B0%D0%BD%D1%8B');
    checkPageInvariants('поиск с запросом', searchFound, {
      canonicalPath: '/search',
      robots: 'noindex,follow',
    });
    record(
      'поиск: нашёл временные открытки и вывел ссылки на них',
      hrefs(searchFound.body).includes(`/otkrytki/${PREFIX}-vertikalnaya`),
      `плиток=${String(gridTiles(searchFound.body))}`,
    );

    const searchNothing = await request('/search?q=zzzzzzzz');
    record(
      'поиск: пустая выдача — 200 с честным текстом, а не 404',
      searchNothing.status === 200 && searchNothing.body.includes('ничего не нашлось'),
      `status=${String(searchNothing.status)}`,
    );
    const searchShort = await request('/search?q=%D1%82');
    record(
      'поиск: слишком короткий запрос не выполняется, страница остаётся 200',
      searchShort.status === 200 && !searchShort.body.includes('ничего не нашлось'),
      `status=${String(searchShort.status)}`,
    );
    record(
      'поиск: canonical не зависит от набора параметров',
      canonicalOf(searchFound.body) === canonicalOf(searchEmpty.body) &&
        canonicalOf(searchNothing.body) === `${ORIGIN}/search`,
      `${String(canonicalOf(searchFound.body))} / ${String(canonicalOf(searchNothing.body))}`,
    );

    /* ------------------------------------------------------------ */
    /* 5. Фильтр представления на подборке                          */
    /* ------------------------------------------------------------ */

    const listClean = await request(seasonalPath);
    checkPageInvariants('подборка без фильтра', listClean, {
      canonicalPath: seasonalPath,
      robots: 'noindex,follow',
    });
    const cleanTiles = gridTiles(listClean.body);

    const listFiltered = await request(`${seasonalPath}?format=vertical`);
    checkPageInvariants('подборка с фильтром', listFiltered, {
      canonicalPath: seasonalPath,
      robots: 'noindex,follow',
    });
    const filteredTiles = gridTiles(listFiltered.body);
    record(
      'фильтр меняет представление: плиток стало меньше',
      cleanTiles === 3 && filteredTiles === 1,
      `без фильтра=${String(cleanTiles)} с фильтром=${String(filteredTiles)}`,
    );
    const filteredList = findByType(jsonLdBlocks(listFiltered.body), 'ItemList');
    record(
      'ItemList следует за видимой сеткой отфильтрованного представления',
      filteredList?.['numberOfItems'] === filteredTiles,
      JSON.stringify(filteredList?.['numberOfItems']),
    );
    record(
      'фильтр не создаёт второго адреса: ссылки фильтра ведут на тот же путь',
      hrefs(listFiltered.body).filter((href) => href.includes('format=')).every((href) =>
        href.startsWith(seasonalPath),
      ) && !listFiltered.body.includes('/page/1'),
    );
    record(
      'сброс фильтра ведёт на чистый канонический путь',
      hrefs(listFiltered.body).includes(seasonalPath),
    );

    const listUnknownFilter = await request(`${seasonalPath}?format=panorama&utm_source=vk`);
    record(
      'непонятный параметр ведёт себя как его отсутствие: та же страница, тот же canonical',
      listUnknownFilter.status === 200 &&
        canonicalOf(listUnknownFilter.body) === `${ORIGIN}${seasonalPath}` &&
        gridTiles(listUnknownFilter.body) === cleanTiles,
      `status=${String(listUnknownFilter.status)} плиток=${String(gridTiles(listUnknownFilter.body))}`,
    );

    const catalogWithParams = await request('/otkrytki?page=2&filter=x&utm_source=vk');
    record(
      'каталог с параметрами: 200 и canonical на чистый путь (ТЗ §6.5)',
      catalogWithParams.status === 200 &&
        canonicalOf(catalogWithParams.body) === `${ORIGIN}/otkrytki`,
      `status=${String(catalogWithParams.status)} canonical=${String(
        canonicalOf(catalogWithParams.body),
      )}`,
    );

    /* ------------------------------------------------------------ */
    /* 6. Рекламные места                                           */
    /* ------------------------------------------------------------ */

    await writeSettings({
      adSlots: [
        { enabled: true, height: 250, position: 'under-h1', width: 300 },
        { enabled: true, height: 90, position: 'under-h1', width: 728 },
        // Блок без размеров: не выводится ВОВСЕ, иначе резерв был бы нулевым.
        { enabled: true, position: 'under-h1' },
        // Выключенный блок: тоже не выводится.
        { enabled: false, height: 250, position: 'after-pagination', width: 300 },
        { enabled: true, height: 120, position: 'after-pagination', width: 640 },
      ],
    });

    const listWithAds = await request(seasonalPath);
    checkPageInvariants('подборка с рекламными местами', listWithAds, {
      canonicalPath: seasonalPath,
      robots: 'noindex,follow',
    });
    record(
      'выводятся только заполненные и включённые блоки (2 + 1 из 5)',
      adBoxes(listWithAds.body) === 3,
      `коробок=${String(adBoxes(listWithAds.body))}`,
    );
    const h1Index = listWithAds.body.indexOf('<h1');
    const adIndex = listWithAds.body.indexOf('class="ad-row__slot"');
    const gridIndex = listWithAds.body.indexOf('class="card-grid"');
    record(
      'ряд под H1 стоит между заголовком и сеткой (Ч-11)',
      h1Index > 0 && adIndex > h1Index && gridIndex > adIndex,
      `h1=${String(h1Index)} ad=${String(adIndex)} grid=${String(gridIndex)}`,
    );
    record(
      'место зарезервировано пропорцией и предельной шириной',
      listWithAds.body.includes('--ad-width: 300px') &&
        listWithAds.body.includes('--ad-ratio: 300 / 250'),
    );
    record(
      'в рекламной разметке нет ни внешнего <script>, ни <iframe>',
      tags(listWithAds.body, 'iframe').length === 0 &&
        tags(listWithAds.body, 'script').every(
          (tag) => attr(tag, 'type') === 'application/ld+json',
        ),
    );

    const catalogWithAds = await request('/otkrytki');
    record(
      'каталог открыток печатает оба ряда: под H1 и после пагинации',
      adBoxes(catalogWithAds.body) === 3,
      `коробок=${String(adBoxes(catalogWithAds.body))}`,
    );

    await writeSettings({ adSlots: [] });
    const listWithoutAds = await request(seasonalPath);
    record(
      'без настроенных мест ни одной рекламной коробки не выводится',
      adBoxes(listWithoutAds.body) === 0 &&
        !/<aside[^>]*class="ad-row"/.test(listWithoutAds.body),
      `коробок=${String(adBoxes(listWithoutAds.body))}`,
    );
    // Правила `.ad-row` в критическом CSS при этом остаются: стили компонента
    // Astro собирает на СБОРКЕ, а не по факту вывода. Места они не занимают —
    // занимает его элемент, а элемента нет.

    /* ------------------------------------------------------------ */
    /* 7. Страница 404: ссылка на поиск (ТЗ §5.6)                   */
    /* ------------------------------------------------------------ */

    const notFound = await request(`/otkrytki/${PREFIX}-takoy-otkrytki-net`);
    record(
      '404: настоящий статус и ссылка на поиск в теле страницы',
      notFound.status === 404 && hrefs(notFound.body).includes('/search'),
      `status=${String(notFound.status)}`,
    );

    /* ------------------------------------------------------------ */
    /* 8. Браузер с отключённым JS                                  */
    /* ------------------------------------------------------------ */

    await checkWithJavaScriptDisabled([
      { path: '/', withImages: true },
      { path: '/search?q=%D1%82%D1%8E%D0%BB%D1%8C%D0%BF%D0%B0%D0%BD%D1%8B', withImages: true },
      { path: `${seasonalPath}?format=vertical`, withImages: true },
    ]);

    const holdMs = Number(process.env.SMOKE_HOME_HOLD_MS ?? '0');
    if (Number.isInteger(holdMs) && holdMs > 0) {
      // На время ручной проверки рекламные места возвращаются: замер CLS и доли
      // первого экрана (`measure-web-vitals.mjs`) без них измерял бы страницу без
      // рекламы, то есть не то, что требует ТЗ §5.7. В `finally` глобал всё равно
      // восстанавливается из снимка.
      await writeSettings({
        adSlots: [
          { enabled: true, height: 250, position: 'under-h1', width: 300 },
          { enabled: true, height: 90, position: 'under-h1', width: 728 },
          { enabled: true, height: 120, position: 'after-pagination', width: 640 },
        ],
      });
      console.log(
        `\nСервер держится ${String(holdMs)} мс для ручной проверки:\n` +
          `  curl -i ${ORIGIN}/\n` +
          `  curl -i "${ORIGIN}/search?q=тюльпаны"\n` +
          `  curl -i "${ORIGIN}${seasonalPath}?format=vertical"\n` +
          `  curl -i "${ORIGIN}/otkrytki?page=2&filter=x"\n`,
      );
      await delay(holdMs);
    }
  } finally {
    if (server !== null) {
      server.kill();
    }

    const cleanup = await payloadClient();

    if (settingsSnapshot !== null) {
      try {
        await cleanup.updateGlobal({
          slug: 'site-settings',
          data: {
            adSlots: settingsSnapshot.adSlots ?? [],
            organization: organizationRestore(settingsSnapshot.organization),
          },
          overrideAccess: true,
        });
        // Восстановление ПРОВЕРЯЕТСЯ чтением, а не считается выполненным по факту
        // отсутствия исключения: `updateGlobal` сливает группы, и молчаливо
        // недоочищенное поле выглядело бы как успешная уборка.
        const after = await cleanup.findGlobal({ slug: 'site-settings', depth: 0 });
        const expected = JSON.stringify(organizationRestore(settingsSnapshot.organization));
        const actual = JSON.stringify(organizationRestore(after.organization));
        const adSlotsCount = after.adSlots?.length ?? 0;
        settingsRestored =
          expected === actual && adSlotsCount === (settingsSnapshot.adSlots?.length ?? 0);
        if (!settingsRestored) {
          console.error(
            `ВНИМАНИЕ: настройки сайта восстановлены НЕ полностью.
  ожидалось: ${expected}
` +
              `  в базе:    ${actual}
  рекламных мест: ${String(adSlotsCount)}`,
          );
        }
      } catch (error) {
        console.error(
          'ВНИМАНИЕ: не удалось восстановить настройки сайта. В глобале остались значения ' +
            `смоука, проверьте их вручную: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Порядок значим: карточки раньше изображений (CMS отказывает в удалении
    // изображения, на которое ссылается карточка), узлы — от листа к корню.
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
      publishedNodes: (
        await cleanup.count({
          collection: 'collections',
          where: { and: [LEFTOVER_FILTERS.collections, { status: { equals: 'published' } }] },
        })
      ).totalDocs,
    };

    console.log(
      `\nОстатки смоука после уборки: cards=${String(counts.cards)} ` +
        `collections=${String(counts.collections)} card-images=${String(counts.images)} ` +
        `image-name-claims=${String(counts.claims)} ` +
        `published=${String(counts.publishedCards)}/${String(counts.publishedNodes)}` +
        `\nНастройки сайта восстановлены: ${settingsRestored ? 'да' : 'НЕТ'}`,
    );

    const failed = checks.filter((check) => !check.ok);
    console.log(`\nПроверок: ${String(checks.length)}, провалено: ${String(failed.length)}`);
    for (const check of failed) {
      console.log(`  - ${check.name}${check.detail === '' ? '' : ` (${check.detail})`}`);
    }
    if (
      failed.length > 0 ||
      !settingsRestored ||
      counts.publishedCards > 0 ||
      counts.publishedNodes > 0 ||
      counts.cards > 0 ||
      counts.collections > 0 ||
      counts.claims > 0 ||
      counts.images > 0
    ) {
      // `process.exit`, а не `process.exitCode`: смоук запускается через
      // `payload run`, а тот в конце делает `process.exit(0)` безусловно и
      // выставленный код затирает.
      process.exit(1);
    }
  }
}

/**
 * Уборка следов ПРЕДЫДУЩЕГО прогона — до создания фикстур.
 *
 * Нужна для прогона, оборванного снаружи: до `finally` он не доходит, и в базе
 * остаются опубликованные записи.
 */
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

/**
 * Проверка в настоящем браузере с ОТКЛЮЧЁННЫМ JS.
 *
 * Playwright — devDependency корня, поэтому импорт динамический: недоступность
 * браузера обязана давать честную строку «не проверено», а не зелёный смоук.
 */
interface JsDisabledTarget {
  readonly path: string;
  readonly withImages: boolean;
}

async function checkWithJavaScriptDisabled(
  targets: readonly JsDisabledTarget[],
): Promise<void> {
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
      const images = page.locator('img');
      const count = await images.count();
      const visible = count === 0 ? false : await images.first().isVisible();
      const nav = await page.locator('nav[aria-label="Основная навигация"] a').count();
      const imagesOk = target.withImages ? visible : count === 0;

      record(
        `браузер без JS: ${target.path} — H1, меню и содержание видны`,
        h1.length === 1 && h1[0] !== '' && nav >= 3 && imagesOk,
        `h1=${String(h1.length)} меню=${String(nav)} изображений=${String(count)}`,
      );
    }
    await context.close();
  } finally {
    await browser.close();
  }
}

await main();
process.exit(process.exitCode ?? 0);
