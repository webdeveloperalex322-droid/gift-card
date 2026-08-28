/**
 * Состав карты сайта из записей CMS (задача Э4-04).
 *
 * Разделение с `../seo/sitemap.ts` — по зависимостям, как у карточки и
 * подборки. Там живут ПРАВИЛА (три условия включения, разбиение на файлы, форма
 * XML) — чистые функции без типов CMS. Здесь живёт ЧТЕНИЕ: какие страницы у
 * сайта вообще есть, какая у каждой директива, какой canonical, отвечает ли
 * адрес 200 и когда страница содержательно обновлялась.
 *
 * ## Откуда берётся каждое из трёх условий
 *
 *   1. **директива** — из тех же функций, которыми её считает шаблон:
 *      `homePageRobots`, `catalogPageView`, `infoPageView`, `cardPageRobots`,
 *      `collectionLandingRobots`. Своей формулы у карты сайта нет ни для одного
 *      типа страниц: вторая формула означала бы страницу, закрытую в разметке и
 *      открытую в карте (запрет п. 23);
 *   2. **canonical** — `canonicalPathFor` (та же функция, что у шаблона):
 *      переопределение из поля записи либо собственный путь;
 *   3. **ответ 200** — предикатами, которыми решает МАРШРУТ:
 *        - карточка: есть производные изображения и среди них резервный JPEG.
 *          Ровно это проверяет `cardPageContent` (без производных — `null`, то
 *          есть 404; без резервного JPEG — отказ, то есть 500). И то и другое
 *          означает «адрес не отвечает 200», и в карту такой адрес не идёт;
 *        - подборка: предикат «опубликован И непуст» (`nodesWithContent`), тот
 *          же, которым отбираются ссылки в списках (условие Э3-13-A);
 *        - каталог `/otkrytki`: есть хотя бы одна опубликованная карточка;
 *          каталог `/podborki`: есть хотя бы один непустой корневой узел. Оба —
 *          дословно условия из `./catalog.ts`, где пустой каталог отдаёт 404;
 *        - главная и служебные страницы отвечают 200 всегда (заглушка служебной
 *          страницы — это ответ, обоснование в `../seo/info-pages.ts`).
 *
 * ## Чего здесь нет
 *
 * Страниц пагинации: они не перечисляются вовсе, и отдельного правила для этого
 * не нужно — директива страницы 2+ закрыта (решение Ч-01b), поэтому даже
 * попавший сюда адрес `/page/N` карта отвергла бы. Проверено юнит-тестом
 * (`tests/unit/web-sitemap.test.ts`), а не оставлено на веру.
 *
 * Страниц поиска, фильтров и черновиков: первых двух нет среди перечисляемых
 * маршрутов, третьи не приходят из слоя данных вовсе.
 *
 * ## Цена обхода и почему она принята
 *
 * Карта сайта собирается НА ЗАПРОСЕ, поэтому каждый запрос к её файлам читает
 * все опубликованные записи (пачками по `SITEMAP_SCAN_BATCH`) и спрашивает
 * предикат «непуст» у каждого узла таксономии. Это осознанный выбор задачи
 * Э4-04 против генерации файлов с последующей перегенерацией:
 *
 *   - у файла есть окно устаревания, и в этом окне карта сайта содержит адреса,
 *     которые уже отвечают 404 или уже закрыты `noindex`. Требование
 *     «включаются только 200 и indexable» тогда выполняется не всегда, а «обычно»;
 *   - перегенерация требует эндпоинта, которым кто-то дёргает сборку. Любой
 *     такой эндпоинт — новая точка входа в apps/web, и её пришлось бы защищать;
 *   - запросов к файлам карты сайта единицы в сутки: их читают поисковые
 *     роботы, а не посетители.
 *
 * Граница пересмотра названа явно: когда обход перестанет укладываться в
 * приемлемое время ответа (ориентир — десятки тысяч карточек), выбор меняется на
 * генерацию файлов, и вместе с ним появляется контракт перегенерации. До тех пор
 * «перегенерировать» нечего: свежесть обеспечивается тем, что кеша нет.
 */

import type { Card, Collection, SiteSetting } from '@otkritka/cms/types';
import { buildCardPath } from '@otkritka/cms/seo/paths';
import { INFO_PAGE_KEYS, type SharedEnv } from '@otkritka/shared';

import { cardImageVariants } from './card-image.js';
import {
  listAllPublishedCards,
  listAllPublishedCollections,
  newNodeContentMemo,
  nodesWithContent,
  readSiteSettings,
} from './content.js';
import { infoPageFacts } from './info-pages.js';
import { cardPageRobots, collectionLandingRobots } from './page-data.js';
import { relationId } from './relations.js';
import { pickFallbackVariant, variantAbsoluteUrl } from '../images/card-image.js';
import { canonicalPathFor } from '../routing/canonical.js';
import { CATALOGS, catalogPageView } from '../seo/catalog-pages.js';
import { HOME_PATH, homePageRobots } from '../seo/home-page.js';
import { infoPageView } from '../seo/info-pages.js';
import {
  type SitemapDiagnostics,
  type SitemapImage,
  type SitemapIndexEntry,
  type SitemapPageFacts,
  type SitemapUrl,
  latestLastmod,
  mergeDiagnostics,
  selectSitemapUrls,
  shardFilePath,
  shardUrls,
  SITEMAP_CARDS_PREFIX,
  SITEMAP_IMAGES_PREFIX,
  SITEMAP_SECTIONS_PATH,
} from '../seo/sitemap.js';

/** Страницы-кандидаты сайта: всё, из чего отбирается карта. */
export interface SitemapFacts {
  /** Главная, каталоги, служебные страницы и узлы таксономии. */
  readonly sections: readonly SitemapPageFacts[];
  /** Страницы карточек. */
  readonly cards: readonly SitemapPageFacts[];
}

/** Готовая карта сайта: файлы, их содержимое и разбор отбора. */
export interface SitemapModel {
  /** Разделы: главная, каталоги, служебные страницы, узлы таксономии. */
  readonly sections: readonly SitemapUrl[];
  /** Файлы карточек. Пустой массив — включать нечего, файлов нет вовсе. */
  readonly cardShards: readonly (readonly SitemapUrl[])[];
  /** Файлы image sitemap. Те же адреса, но с изображениями страниц. */
  readonly imageShards: readonly (readonly SitemapUrl[])[];
  /**
   * Разбор отбора: сколько страниц рассмотрено, сколько вошло и по каким
   * причинам остальные не вошли.
   *
   * Нужен ровно затем, чтобы пустая карта сайта была ОБЪЯСНИМА. На
   * ненаполненной базе она пуста законно, и без диагностики «пусто, потому что
   * публиковать нечего» неотличимо от «пусто, потому что отбор всё съел».
   */
  readonly diagnostics: SitemapDiagnostics;
}

/**
 * Изображение карточки для image sitemap либо `null`, если показывать нечего.
 *
 * Берётся РЕЗЕРВНАЯ производная — тот самый файл, который стоит в `<img src>` и
 * в `ImageObject.contentUrl` (`./page-data.ts`). Описывать в карте другой файл
 * значило бы сослаться на изображение, которого на странице нет.
 */
function cardImage(card: Card, env: SharedEnv | undefined): SitemapImage | null {
  const variants = cardImageVariants(card);
  if (variants.length === 0) {
    return null;
  }
  try {
    return { loc: variantAbsoluteUrl(pickFallbackVariant(variants), env) };
  } catch {
    // Повреждённое зеркало: производные есть, резервного JPEG нет. Страница
    // карточки в этом состоянии не отвечает 200 — она падает на сборке разметки
    // (`pickFallbackVariant` там же и бросает). Значит, и в карту сайта адрес не
    // идёт: вызывающий увидит `null` и поставит `respondsOk: false`.
    return null;
  }
}

/**
 * Значение, которое ЗАВЕДОМО не является путём страницы.
 *
 * Нужно там, где запись повреждена: у подборки пусто поле `path`, в поле
 * `canonical` лежит абсолютный адрес. Такая запись обязана быть ИСКЛЮЧЕНА с
 * причиной, а не уронить сборку всей карты сайта и не превратиться в адрес
 * «почти правильный» (пустой путь дал бы `/`, то есть главную). Фрагмент в
 * значении делает его непутём по правилам `@otkritka/shared`, и отбор отвечает
 * `not-a-path`.
 */
const NOT_A_PATH = '#zapis-bez-puti';

/**
 * Канонический путь записи; при негодном значении поля — {@link NOT_A_PATH}.
 *
 * `canonicalPathFor` на абсолютном адресе в поле `canonical` бросает исключение
 * — и правильно делает: шаблону страницы нельзя молча подставить чужой хост. Но
 * карта сайта строится по ВСЕМУ каталогу, и одна испорченная запись не должна
 * уносить с собой карту целиком: она исключается с названной причиной.
 */
function canonicalOrRejected(override: string | null | undefined, selfPath: string): string {
  try {
    return canonicalPathFor(override, selfPath);
  } catch {
    return NOT_A_PATH;
  }
}

/** Факты о странице карточки — вход отбора. */
function cardFacts(card: Card, env: SharedEnv | undefined): SitemapPageFacts {
  const pagePath = buildCardPath(card.slug);
  const image = cardImage(card, env);

  return {
    canonicalPath: canonicalOrRejected(card.canonical, pagePath),
    images: image === null ? [] : [image],
    lastmod: card.updatedContentAt,
    pagePath,
    // Условие 3 для карточки: страница показывает открытку. Без изображения она
    // отвечает 404 (`cardPageContent` возвращает `null`), а с повреждённым
    // зеркалом — отказом; и то и другое не 200.
    respondsOk: image !== null,
    robots: cardPageRobots(card),
  };
}

/** Факты о странице подборки. `respondsOk` приходит извне — это предикат «непуст». */
function collectionFacts(node: Collection, hasContent: boolean): SitemapPageFacts {
  // Путь узла считает и хранит CMS. Пустое поле означает повреждённую запись, и
  // подставлять вместо него `/` нельзя ни при каких обстоятельствах: пустая
  // строка нормализуется в корень сайта, то есть узел занял бы главную.
  const stored = node.path?.trim() ?? '';
  const pagePath = stored === '' ? NOT_A_PATH : stored;

  return {
    canonicalPath: canonicalOrRejected(node.canonical, pagePath),
    lastmod: node.updatedContentAt,
    pagePath,
    respondsOk: hasContent,
    robots: collectionLandingRobots(node),
  };
}

/** Факты о служебных страницах Ч-23. Их директиву считает единственный предикат. */
function infoPageFactsForSitemap(settings: SiteSetting): readonly SitemapPageFacts[] {
  return INFO_PAGE_KEYS.map((key) => {
    const view = infoPageView(key, infoPageFacts(settings, key));
    return {
      canonicalPath: view.path,
      pagePath: view.path,
      // Служебная страница отвечает 200 и с заглушкой: у неё есть видимый текст
      // и навигация, а от индексации её закрывает директива (решение Ч-23).
      respondsOk: true,
      robots: view.robots,
    };
  });
}

/**
 * Все страницы-кандидаты сайта с фактами о каждой — ДО отбора.
 *
 * Отдельная функция, а не внутренний шаг {@link buildSitemapModel}: набор
 * кандидатов и результат отбора — разные вопросы, и второй из них имеет смысл
 * только вместе с первым. Смоук на живой базе (`apps/web/scripts/smoke-sitemap.ts`)
 * читает именно кандидатов: пустая карта сайта объяснима только тогда, когда
 * видно, СКОЛЬКО страниц рассматривалось и что отсеяла именно директива.
 *
 * @throws Error если `SITE_URL` не задан либо обход не сходится (`./content.ts`).
 */
export async function collectSitemapFacts(env?: SharedEnv): Promise<SitemapFacts> {
  const memo = newNodeContentMemo();
  const [cards, nodes, settings] = await Promise.all([
    listAllPublishedCards(),
    listAllPublishedCollections(),
    readSiteSettings(),
  ]);

  // Предикат «непуст» спрашивается ОДИН раз на узел: мемоизатор общий на всю
  // сборку карты, а не на страницу (обоснование предиката — `./content.ts`).
  const filled = new Set((await nodesWithContent(nodes, memo)).map((node) => String(node.id)));
  const rootsWithContent = nodes.filter(
    (node) => relationId(node.parent) === null && filled.has(String(node.id)),
  );

  // Первая страница каталога — та, что живёт по базовому URL (решение Ч-05).
  // Голова документа берётся у той же функции, что у маршрута, поэтому и
  // canonical, и директива здесь ровно те, что уйдут в разметку.
  const cardsCatalog = catalogPageView('cards', 1);
  const nodesCatalog = catalogPageView('collections', 1);

  return {
    cards: cards.map((card) => cardFacts(card, env)),
    sections: [
      {
        canonicalPath: HOME_PATH,
        pagePath: HOME_PATH,
        respondsOk: true,
        robots: homePageRobots(),
      },
      {
        canonicalPath: cardsCatalog.canonicalPath,
        pagePath: CATALOGS.cards.path,
        // Пустой каталог отдаёт 404, а не 200 с пустой сеткой (`./catalog.ts`).
        respondsOk: cards.length > 0,
        robots: cardsCatalog.robots,
      },
      {
        canonicalPath: nodesCatalog.canonicalPath,
        pagePath: CATALOGS.collections.path,
        respondsOk: rootsWithContent.length > 0,
        robots: nodesCatalog.robots,
      },
      ...infoPageFactsForSitemap(settings),
      ...nodes.map((node) => collectionFacts(node, filled.has(String(node.id)))),
    ],
  };
}

/**
 * Карта сайта из набора кандидатов. Отделена от чтения базы, поэтому её можно
 * собрать и на подставленных фактах — этим пользуется смоук.
 */
export function sitemapModelFrom(facts: SitemapFacts, env?: SharedEnv): SitemapModel {
  const sections = selectSitemapUrls(facts.sections, env);
  const cards = selectSitemapUrls(facts.cards, env);
  // В image sitemap идут только адреса, у которых изображение действительно
  // есть. Совпадение с набором карточек не предполагается: пустая запись в image
  // sitemap ничего не описывает, и `renderImageUrlset` от неё отказывается.
  const withImages = cards.urls.filter((url) => url.images.length > 0);

  return {
    cardShards: shardUrls(cards.urls),
    diagnostics: mergeDiagnostics([sections.diagnostics, cards.diagnostics]),
    imageShards: shardUrls(withImages),
    sections: sections.urls,
  };
}

/**
 * Полная карта сайта из текущего состояния базы.
 *
 * @throws Error если `SITE_URL` не задан, если у записи испорчена дата
 *   содержательного обновления либо если обход не сходится (см. `./content.ts`).
 */
export async function buildSitemapModel(env?: SharedEnv): Promise<SitemapModel> {
  return sitemapModelFrom(await collectSitemapFacts(env), env);
}

/**
 * Записи sitemap-индекса: только НЕПУСТЫЕ файлы.
 *
 * Файл без единого адреса в индекс не попадает и по своему адресу не
 * существует — маршрут отвечает на него 404. Иначе индекс ссылался бы на
 * заведомо невалидную карту сайта, а поисковая система показала бы это ошибкой.
 */
export function sitemapIndexEntries(
  model: SitemapModel,
  absolute: (path: string) => string,
): readonly SitemapIndexEntry[] {
  const entries: SitemapIndexEntry[] = [];

  if (model.sections.length > 0) {
    entries.push({
      lastmod: latestLastmod(model.sections),
      loc: absolute(SITEMAP_SECTIONS_PATH),
    });
  }
  model.cardShards.forEach((shard, index) => {
    entries.push({
      lastmod: latestLastmod(shard),
      loc: absolute(shardFilePath(SITEMAP_CARDS_PREFIX, index + 1)),
    });
  });
  model.imageShards.forEach((shard, index) => {
    entries.push({
      lastmod: latestLastmod(shard),
      loc: absolute(shardFilePath(SITEMAP_IMAGES_PREFIX, index + 1)),
    });
  });

  return entries;
}

/** Содержимое файла-части по номеру либо `null` — такого файла нет. */
export function shardAt(
  shards: readonly (readonly SitemapUrl[])[],
  shard: number | null,
): readonly SitemapUrl[] | null {
  if (shard === null) {
    return null;
  }
  return shards[shard - 1] ?? null;
}
