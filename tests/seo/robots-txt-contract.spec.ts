/**
 * Требование (`CLAUDE.md`, «Sitemap и robots», решение Ч-22 от 2026-08-21;
 * задача Э4-03): `robots.txt` отдаётся текстом, закрывает ровно служебное,
 * пишет `Disallow` БЕЗ завершающего слеша, НЕ называет адрес админки, не
 * блокирует CSS/JS/изображения и указывает абсолютную ссылку на sitemap-индекс.
 *
 * ## Почему каждое из этих утверждений стоит отдельным тестом
 *
 * Это разные поломки с разной ценой, и падение обязано называть свою:
 *
 *   - форма `Disallow: /search/` со слешем НЕ покрывает голый `/search`, а
 *     именно его краулер запрашивает первым. Файл при этом выглядит правильным;
 *   - опубликованный путь админки — это подсказка адреса админки всем, кто
 *     читает `robots.txt`. Ч-22 запрещает публикацию прямо, и запрет держится
 *     только проверкой: сам по себе путь в реестре зарезервированных маршрутов
 *     есть, и попасть в файл ему ничего не мешает, кроме отбора по `source`;
 *   - `Disallow`, накрывший `/media` или `/_astro`, прячет от поисковой системы
 *     сами открытки и оформление страницы. Это самая дорогая из ошибок здесь и
 *     самая незаметная: страницы остаются в индексе, а выглядят пустыми;
 *   - ссылка на карту сайта, ведущая на 404 или на другой хост, обесценивает всю
 *     работу над картой.
 *
 * ## Откуда берётся путь админки
 *
 * Из `PAYLOAD_ADMIN_PATH`, как в `admin-path-not-served.spec.ts`, и по той же
 * причине: при нестандартном значении зашитая строка `/admin` проверяла бы
 * чужой адрес и молчала бы о настоящем. Пустое значение — ошибка конфигурации
 * окружения, а не повод пропустить проверку.
 *
 * ## Чего здесь НЕТ
 *
 * Проверки, что `/robots.txt` не отвечает переходом и что `/robots.txt/` — 404:
 * это форма файлового URL, и она проверяется в `file-urls-not-normalized.spec.ts`.
 */

import { expect, test, type APIRequestContext } from '@playwright/test';

import { fetchRaw } from './support/http.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

const ROBOTS_PATH = '/robots.txt';

/** Ожидаемый адрес карты сайта: тот же хост, на котором гоняется приёмка. */
const EXPECTED_SITEMAP_URL = `${target.origin}/sitemap.xml`;

/**
 * Ровно те три пути, что закрыты решением Ч-22. Список ЗАКРЫТЫЙ: и лишняя, и
 * пропавшая директива — нарушение.
 *
 * Порядок здесь не важен (в `robots.txt` он ничего не значит), поэтому сравнение
 * идёт по отсортированным наборам: иначе приёмка держала бы владельца слоя за
 * порядок наполнения реестра, к которому требование не относится.
 */
const EXPECTED_DISALLOW = ['/account', '/generator/preview', '/search'] as const;

const adminPath = (process.env['PAYLOAD_ADMIN_PATH'] ?? '').trim();

if (adminPath === '') {
  throw new Error(
    'SEO-приёмка: PAYLOAD_ADMIN_PATH не задан. Значения по умолчанию здесь нет намеренно: ' +
      'проверка «robots.txt не называет адрес админки» (Ч-22) обязана идти по тому же пути, ' +
      'который задан окружению, иначе она ищет чужую строку. Задайте PAYLOAD_ADMIN_PATH в .env.',
  );
}

interface RobotsDirectiveLine {
  /** Имя директивы в нижнем регистре: `user-agent`, `disallow`, `allow`, `sitemap`. */
  readonly name: string;
  readonly value: string;
  /** Строка целиком — для сообщения об ошибке. */
  readonly raw: string;
}

/**
 * Разбор `robots.txt` по строкам.
 *
 * Разбор намеренно буквальный: комментарии отбрасываются, строка режется по
 * ПЕРВОМУ двоеточию (в значении `Sitemap:` двоеточие есть в схеме), имя
 * приводится к нижнему регистру — так же поступают краулеры.
 */
function parseRobots(body: string): readonly RobotsDirectiveLine[] {
  return body
    .split(/\r?\n/u)
    .map((line) => line.replace(/#.*$/u, '').trim())
    .filter((line) => line !== '')
    .map((line) => {
      const separator = line.indexOf(':');
      return separator === -1
        ? { name: line.toLowerCase(), raw: line, value: '' }
        : {
            name: line.slice(0, separator).trim().toLowerCase(),
            raw: line,
            value: line.slice(separator + 1).trim(),
          };
    });
}

function valuesOf(lines: readonly RobotsDirectiveLine[], name: string): string[] {
  return lines.filter((line) => line.name === name).map((line) => line.value);
}

async function readRobots(request: APIRequestContext): Promise<{
  readonly body: string;
  readonly lines: readonly RobotsDirectiveLine[];
}> {
  const response = await fetchRaw(request, urlFor(target, ROBOTS_PATH));
  expect(
    response.status,
    `${ROBOTS_PATH} обязан отвечать 200: файл читает каждый краулер перед обходом.`,
  ).toBe(200);
  return { body: response.body, lines: parseRobots(response.body) };
}

test('robots.txt отдаётся с кодом 200 и типом text/plain', async ({ request }) => {
  const response = await fetchRaw(request, urlFor(target, ROBOTS_PATH));

  expect(response.status, `${ROBOTS_PATH} обязан отвечать 200.`).toBe(200);
  expect(
    response.location,
    'У robots.txt не должно быть Location: это файл, а не маршрут страницы.',
  ).toBeNull();
  expect(
    (response.contentType ?? '').toLowerCase(),
    'robots.txt обязан отдаваться как text/plain. HTML или XML на этом адресе краулер читает ' +
      'как повреждённый файл и в части случаев считает, что правил нет вовсе.',
  ).toContain('text/plain');
  expect(response.body.trim().length, 'robots.txt не может быть пустым.').toBeGreaterThan(0);
});

test('robots.txt содержит ровно одну группу User-agent: *', async ({ request }) => {
  const { lines } = await readRobots(request);
  const agents = valuesOf(lines, 'user-agent');

  expect(
    agents,
    'Групп ровно одна: разных правил для Яндекса и Google у сайта нет. Вторая группа ' +
      'появляется вместе с правилом, которое к ней относится, — и тогда это решение человека, ' +
      'видимое в дифе, а не побочный эффект правки генератора.',
  ).toEqual(['*']);

  const firstAgent = lines.findIndex((line) => line.name === 'user-agent');
  const firstDisallow = lines.findIndex((line) => line.name === 'disallow');
  expect(
    firstDisallow === -1 || firstAgent < firstDisallow,
    'Директивы Disallow обязаны идти ПОСЛЕ строки User-agent: правило вне группы краулер ' +
      'игнорирует, и файл молча перестаёт что-либо закрывать.',
  ).toBe(true);
});

test('Disallow закрывает ровно три служебных пути и пишется без завершающего слеша', async ({
  request,
}) => {
  const { lines } = await readRobots(request);
  const disallow = valuesOf(lines, 'disallow');

  expect(
    [...disallow].sort(),
    'Состав закрытых путей — ровно решение Ч-22. Лишняя директива закрывает от поиска то, что ' +
      'закрывать не решали; пропавшая — открывает поиск, личный кабинет или превью генерации.',
  ).toEqual([...EXPECTED_DISALLOW]);

  expect(
    disallow.length,
    'Повтор директивы означает, что состав собирается из двух источников.',
  ).toBe(new Set(disallow).size);

  const withTrailingSlash = disallow.filter((value) => value !== '/' && value.endsWith('/'));
  expect(
    withTrailingSlash,
    'Ч-22: форма префиксная и пишется БЕЗ завершающего слеша. «Disallow: /search/» не ' +
      'покрывает голый «/search», а именно его краулер запрашивает первым, — то есть внутренний ' +
      'поиск оказывается открыт при внешне правильном файле.',
  ).toEqual([]);

  expect(
    disallow.filter((value) => value === '/'),
    'Disallow: / закрывает сайт целиком. Ни одно решение проекта этого не предусматривает.',
  ).toEqual([]);
});

test('robots.txt не называет адрес админки (Ч-22)', async ({ request }) => {
  const { body, lines } = await readRobots(request);

  /**
   * Совпадение ищется как ПУТЬ, а не как подстрока: при `PAYLOAD_ADMIN_PATH=/a`
   * подстрока нашлась бы в `/account`, и spec падал бы на верном файле. Граница
   * — «дальше не буква, не цифра и не дефис», то есть `/admin`, `/admin/…` и
   * `/admin*` считаются упоминанием, а `/administrator-guide` — нет.
   */
  const mention = new RegExp(
    `${adminPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\w-])`,
    'u',
  );

  const mentioning = lines.filter((line) => mention.test(line.raw)).map((line) => line.raw);
  expect(
    mentioning,
    `Путь админки «${adminPath}» в robots.txt не публикуется (решение Ч-22): публикация только ` +
      'подсказывает адрес админки всем, кто читает файл. Закрывается админка авторизацией и ' +
      'заголовком X-Robots-Tag, а Astro её маршруты не обслуживает вовсе. В реестре ' +
      'зарезервированных маршрутов путь при этом остаётся — он закрыт, но не назван вслух.',
  ).toEqual([]);

  // Комментарии из строк уже вырезаны, поэтому упоминание в комментарии
  // проверяется по сырому телу отдельно: «# админка живёт по /admin» выдаёт
  // адрес ровно так же, как директива.
  expect(
    mention.test(body),
    `Путь админки «${adminPath}» найден в теле robots.txt — возможно, в комментарии. ` +
      'Комментарий читается теми же людьми и теми же роботами, что и директива.',
  ).toBe(false);
});

test('robots.txt указывает ровно одну абсолютную ссылку на sitemap-индекс', async ({
  request,
}) => {
  const { lines } = await readRobots(request);
  const sitemaps = valuesOf(lines, 'sitemap');

  expect(
    sitemaps,
    'Ссылка на карту сайта обязана быть ровно одна и абсолютная, собранная из SITE_URL ' +
      `единственным хелпером. Ожидается «${EXPECTED_SITEMAP_URL}» — тот же хост, на котором ` +
      'гоняется приёмка (BASE_URL и SITE_URL на окружении приёмки совпадают по требованию ' +
      '«SEO-тесты» в CLAUDE.md). Другой хост здесь означает, что абсолютные адреса собираются ' +
      'не из SITE_URL, и обнаружится это уже после индексации.',
  ).toEqual([EXPECTED_SITEMAP_URL]);
});

test('адрес карты сайта из robots.txt отвечает 200 и отдаёт XML', async ({ request }) => {
  const { lines } = await readRobots(request);
  const sitemapUrl = valuesOf(lines, 'sitemap')[0] ?? '';

  expect(sitemapUrl, 'В robots.txt нет строки Sitemap — проверять нечего.').not.toBe('');

  const response = await fetchRaw(request, sitemapUrl);

  expect(
    response.status,
    `Адрес «${sitemapUrl}», названный в robots.txt, обязан отвечать 200. Битая ссылка на карту ` +
      'сайта — это обход, начинающийся с ошибки: краулер узнаёт о карте и не получает её.',
  ).toBe(200);
  expect(
    response.location,
    'Ссылка из robots.txt обязана вести на сам файл, а не на переход к нему.',
  ).toBeNull();
  expect(
    (response.contentType ?? '').toLowerCase(),
    'Карта сайта отдаётся как XML.',
  ).toContain('xml');
});

/**
 * Пути, которые обязаны остаться ОТКРЫТЫМИ.
 *
 * Требование «CSS/JS/изображения не блокируются» проверяется утверждением о
 * СОДЕРЖИМОМ robots.txt, а не запросом файлов: файла может не быть (оформление
 * сейчас встроено в HTML, производных изображений на пустой базе нет), но
 * директива, накрывающая эти префиксы, — нарушение уже в момент появления, до
 * первого файла.
 */
const MUST_STAY_CRAWLABLE: readonly { readonly path: string; readonly note: string }[] = [
  { path: '/', note: 'главная' },
  { path: '/otkrytki', note: 'каталог открыток' },
  { path: '/podborki', note: 'раздел подборок' },
  { path: '/o-proekte', note: 'информационная страница (Ч-23 разрешает ей индексацию)' },
  { path: '/sitemap.xml', note: 'сама карта сайта' },
  {
    path: '/media/cards/a1b2c3/otkrytka-mame-na-8-marta-640.webp',
    note: 'производная изображения (Ч-03): закрыв её, сайт прячет от поиска сами открытки',
  },
  { path: '/_astro/index.CafeBabe.css', note: 'оформление страницы (каталог ассетов Astro)' },
  { path: '/_astro/island.CafeBabe.js', note: 'скрипт острова' },
  { path: '/favicon.svg', note: 'иконка сайта' },
];

test('CSS, JS и изображения не заблокированы в robots.txt', async ({ request }) => {
  const { lines } = await readRobots(request);
  const disallow = valuesOf(lines, 'disallow').filter((value) => value !== '');

  /** Префиксное сравнение — ровно так краулер и применяет Disallow. */
  const blockedBy = (path: string): string | null =>
    disallow.find((rule) => path.startsWith(rule)) ?? null;

  // Сначала — что сравнение вообще работает. Без этого утверждения тест был бы
  // тавтологией: при сломанном сопоставлении «ничего не заблокировано» вернулось
  // бы и для закрытых путей тоже.
  expect(
    blockedBy('/search'),
    'Проверка блокировки не работает: путь /search, закрытый решением Ч-22, ею не признан ' +
      'закрытым. Значит, и об открытых путях она ничего не доказывает.',
  ).toBe('/search');

  const blocked = MUST_STAY_CRAWLABLE.map((probe) => ({ ...probe, rule: blockedBy(probe.path) }))
    .filter((probe) => probe.rule !== null)
    .map((probe) => `${probe.path} (${probe.note}) закрыт директивой «Disallow: ${probe.rule}»`);

  expect(
    blocked,
    'CSS, JS и изображения не блокируются (CLAUDE.md, «Sitemap и robots»). Закрытое ' +
      'оформление и закрытые изображения не убирают страницу из индекса — они делают её ' +
      'пустой в глазах поисковой системы, и заметно это только по позициям.',
  ).toEqual([]);
});
