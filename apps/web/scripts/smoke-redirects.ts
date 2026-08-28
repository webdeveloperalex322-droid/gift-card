/**
 * Смоук таблицы редиректов на СОБРАННОМ сервере (задача Э4-02).
 *
 * ## Что здесь проверяется и почему только здесь
 *
 * Юнит-тест (`tests/unit/web-redirects.test.ts`) доказывает свойства РЕШЕНИЯ:
 * схлопывание цепочки, отказ на петле, 410 в конце цепочки, неприкосновенность
 * URL файлов и маршрутов, которые сайт обслуживает сам. Он не доказывает того,
 * что проверяет этот скрипт:
 *
 *   - что решение вообще ПРИМЕНЯЕТСЯ — то есть что запрос доходит до middleware
 *     на собранном сервере, а не получает 404 раньше (Astro не зовёт middleware,
 *     если запрос не совпал ни с одним маршрутом; ради этого в `src/pages/`
 *     существует `[...missing].astro`);
 *   - что переходов РОВНО СТОЛЬКО, сколько заявлено: хопы считаются на живых
 *     ответах, а не выводятся из кода;
 *   - что решение администратора о судьбе URL (группа `withdrawal` в CMS)
 *     доезжает до HTTP: 410 без замены, 301 с заменой;
 *   - что цепочка, оказавшаяся в базе МИМО Payload, отдаёт один переход, а не
 *     два (строка вставляется прямо в базу через `payload.db`, минуя хуки, —
 *     иначе планировщик схлопнул бы её при записи и проверять было бы нечего);
 *   - что редирект не перекрывает живую страницу и не отменяет режим
 *     обслуживания;
 *   - что у всех наших 3xx тело ПУСТОЕ, а у 410 — своё, с навигацией.
 *
 * Проверка идёт против собранного сервера (`dist/server/entry.mjs`), а не против
 * `astro dev`: порядок обработки запроса и правило слеша в dev ведут себя иначе
 * (разбор — в шапке `../src/routing/path-policy.ts`).
 *
 * ## Запуск
 *
 *   pnpm --filter @otkritka/web run build
 *   pnpm --filter @otkritka/web run smoke:redirects
 *
 * ## Про то, что смоук ПУБЛИКУЕТ записи и правит таблицу редиректов
 *
 * Публикует — иначе проверять нечего: перенос и снятие с публикации бывают
 * только у существующей страницы. Всё создаётся с префиксом `smoke-e4-02`, от
 * лица администратора из базы, и снимается в `finally` (плюс обработчики
 * сигналов и сметание следов оборванного прогона на старте). Итог уборки
 * печатается числами, включая число опубликованных записей и оставшихся правил;
 * обязаны быть нули. Граница автоматизации не сдвигается: продуктовый код не
 * публикует ничего.
 *
 * ## Порядок уборки значим
 *
 * Сначала правила, потом карточки, потом изображения: CMS отказывает в удалении
 * изображения, на которое ссылается карточка, а снятие карточки с публикации
 * само создаёт правило — то есть удалять правила надо ПОСЛЕ того, как карточки
 * перестали их порождать. Поэтому уборка правил идёт двумя проходами: свои
 * созданные — по идентификаторам, порождённые CMS — по префиксу.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { inspect } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Payload, Where } from 'payload';

import { createPngFixture } from '../../cms/src/images/png-fixture.js';
import { payloadClient } from '../src/data/index.js';
import type { ObservedResponse } from '../src/server/http-status-matrix.js';
import { serverChildEnv } from './server-child-env.mjs';
import { createStatusMatrixHarness } from './status-matrix-check.js';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(appDir, 'dist', 'server', 'entry.mjs');

const HOST = '127.0.0.1';
const PORT = Number(process.env['SMOKE_REDIRECTS_PORT'] ?? '4397');
/** Второй сервер — режим обслуживания. Свой порт: процессы живут одновременно. */
const MAINTENANCE_PORT = PORT + 1;
const ORIGIN = `http://${HOST}:${String(PORT)}`;

const PREFIX = 'smoke-e4-02';
/** Имя файла собирается пайплайном из заголовка транслитерацией: «смоук» → `smouk`. */
const IMAGE_STEM_PREFIX = 'smouk-e4-02';

/**
 * Путь, с которого смоук заводит правило НАМЕРЕННО «неправильное»: живой
 * маршрут, который сайт обслуживает сам.
 */
const RESERVED_RULE_FROM = '/search';

/**
 * Комментарий правила с зарезервированного маршрута. Содержит {@link PREFIX}
 * дословно, и это не оформление: `from` у такого правила общий (`/search`),
 * поэтому единственный признак «наше» — комментарий.
 */
const RESERVED_RULE_COMMENT = `Смоук ${PREFIX}: правило с зарезервированного маршрута.`;

/** Единственный источник ответа на вопрос «что здесь наше». */
const LEFTOVER_FILTERS = {
  cards: { slug: { like: PREFIX } },
  claims: { stem: { like: IMAGE_STEM_PREFIX } },
  collections: { slug: { like: PREFIX } },
  images: { nameStem: { like: IMAGE_STEM_PREFIX } },
  redirects: { from: { like: PREFIX } },
} as const;

/**
 * «Наше» правило с зарезервированного маршрута — отдельным фильтром и по
 * КОММЕНТАРИЮ.
 *
 * У такого правила нет префикса смоука в `from` (путь общий — `/search`),
 * поэтому фильтр «все правила с /search» удалял бы ЧУЖОЕ: правило, заведённое
 * человеком в общей dev-базе, исчезало бы без предупреждения, а его наличие
 * ещё и делало бы уборку смоука «грязной» (находка `reviewer` от 2026-08-28).
 */
const RESERVED_RULE_FILTER: Where = {
  and: [{ from: { equals: RESERVED_RULE_FROM } }, { comment: { like: PREFIX } }],
};

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

/**
 * Мост к матрице HTTP-статусов (`../src/server/http-status-matrix.ts`).
 *
 * Путь файла указывается ровно тем написанием, каким он записан в матрице: по
 * нему смоук спрашивает, какие строки поручены ИМЕННО ЕМУ, и в конце прогона
 * сверяет список с отработанным.
 */
const matrix = createStatusMatrixHarness('apps/web/scripts/smoke-redirects.ts', record);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface CleanupOutcome {
  readonly clean: boolean;
}

let outcomeValue: CleanupOutcome | null = null;

function readOutcome(): CleanupOutcome | null {
  return outcomeValue;
}

/**
 * Ждёт, пока stdout уйдёт в дескриптор: `process.exit` очередь вывода не
 * дожидается, а на Windows перехваченный stdout — конвейер.
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
 * Один запрос СЫРОЙ целью через `node:http`: `fetch` свернул бы путь парсером
 * URL, и до сервера доехала бы уже нормализованная форма.
 */
function request(target: string, port = PORT): Promise<RawResponse> {
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

/** Один шаг цепочки переходов: что ответили и куда отправили. */
interface Hop {
  readonly target: string;
  readonly status: number;
  readonly location: string | undefined;
  readonly bodyLength: number;
}

/**
 * Проходит цепочку переходов и возвращает ВСЕ шаги.
 *
 * Считает именно ответы сервера, а не догадки о них: требование «одиночный 301,
 * цепочки запрещены» проверяется числом шагов до первого не-3xx.
 */
async function followRedirects(target: string, limit = 6): Promise<readonly Hop[]> {
  const hops: Hop[] = [];
  let current = target;
  for (let step = 0; step < limit; step += 1) {
    const response = await request(current);
    const location = response.headers.location;
    hops.push({
      bodyLength: Buffer.byteLength(response.body),
      location,
      status: response.status,
      target: current,
    });
    if (response.status < 300 || response.status >= 400 || location === undefined) {
      return hops;
    }
    current = location;
  }
  return hops;
}

async function waitForServer(port: number): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await request('/', port);
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error(`Сервер не поднялся на порту ${String(port)}`);
}

/** Сколько переходов до конечного ответа. */
function hopCount(hops: readonly Hop[]): number {
  return hops.filter((hop) => hop.status >= 300 && hop.status < 400).length;
}

function finalHop(hops: readonly Hop[]): Hop {
  const last = hops.at(-1);
  if (last === undefined) {
    throw new Error('Цепочка переходов пуста: запрос не выполнялся.');
  }
  return last;
}

/**
 * Инварианты любого нашего 3xx: статус ровно 301, тело пустое, `Location` —
 * путь от корня.
 *
 * Пустое тело проверяется отдельно, и это не придирка: шаблон 3xx самого Astro
 * кладёт в `<meta http-equiv="refresh">` адрес-ИСТОЧНИК, то есть отправляет
 * клиента назад (разбор — в шапке `../src/routing/path-policy.ts`). Наш ответ
 * собирается вручную ровно поэтому.
 */
function checkRedirectShape(name: string, hop: Hop, expectedLocation: string): void {
  record(`${name}: статус 301`, hop.status === 301, `получено ${String(hop.status)}`);
  record(
    `${name}: Location = ${expectedLocation}`,
    hop.location === expectedLocation,
    `получено ${String(hop.location)}`,
  );
  record(`${name}: тело пустое`, hop.bodyLength === 0, `${String(hop.bodyLength)} байт`);
}

async function main(): Promise<void> {
  const payload: Payload = await payloadClient();
  await sweepLeftovers(payload);

  const created = {
    cardImages: [] as number[],
    cards: [] as number[],
    collections: [] as number[],
    redirects: [] as number[],
  };
  const claimedStems: string[] = [];
  let server: ReturnType<typeof spawn> | null = null;
  let maintenanceServer: ReturnType<typeof spawn> | null = null;

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
    const adminId = adminDoc.id;

    /* ------------------------------------------------------------ */
    /* Фикстуры: узел (черновик) и три опубликованные открытки       */
    /* ------------------------------------------------------------ */
    //
    // Узел остаётся ЧЕРНОВИКОМ намеренно: публикация подборки требует порога
    // Ч-06 (20 опубликованных открыток), а редиректам подборка не нужна вовсе —
    // она здесь только затем, что карточка без подборок не доходит до `review`.

    const node = await payload.create({
      collection: 'collections',
      data: {
        metaDescription: 'Смоук Э4-02: узел-держатель для карточек.',
        nodeKind: 'group',
        responsibleEditor: adminId,
        robots: 'noindex,follow',
        slug: `${PREFIX}-uzel`,
        status: 'draft',
        title: 'Смоук Э4-02: узел',
      },
      ...asAdmin,
    });
    created.collections.push(node.id);

    const uploadImage = async (
      title: string,
      composition: 'grid' | 'rings' | 'stripes',
    ): Promise<number> => {
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
      return image.id;
    };

    const makeCard = async (args: {
      readonly composition: 'grid' | 'rings' | 'stripes';
      readonly slug: string;
      readonly title: string;
    }): Promise<number> => {
      const imageId = await uploadImage(args.title, args.composition);
      const card = await payload.create({
        collection: 'cards',
        data: {
          alt: `Синтетический узор фикстуры: ${args.title}`,
          caption: `Подпись смоука: ${args.title}`,
          collections: [node.id],
          description: `Видимое описание открытки «${args.title}».`,
          image: imageId,
          metaDescription: `Смоук Э4-02, meta description: ${args.title}`,
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

    /** Публикация: `draft` → `review` → `published`, с калиткой визуальных дублей. */
    const publish = async (id: number): Promise<void> => {
      try {
        await payload.update({ collection: 'cards', id, data: { status: 'review' }, ...asAdmin });
      } catch {
        await payload.update({
          collection: 'cards',
          id,
          data: { status: 'review', visualDuplicate: { confirm: true, decision: 'unique' } },
          ...asAdmin,
        });
      }
      await payload.update({ collection: 'cards', id, data: { status: 'published' }, ...asAdmin });
    };

    const targetId = await makeCard({
      composition: 'grid',
      slug: `${PREFIX}-tsel-perenosa`,
      title: 'Смоук Э4-02: цель переноса',
    });
    const movedId = await makeCard({
      composition: 'rings',
      slug: `${PREFIX}-pereezzhayushchaya`,
      title: 'Смоук Э4-02: открытка, меняющая адрес',
    });
    const goneId = await makeCard({
      composition: 'stripes',
      slug: `${PREFIX}-udalyaemaya`,
      title: 'Смоук Э4-02: открытка, удаляемая без замены',
    });
    const replacedId = await makeCard({
      composition: 'grid',
      slug: `${PREFIX}-zamenyaemaya`,
      title: 'Смоук Э4-02: открытка, удаляемая с заменой',
    });
    // Вторая половина строки «Удалено без замены → 404/410»: решение
    // администратора «404» не создаёт правила вовсе, и адрес обязан отвечать
    // обычным 404. Без этой фикстуры половина строки матрицы оставалась бы
    // словами.
    const gone404Id = await makeCard({
      composition: 'rings',
      slug: `${PREFIX}-udalyaemaya-404`,
      title: 'Смоук Э4-06: открытка, удаляемая решением 404',
    });

    for (const id of [targetId, movedId, goneId, replacedId, gone404Id]) {
      await publish(id);
    }

    const targetPath = `/otkrytki/${PREFIX}-tsel-perenosa`;
    const oldMovedPath = `/otkrytki/${PREFIX}-pereezzhayushchaya`;
    const newMovedPath = `/otkrytki/${PREFIX}-pereehavshaya`;
    const gonePath = `/otkrytki/${PREFIX}-udalyaemaya`;
    const gone404Path = `/otkrytki/${PREFIX}-udalyaemaya-404`;
    const replacedPath = `/otkrytki/${PREFIX}-zamenyaemaya`;
    const legacyPath = `/${PREFIX}-staryy-adres-bez-marshruta`;
    // Адреса прежнего сайта С РАСШИРЕНИЕМ. Ради них перехватывающий маршрут и
    // существует, а до правки 2026-08-28 правило с таким `from` не читалось
    // вовсе: разрешатель пропускал любой путь, у которого в последнем сегменте
    // есть точка. Проверяются три разные формы — корневая, «страница» и путь во
    // вложенном каталоге.
    const legacyFilePaths = [
      `/${PREFIX}-index.php`,
      `/${PREFIX}-staraya-stranica.html`,
      `/katalog-${PREFIX}/otkrytka.htm`,
    ];
    const chainStartPath = `/${PREFIX}-tsepochka-a`;
    const chainMiddlePath = `/${PREFIX}-tsepochka-b`;

    /* ------------------------------------------------------------ */
    /* Судьба URL: перенос и два снятия с публикации                 */
    /* ------------------------------------------------------------ */

    // Перенос (Э1-09): смена slug разрешена только вместе с подтверждением, и
    // тем же сохранением CMS создаёт одиночный 301 в той же транзакции.
    await payload.update({
      collection: 'cards',
      id: movedId,
      data: {
        slug: `${PREFIX}-pereehavshaya`,
        urlChange: { confirm: true, reason: 'Смоук Э4-02: проверка одиночного 301 на переносе.' },
      },
      ...asAdmin,
    });

    // Удалено без замены → 410 (решение администратора в группе `withdrawal`).
    await payload.update({
      collection: 'cards',
      id: goneId,
      data: { status: 'draft', withdrawal: { mode: '410' } },
      ...asAdmin,
    });

    // Удалено без замены, решение «404»: записи в таблице редиректов не
    // появляется вовсе — адрес просто перестаёт существовать.
    await payload.update({
      collection: 'cards',
      id: gone404Id,
      data: { status: 'draft', withdrawal: { mode: '404' } },
      ...asAdmin,
    });

    // Удалено с заменой → 301 на релевантный адрес, а не на главную (п. 23).
    await payload.update({
      collection: 'cards',
      id: replacedId,
      data: { status: 'draft', withdrawal: { mode: '301', redirectTo: targetPath } },
      ...asAdmin,
    });

    /* ------------------------------------------------------------ */
    /* Правила, созданные руками                                     */
    /* ------------------------------------------------------------ */

    // Перенос со старого адреса, у которого НЕТ маршрута Astro: ровно этот
    // случай проверяет, что запрос доходит до middleware (`[...missing].astro`).
    const legacyRule = await payload.create({
      collection: 'redirects',
      data: {
        code: '301',
        comment: 'Смоук Э4-02: перенос со старого адреса без маршрута.',
        from: legacyPath,
        to: targetPath,
      },
      ...asAdmin,
    });
    created.redirects.push(legacyRule.id);

    // Переносы со старых адресов С РАСШИРЕНИЕМ. Создаются обычным путём — через
    // Payload, как их создал бы администратор: CMS такой `from` принимает, и
    // именно поэтому молчаливый пропуск на стороне сайта был дорог (правило
    // видно в списке, а сайт отвечает 404).
    for (const from of legacyFilePaths) {
      const rule = await payload.create({
        collection: 'redirects',
        data: {
          code: '301',
          comment: `Смоук ${PREFIX}: перенос со старого адреса с расширением.`,
          from,
          to: targetPath,
        },
        ...asAdmin,
      });
      created.redirects.push(rule.id);
    }

    // ЦЕПОЧКА В ДАННЫХ. Через Payload её не создать: планировщик схлопывает
    // цепочку при записи (Э1-06) — в этом и смысл. Поэтому второе звено
    // вставляется прямо в базу через `payload.db`, минуя хуки коллекции: так
    // выглядит таблица, в которую попали мимо Payload (дамп, миграция, ручной
    // SQL). Middleware обязан отдать ОДИН переход и написать об этом в лог.
    const chainTail = await payload.create({
      collection: 'redirects',
      data: {
        code: '301',
        comment: 'Смоук Э4-02: хвост цепочки.',
        from: chainMiddlePath,
        to: targetPath,
      },
      ...asAdmin,
    });
    created.redirects.push(chainTail.id);

    const now = new Date().toISOString();
    const chainHead = (await payload.db.create({
      collection: 'redirects',
      data: {
        code: '301',
        comment: 'Смоук Э4-02: голова цепочки, вставлена мимо хуков.',
        createdAt: now,
        from: chainStartPath,
        to: chainMiddlePath,
        updatedAt: now,
      },
    })) as { id: number };
    created.redirects.push(chainHead.id);

    // Правило с пути, который сайт обслуживает сам. Создаётся тем же способом,
    // каким его мог бы создать администратор; если CMS откажет — тем лучше, и
    // это будет видно строкой ниже.
    let searchRuleCreated = false;
    try {
      const searchRule = await payload.create({
        collection: 'redirects',
        data: {
          code: '301',
          comment: RESERVED_RULE_COMMENT,
          from: RESERVED_RULE_FROM,
          to: targetPath,
        },
        ...asAdmin,
      });
      created.redirects.push(searchRule.id);
      searchRuleCreated = true;
    } catch (error) {
      console.log(
        `Правило с «/search» CMS создать не дала: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    /* ------------------------------------------------------------ */
    /* Собранный сервер                                              */
    /* ------------------------------------------------------------ */

    server = spawn(process.execPath, [serverEntry], {
      cwd: appDir,
      env: serverChildEnv(appDir, { HOST, PORT: String(PORT), SITE_URL: ORIGIN }),
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitForServer(PORT);
    console.log(`\nПроверки против ${ORIGIN}\n`);

    /* ------------------------------------------------------------ */
    /* 1. Живая страница редиректом не перекрывается                 */
    /* ------------------------------------------------------------ */

    const target = await request(targetPath);
    record(
      'цель переноса отвечает 200',
      target.status === 200,
      `${targetPath} → ${String(target.status)}`,
    );
    record(
      'у живой страницы нет Location',
      target.headers.location === undefined,
      String(target.headers.location),
    );
    matrix.check('published-200', targetPath, {
      hops: 0,
      location: target.headers.location,
      retryAfter: target.headers['retry-after'],
      status: target.status,
    });

    /* ------------------------------------------------------------ */
    /* 2. Перенос: ровно один 301 на конечный адрес                  */
    /* ------------------------------------------------------------ */

    const movedHops = await followRedirects(oldMovedPath);
    record(
      'перенос: ровно ОДИН переход',
      hopCount(movedHops) === 1,
      movedHops.map((hop) => `${hop.target} → ${String(hop.status)}`).join(' | '),
    );
    checkRedirectShape('перенос', movedHops[0] ?? finalHop(movedHops), newMovedPath);
    record(
      'перенос ведёт на 200, а не на 404',
      finalHop(movedHops).status === 200,
      `итог ${String(finalHop(movedHops).status)}`,
    );
    const movedFirst = movedHops[0] ?? finalHop(movedHops);
    matrix.check('moved-301', oldMovedPath, {
      hops: hopCount(movedHops),
      location: movedFirst.location,
      status: movedFirst.status,
    });

    /* ------------------------------------------------------------ */
    /* 3. Цепочка в данных схлопывается на чтении                    */
    /* ------------------------------------------------------------ */

    const chainHops = await followRedirects(chainStartPath);
    record(
      'цепочка A→B при B→C: ровно ОДИН переход',
      hopCount(chainHops) === 1,
      chainHops.map((hop) => `${hop.target} → ${String(hop.status)}`).join(' | '),
    );
    checkRedirectShape('цепочка', chainHops[0] ?? finalHop(chainHops), targetPath);
    record(
      'цепочка ведёт сразу на конечный адрес, а не на промежуточный',
      chainHops[0]?.location === targetPath,
      `Location=${String(chainHops[0]?.location)}`,
    );

    /* ------------------------------------------------------------ */
    /* 4. Снятие с публикации: 410 и 301                             */
    /* ------------------------------------------------------------ */

    const goneResponse = await request(gonePath);
    record(
      'удалено без замены — 410',
      goneResponse.status === 410,
      `${gonePath} → ${String(goneResponse.status)}`,
    );
    record(
      '410 не отдаёт Location',
      goneResponse.headers.location === undefined,
      String(goneResponse.headers.location),
    );
    record(
      '410 содержит заголовок и навигацию',
      /<h1[^>]*>/i.test(goneResponse.body) &&
        goneResponse.body.includes('href="/otkrytki"') &&
        goneResponse.body.includes('href="/podborki"'),
      `${String(Buffer.byteLength(goneResponse.body))} байт`,
    );
    record(
      '410 закрыт директивой noindex',
      /<meta name="robots" content="noindex,follow">/.test(goneResponse.body),
    );
    matrix.check('deleted-gone', gonePath, {
      body: goneResponse.body,
      hops: 0,
      location: goneResponse.headers.location,
      retryAfter: goneResponse.headers['retry-after'],
      status: goneResponse.status,
    });

    const gone404Response = await request(gone404Path);
    record(
      'удалено без замены решением «404» — 404 без Location и без правила',
      gone404Response.status === 404 && gone404Response.headers.location === undefined,
      `${gone404Path} → ${String(gone404Response.status)}`,
    );
    matrix.check('deleted-gone', `${gone404Path} (решение «404»)`, {
      body: gone404Response.body,
      hops: 0,
      location: gone404Response.headers.location,
      retryAfter: gone404Response.headers['retry-after'],
      status: gone404Response.status,
    });

    const replacedHops = await followRedirects(replacedPath);
    record(
      'удалено с заменой — ровно один 301 на релевантный адрес',
      hopCount(replacedHops) === 1 && replacedHops[0]?.location === targetPath,
      replacedHops.map((hop) => `${hop.target} → ${String(hop.status)}`).join(' | '),
    );
    record(
      'замена не является главной страницей',
      replacedHops[0]?.location !== '/',
      String(replacedHops[0]?.location),
    );
    const replacedFirst = replacedHops[0] ?? finalHop(replacedHops);
    const replacedObserved: ObservedResponse = {
      hops: hopCount(replacedHops),
      location: replacedFirst.location,
      status: replacedFirst.status,
    };
    matrix.check('replaced-301', replacedPath, replacedObserved);
    // Тот же ответ проверяется второй строкой матрицы — запретом. Строки разные:
    // «301 на релевантный URL» требует перехода, а «массовый редирект на главную
    // запрещён» запрещает конкретную цель, и удовлетворить первую, нарушив
    // вторую, можно одним ответом.
    matrix.check('no-blanket-home-redirect', replacedPath, replacedObserved);

    /* ------------------------------------------------------------ */
    /* 5. Старый адрес без маршрута Astro                            */
    /* ------------------------------------------------------------ */

    const legacyHops = await followRedirects(legacyPath);
    record(
      'перенос со старого адреса БЕЗ маршрута применяется',
      hopCount(legacyHops) === 1 && legacyHops[0]?.location === targetPath,
      legacyHops.map((hop) => `${hop.target} → ${String(hop.status)}`).join(' | '),
    );

    // Адрес прежнего сайта с расширением: 301, а не 404. Живая половина
    // негативного юнит-теста (`tests/unit/web-redirects.test.ts`): тот проверяет
    // РЕШЕНИЕ, а этот — что запрос вообще доходит до таблицы на собранном
    // сервере, где `/….html` легко принять за адрес файла.
    for (const from of legacyFilePaths) {
      const hops = await followRedirects(from);
      record(
        `перенос со старого адреса С РАСШИРЕНИЕМ применяется: ${from}`,
        hopCount(hops) === 1 &&
          hops[0]?.status === 301 &&
          hops[0].location === targetPath &&
          finalHop(hops).status === 200,
        hops.map((hop) => `${hop.target} → ${String(hop.status)}`).join(' | '),
      );
    }

    /* ------------------------------------------------------------ */
    /* 6. Несуществующие адреса                                      */
    /* ------------------------------------------------------------ */

    const missingTop = await request(`/${PREFIX}-takogo-adresa-net`);
    record(
      'несуществующий адрес верхнего уровня — 404',
      missingTop.status === 404,
      String(missingTop.status),
    );
    record(
      'у 404 нет Location',
      missingTop.headers.location === undefined,
      String(missingTop.headers.location),
    );
    record(
      '404 остался настоящей страницей 404 с навигацией',
      missingTop.body.includes('Страница не найдена') && missingTop.body.includes('href="/"'),
      `${String(Buffer.byteLength(missingTop.body))} байт`,
    );
    matrix.check('real-404-with-navigation', `/${PREFIX}-takogo-adresa-net`, {
      body: missingTop.body,
      hops: 0,
      location: missingTop.headers.location,
      retryAfter: missingTop.headers['retry-after'],
      status: missingTop.status,
    });

    const missingCard = await request(`/otkrytki/${PREFIX}-takoy-otkrytki-net`);
    record(
      'несуществующая открытка — 404',
      missingCard.status === 404,
      String(missingCard.status),
    );

    /* ------------------------------------------------------------ */
    /* 7. Параметры не меняют судьбу адреса                          */
    /* ------------------------------------------------------------ */

    // «Ни при каких параметрах» проверяется перебором, а не одним `utm_source`:
    // судьба адреса определяется записью, а не хвостом ссылки. В перебор входят
    // и параметр фильтра представления (`format`, Э3-10), и то, чем обычно
    // пробуют открыть скрытое (`draft`, `preview`), и хвост пагинации.
    const goneQueries = [
      '',
      '?utm_source=mail',
      '?format=vertical',
      '?format=vertical&utm_source=mail&utm_medium=email',
      '?page=2',
      '?draft=true&preview=1',
      '?q=otkrytka',
      '?',
    ];
    for (const query of goneQueries) {
      const response = await request(`${gonePath}${query}`);
      record(
        `удалённая открытка не отдаёт 200 ни при каких параметрах: «${query === '' ? 'без параметров' : query}»`,
        response.status === 410 && response.headers.location === undefined,
        `status=${String(response.status)} location=${String(response.headers.location)}`,
      );
    }

    // Неканоническая форма того же адреса: переход по правилу слеша допустим, а
    // вот 200 в цепочке — нет. Проверяется вся цепочка, а не только её конец.
    const goneSlashHops = await followRedirects(`${gonePath}/?utm_source=mail`);
    record(
      'удалённая открытка не отдаёт 200 и в неканонической форме адреса',
      finalHop(goneSlashHops).status === 410 &&
        !goneSlashHops.some((hop) => hop.status === 200),
      goneSlashHops.map((hop) => `${hop.target} → ${String(hop.status)}`).join(' | '),
    );

    const movedWithQuery = await request(`${oldMovedPath}?utm_source=mail`);
    record(
      'строка запроса переносится на новый адрес',
      movedWithQuery.status === 301 &&
        movedWithQuery.headers.location === `${newMovedPath}?utm_source=mail`,
      String(movedWithQuery.headers.location),
    );

    /* ------------------------------------------------------------ */
    /* 8. Неканоническая форма адреса                                */
    /* ------------------------------------------------------------ */
    //
    // ЗАМЕР, а не требование: запрос к перенесённому адресу С завершающим слешем
    // получает ДВА перехода — сначала нормализацию формы (Ч-21), потом сам
    // перенос. Слить их в один нельзя: первый 301 отдаёт входной сервер, у
    // которого доступа к таблице нет. Ни один канонический URL сайта двух
    // переходов не даёт; значение зафиксировано здесь, чтобы его изменение было
    // видно, а не обнаружилось в логах поисковика.

    const slashHops = await followRedirects(`${oldMovedPath}/`);
    record(
      'неканоническая форма перенесённого адреса: 2 перехода (нормализация + перенос)',
      hopCount(slashHops) === 2 && finalHop(slashHops).status === 200,
      slashHops.map((hop) => `${hop.target} → ${String(hop.status)}`).join(' | '),
    );

    /* ------------------------------------------------------------ */
    /* 9. Маршрут, который сайт обслуживает сам                      */
    /* ------------------------------------------------------------ */

    const search = await request('/search');
    record(
      `правило с «/search»${searchRuleCreated ? ' создано и' : ' не создано;'} страница отвечает 200`,
      search.status === 200,
      `→ ${String(search.status)}`,
    );

    /* ------------------------------------------------------------ */
    /* 10. Режим обслуживания сильнее редиректа                      */
    /* ------------------------------------------------------------ */

    maintenanceServer = spawn(process.execPath, [serverEntry], {
      cwd: appDir,
      env: serverChildEnv(appDir, {
        HOST,
        MAINTENANCE_MODE: 'on',
        PORT: String(MAINTENANCE_PORT),
        SITE_URL: ORIGIN,
      }),
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitForServer(MAINTENANCE_PORT);

    const duringMaintenance = await request(oldMovedPath, MAINTENANCE_PORT);
    record(
      'в режиме обслуживания перенесённый адрес отдаёт 503, а не 301',
      duringMaintenance.status === 503 && duringMaintenance.headers.location === undefined,
      `${String(duringMaintenance.status)}, Location=${String(duringMaintenance.headers.location)}`,
    );
    record(
      'у 503 есть Retry-After',
      duringMaintenance.headers['retry-after'] !== undefined,
      String(duringMaintenance.headers['retry-after']),
    );
    matrix.check('service-unavailable-503', `${oldMovedPath} в режиме обслуживания`, {
      body: duringMaintenance.body,
      hops: 0,
      location: duringMaintenance.headers.location,
      retryAfter: duringMaintenance.headers['retry-after'],
      status: duringMaintenance.status,
    });

    /* ------------------------------------------------------------ */
    /* 11. Матрица статусов: ни одна строка не осталась без ответа   */
    /* ------------------------------------------------------------ */
    //
    // Список берётся у самой матрицы (`liveRowsFor`), а не переписывается здесь:
    // строка, которой матрица поручила живую проверку именно этому файлу и
    // которую забыли отработать, обязана валить прогон, а не оставаться
    // обещанием в комментарии.

    matrix.assertAllRowsExercised();
  } finally {
    await cleanupOnce();
  }

  /**
   * Тело уборки. Кода выхода не ставит: его считает верхний уровень файла, где
   * видно и исключение, и результат уборки.
   */
  async function runCleanup(): Promise<CleanupOutcome> {
    for (const child of [server, maintenanceServer]) {
      if (child !== null) {
        child.kill();
      }
    }

    const cleanup = await payloadClient();

    // ПОРЯДОК: сначала карточки (они перестают порождать правила), потом
    // правила, потом изображения — CMS отказывает в удалении изображения, на
    // которое ссылается карточка.
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
    for (const id of created.redirects) {
      await cleanup.delete({ collection: 'redirects', id }).catch(() => undefined);
    }
    // Правила, порождённые самой CMS при переносе и снятии с публикации: их
    // идентификаторов у смоука нет, зато `from` начинается с префикса.
    await cleanup
      .delete({ collection: 'redirects', where: LEFTOVER_FILTERS.redirects })
      .catch(() => undefined);
    // И правило с зарезервированного маршрута — по своему комментарию, а не по
    // одному только `from`: с тем же `/search` в базе может лежать чужое.
    await cleanup
      .delete({ collection: 'redirects', where: RESERVED_RULE_FILTER })
      .catch(() => undefined);
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
      redirects: (
        await cleanup.count({ collection: 'redirects', where: LEFTOVER_FILTERS.redirects })
      ).totalDocs,
      // Правило с «/search» идентификатора могло не получить (CMS вправе
      // отказать в его создании), поэтому считается отдельно — но ТОЛЬКО СВОЁ,
      // по комментарию: чужое правило с тем же `from` остатком смоука не
      // является и на его код выхода влиять не должно.
      searchRules: (
        await cleanup.count({ collection: 'redirects', where: RESERVED_RULE_FILTER })
      ).totalDocs,
    };

    console.log(
      `\nОстатки смоука: cards=${String(counts.cards)} collections=${String(counts.collections)} ` +
        `card-images=${String(counts.images)} image-name-claims=${String(counts.claims)} ` +
        `redirects=${String(counts.redirects)} правил с /search=${String(counts.searchRules)} ` +
        `опубликованных карточек=${String(counts.publishedCards)}`,
    );

    const clean = Object.values(counts).every((value) => value === 0);
    outcomeValue = { clean };
    return { clean };
  }
}

/**
 * Сметание следов ОБОРВАННОГО прошлого прогона.
 *
 * Нужно потому, что уборка в `finally` не выполняется при обрыве процесса, а
 * оставшиеся правила меняют ответы сайта — то есть следующий прогон (и чужая
 * приёмка) проверяли бы не то состояние, которое думают.
 */
async function sweepLeftovers(payload: Payload): Promise<void> {
  const removed = {
    cards: (await payload.delete({ collection: 'cards', where: LEFTOVER_FILTERS.cards })).docs
      .length,
    claims: (
      await payload.delete({ collection: 'image-name-claims', where: LEFTOVER_FILTERS.claims })
    ).docs.length,
    collections: (
      await payload.delete({ collection: 'collections', where: LEFTOVER_FILTERS.collections })
    ).docs.length,
    images: (await payload.delete({ collection: 'card-images', where: LEFTOVER_FILTERS.images }))
      .docs.length,
    redirects: (
      await payload.delete({ collection: 'redirects', where: LEFTOVER_FILTERS.redirects })
    ).docs.length,
    // Только СВОЁ правило с «/search» — по комментарию. Фильтр по одному лишь
    // `from` сметал бы правило, заведённое человеком в общей dev-базе.
    searchRules: (
      await payload.delete({ collection: 'redirects', where: RESERVED_RULE_FILTER })
    ).docs.length,
  };

  const total = Object.values(removed).reduce((sum, value) => sum + value, 0);
  if (total > 0) {
    console.log(
      `Уборка следов прошлого прогона: cards=${String(removed.cards)} ` +
        `collections=${String(removed.collections)} card-images=${String(removed.images)} ` +
        `image-name-claims=${String(removed.claims)} redirects=${String(removed.redirects)} ` +
        `правил с /search=${String(removed.searchRules)}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Верхний уровень: итог и код выхода                                 */
/* ------------------------------------------------------------------ */
//
// Код выхода считается ЗДЕСЬ, а не в `finally`: `process.exit(1)` из `finally`
// при исключении в полёте гасит саму ошибку. И именно `process.exit`, а не
// `process.exitCode`: смоук запускается через `payload run`, а тот в конце
// безусловно делает `process.exit(0)` и затирает выставленный код.

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
    '\nУборка не выполнялась вовсе: в базе могли остаться ОПУБЛИКОВАННЫЕ фикстуры и ПРАВИЛА ' +
      'смоука. Проверьте записи с префиксом «smoke-e4-02».',
  );
}

const ok = crashed === null && outcome !== null && outcome.clean && failed.length === 0;
await flushStdout();
process.exit(ok ? 0 : 1);
