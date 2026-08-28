/**
 * Содержимое страниц карточки и подборки из записей CMS (задачи Э3-05, Э3-06).
 *
 * Разделение с `../seo/card-page.ts` и `../seo/collection-page.ts` — по
 * зависимостям, как у крошек и у изображения. Там живут ПРАВИЛА разметки (состав
 * свойств, абсолютные адреса, отказ на пустом обязательном значении) — чистые
 * функции без типов CMS. Здесь живёт ЧТЕНИЕ ЗАПИСИ: какие поля становятся
 * заголовком, описанием, подписью, списком и ссылками. Модуль импортирует
 * сгенерированные типы Payload, поэтому в composite-проект
 * `../../tsconfig.node.json` войти не может, и его тест лежит рядом
 * (`./page-data.test.ts`).
 *
 * Запросов здесь нет: записи приходят аргументами, читает их маршрут через
 * `./content.ts`. Поэтому модуль грузится без конфига Payload, и его тест не
 * поднимает CMS.
 *
 * ## Зачем шаблонам ОДНА функция на страницу, а не набор мелких
 *
 * Три требования проверяемы только тогда, когда у видимого блока и у разметки
 * ОДНО значение, а не два совпадающих:
 *
 *   - `ItemList` соответствует видимой сетке: те же элементы, тот же порядок,
 *     столько же (ТЗ §5.3). Здесь это буквально ОДИН И ТОТ ЖЕ массив: сетка
 *     получает {@link CardTile}, а `itemListElement` собирается из него же;
 *   - `ImageObject.contentUrl` указывает на файл, который страница ПОКАЗЫВАЕТ, а
 *     `width`/`height` совпадают с размерами этого файла. Резервная производная
 *     выбирается один раз и уходит в три места: `<img src>` (через компонент),
 *     кнопку «Скачать» и разметку;
 *   - `WebPage.url` и `CollectionPage.url` совпадают с self-canonical символ в
 *     символ: канонический путь вычисляется здесь один раз и передаётся и в
 *     layout, и в сборку разметки.
 *
 * ## Где принимается решение «страница не существует»
 *
 * В обеих функциях, значением `null`:
 *
 *   - карточка без производных изображения. Содержание страницы карточки — это
 *     открытка; без неё остаются заголовок и подпись, то есть ровно «слабая
 *     страница», которой запрещено отдавать 200 (ТЗ §5.3). CMS не пускает
 *     карточку без изображения даже в `review`, поэтому у опубликованной записи
 *     производные есть, а `null` означает повреждённое зеркало — и честный ответ
 *     на это 404, а не 200 без картинки;
 *   - подборка, у которой нет ни открыток, ни дочерних узлов. Пустая сетка под
 *     заголовком — тот же случай, и именно так возникает soft 404 у списков.
 *
 * Решение об HTTP-статусе принимает маршрут: слой данных отвечать 404 не умеет, а
 * функция обязана проверяться без сервера.
 */

import type { Card, Collection, SiteSetting } from '@otkritka/cms/types';
import { buildCardPath } from '@otkritka/cms/seo/paths';
import {
  aiDisclosureText,
  imageCreatorJsonLd,
  imageLicenseJsonLd,
  type SharedEnv,
} from '@otkritka/shared';

import { pickFallbackVariant, variantPath } from '../images/card-image.js';
import { canonicalPathFor } from '../routing/canonical.js';
import {
  type CardFormat,
  cardFormatOf,
  type FilterOption,
  filterOptions,
  NO_VIEW_PARAMS,
  type ViewParams,
} from '../routing/view-params.js';
import {
  type PaginationModel,
  paginationModel,
  paginationPathFor,
  paginationTitle,
} from '../routing/pagination.js';
import { type PageRobots, resolvePageRobots } from '../seo/robots-directive.js';
import { type CardPageJsonLd, cardPageJsonLd } from '../seo/card-page.js';
import {
  type CollectionPageJsonLd,
  collectionPageJsonLd,
  type ListItemFacts,
} from '../seo/collection-page.js';
import { recordHeading } from '../seo/headings.js';
import { seasonalWindowContains } from '../seo/home-page.js';
import { type CardImageSource, cardImageAlt, cardImageVariants } from './card-image.js';

/**
 * Путь карточки собирается ЕДИНСТВЕННОЙ функцией проекта. Взята она напрямую из
 * `@otkritka/cms/seo/paths`, а не обёрткой `cardPath` из `./content.ts`, по той
 * же причине, что в `./breadcrumbs.ts`: `./content.ts` на загрузке тянет конфиг
 * Payload, а этому модулю он не нужен — иначе его юнит-тест поднимал бы CMS ради
 * чистых преобразований.
 */
function cardPathOf(card: Pick<Card, 'slug'>): string {
  return buildCardPath(card.slug);
}

/**
 * Плитка сетки: всё, что нужно и компоненту сетки, и элементу `ItemList`.
 *
 * Поля `name` и `path` — это одновременно видимый текст ссылки с её `href` и
 * `name` с `url` элемента разметки. Именно поэтому тип один: два разных объекта
 * (один для сетки, другой для разметки) означали бы два значения, которые
 * обязаны совпадать, но проверяются по отдельности.
 */
export interface CardTile extends ListItemFacts {
  /** Поля записи для компонента изображения: `alt` и зеркало производных. */
  readonly image: CardImageSource;
  /**
   * Формат открытки, посчитанный по фактическим размерам файла (задача Э3-10).
   *
   * `null` — у записи нет ни одной производной, то есть показывать нечего;
   * такая плитка не попадает ни в один фильтр. Значение считается ЗДЕСЬ, а не в
   * шаблоне, потому что фильтр обязан прятать ровно ту плитку, которую видно, —
   * а видно то, что описывает зеркало производных.
   */
  readonly format: CardFormat | null;
}

/** Заполненное текстовое поле записи либо `null` — «редактор не заполнил». */
function filled(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** Плитки для сетки в порядке, в котором их вернул запрос. */
export function cardTiles(cards: readonly Card[]): readonly CardTile[] {
  return cards.map((card) => ({
    format: tileFormat(card),
    image: card,
    name: recordHeading(card),
    path: cardPathOf(card),
  }));
}

/**
 * Формат плитки по зеркалу производных.
 *
 * Берётся ЛЮБОЙ вариант: производные — это одно изображение в разных ширинах,
 * поэтому пропорция у них общая, а резервный JPEG для такого вопроса искать
 * незачем (его отсутствие — повреждённое зеркало, и отвечает на это страница
 * карточки отказом, а не сетка). Пустое зеркало даёт `null`: плитка без
 * изображения не принадлежит ни одному формату.
 */
function tileFormat(card: Card): CardFormat | null {
  const variant = cardImageVariants(card).at(0);
  return variant === undefined ? null : cardFormatOf(variant);
}

/**
 * Плитки, оставшиеся видимыми при активном фильтре (задача Э3-10).
 *
 * Фильтр ПРЯЧЕТ плитки на страницах канонического списка и ничего не
 * пересобирает: ни числа страниц, ни их состава, ни адресов. Обоснование — в
 * шапке `../routing/view-params.ts`; здесь только применение правила к плиткам.
 */
export function filterTiles(
  tiles: readonly CardTile[],
  params: ViewParams,
): readonly CardTile[] {
  if (params.format === null) {
    return tiles;
  }
  return tiles.filter((tile) => tile.format === params.format);
}

/* ------------------------------------------------------------------ */
/* Карточка открытки (ТЗ §5.4)                                        */
/* ------------------------------------------------------------------ */

/**
 * Видимый атрибут карточки: подборка, в которую она входит, — ссылкой.
 *
 * Стиля и настроения среди атрибутов нет намеренно: по решению Ч-04-3 это
 * фильтр без собственных URL, отдельных полей у карточки в схеме тоже нет, и
 * ссылки на несуществующую страницу здесь не появится.
 */
export interface CardAttributeLink extends ListItemFacts {
  /** Что это за привязка: повод, адресат, раздел. */
  readonly kindLabel: string;
}

/** Названия видов узла таксономии для видимой подписи атрибута. */
const NODE_KIND_LABELS: Readonly<Record<Collection['nodeKind'], string>> = {
  group: 'Раздел',
  occasion: 'Повод',
  recipient: 'Адресат',
};

export interface CardPageContent {
  /** Канонический путь страницы: поле `canonical` записи либо `/otkrytki/<slug>`. */
  readonly canonicalPath: string;
  /** Единственный H1 страницы. */
  readonly heading: string;
  /** `<title>`. Отдельно от H1: у записи это разные поля (ТЗ §8.1). */
  readonly title: string;
  /** `<meta name="description">`. `null` — тега нет вовсе, а не пустой тег. */
  readonly metaDescription: string | null;
  /**
   * Директива робота: объявленное человеком поле записи, пропущенное через
   * единственный разрешатель (задача Э4-01). Догадок здесь нет — разрешатель
   * умеет только закрывать.
   */
  readonly robots: PageRobots;
  /** Видимая подпись или текст поздравления. */
  readonly caption: string | null;
  /** Видимое описание открытки. */
  readonly description: string | null;
  /**
   * Условия использования, заданные у САМОЙ открытки. Пусто — действуют условия
   * проекта, и отдельной подписи на странице нет.
   */
  readonly usageTerms: string | null;
  /**
   * Видимое указание на то, что изображение создано нейросетью (решение Ч-10).
   * `null` — формулировка в настройках не заполнена, и подписи нет вовсе.
   */
  readonly aiDisclosure: string | null;
  /** Прямой адрес файла для кнопки «Скачать»: самая широкая производная JPEG. */
  readonly downloadPath: string;
  /** Размеры того же файла — они же в разметке `ImageObject`. */
  readonly downloadWidth: number;
  readonly downloadHeight: number;
  /** Видимые атрибуты-ссылки в порядке, заданном редактором. */
  readonly attributes: readonly CardAttributeLink[];
  /** Похожие открытки: обязательный блок достижимости (решение Ч-04-8). */
  readonly similar: readonly CardTile[];
  readonly jsonLd: CardPageJsonLd;
}

export interface CardPageInput {
  readonly card: Card;
  /** Глобал настроек: из него берутся лицензионные поля и указание на ИИ (Ч-10). */
  readonly settings: SiteSetting;
  /** Подборки карточки в порядке редактора — только опубликованные. */
  readonly collections: readonly Collection[];
  /** Похожие открытки, уже отобранные запросом. */
  readonly similar: readonly Card[];
  readonly env?: SharedEnv;
}

/**
 * Содержимое страницы карточки либо `null`, если показывать нечего.
 *
 * @throws Error если `SITE_URL` не задан, если пусты и H1, и title, если пуст
 *   `alt` изображения либо если в поле `canonical` записи лежит абсолютный
 *   адрес. Все четыре случая — незаполненная или повреждённая запись, и
 *   молчаливая деградация здесь хуже отказа: страница выглядела бы исправной.
 */
export function cardPageContent(input: CardPageInput): CardPageContent | null {
  const variants = cardImageVariants(input.card);
  if (variants.length === 0) {
    return null;
  }

  const heading = recordHeading(input.card);
  const canonicalPath = canonicalPathFor(input.card.canonical, cardPathOf(input.card));
  // Резервная производная — та же, что попадает в `<img src>`: её адрес идёт и в
  // кнопку «Скачать», и в `ImageObject.contentUrl`. Одно значение на три места;
  // иначе страница показывает один файл, а разметка описывает другой.
  const fallback = pickFallbackVariant(variants);
  const description = filled(input.card.description);
  // `alt` взят резервом описания намеренно: у `ImageObject` свойство
  // `description` обязательно, а alt — это и есть описание изображения, уже
  // присутствующее в ответе сервера. Заголовок описанием картинки не является и
  // сюда не подставляется.
  const alt = cardImageAlt(input.card);
  const imageDescription = description ?? (alt.kind === 'decorative' ? '' : alt.text);

  return {
    aiDisclosure: aiDisclosureText(input.settings.imageLicense),
    attributes: cardAttributeLinks(input.collections),
    canonicalPath,
    caption: filled(input.card.caption),
    description,
    downloadHeight: fallback.height,
    downloadPath: variantPath(fallback),
    downloadWidth: fallback.width,
    heading,
    jsonLd: cardPageJsonLd(
      {
        canonicalPath,
        description: input.card.metaDescription,
        heading,
        image: {
          caption: input.card.caption,
          description: imageDescription,
          name: heading,
          variant: fallback,
        },
        // Лицензионная часть — целиком или никак (решение Ч-10). Предикат живёт
        // в `@otkritka/shared`; своей трактовки «заполнено ли» здесь нет.
        license: imageLicenseJsonLd(input.settings.imageLicense),
        // Правообладатель — ОТДЕЛЬНЫЙ предикат и отдельное свойство разметки:
        // `creator` в schema.org это узел `Person | Organization`, и строку без
        // типа потребитель игнорирует. Вид выбирает человек полем `creatorKind`;
        // пока не выбрал, узла нет вовсе — как у любого пустого значения по Ч-10.
        creator: imageCreatorJsonLd(input.settings.imageLicense),
      },
      input.env,
    ),
    metaDescription: filled(input.card.metaDescription),
    // Директива считается ОДНИМ разрешателем на все типы страниц (задача Э4-01).
    // Карточке он добавляет два условия, которых у неё раньше не было: пустое
    // описание закрывает страницу от индексации (индексируемая страница без
    // description не проходит п. 22.1, а сочинить его вместо редактора запрещает
    // п. 23.4), и неопубликованный статус закрывает её независимо от поля
    // `robots`, оставшегося с прошлой публикации. Второе недостижимо — черновик
    // до шаблона не доходит (`./read-scope.ts`), — и стоит здесь именно потому,
    // что цена ошибки в этом месте выше цены двойной проверки.
    robots: resolvePageRobots({
      declared: input.card.robots,
      description: input.card.metaDescription,
      status: input.card.status,
    }).robots,
    similar: cardTiles(input.similar),
    title: input.card.title,
    usageTerms: filled(input.card.usageTerms),
  };
}

/** Атрибуты-ссылки из подборок карточки. Узел без сохранённого пути выпадает. */
export function cardAttributeLinks(
  collections: readonly Collection[],
): readonly CardAttributeLink[] {
  const links: CardAttributeLink[] = [];
  for (const node of collections) {
    const path = filled(node.path);
    if (path === null) {
      continue;
    }
    links.push({
      kindLabel: NODE_KIND_LABELS[node.nodeKind],
      name: recordHeading(node),
      path,
    });
  }
  return links;
}

/* ------------------------------------------------------------------ */
/* Подборка (ТЗ §5.3)                                                 */
/* ------------------------------------------------------------------ */

export interface CollectionPageContent {
  /** Канонический путь: поле `canonical` записи либо сохранённый `path`. */
  readonly canonicalPath: string;
  readonly heading: string;
  readonly title: string;
  readonly metaDescription: string | null;
  /** Директива робота, посчитанная единственным разрешателем (задача Э4-01). */
  readonly robots: PageRobots;
  /**
   * Номер показанной страницы списка, начиная с 1. Первая страница живёт по
   * базовому URL (решение Ч-05).
   */
  readonly page: number;
  /**
   * Блок ссылок пагинации либо `null` — страниц не больше одной, и ссылаться
   * некуда. Модель считает `../routing/pagination.ts`; `/page/1` в ней не
   * появляется по построению.
   */
  readonly pagination: PaginationModel | null;
  /**
   * Вводный текст: lexical-документ, рендерится сервером как есть. На страницах
   * пагинации — `null`: вводный текст принадлежит посадочной странице списка, и
   * повторять его на каждой странице значило бы выдать один и тот же текст по
   * нескольким адресам.
   */
  readonly intro: Collection['intro'];
  /**
   * Дата содержательного обновления (ТЗ §5.3). `null` — редактор её не ставил, и
   * тогда нет ни видимой даты, ни `dateModified` в разметке: подставлять вместо
   * неё `updatedAt` запрещено — техническая правка обновлением не является.
   */
  readonly updatedContentAt: string | null;
  /**
   * Плитки сетки — уже с учётом фильтра представления. РОВНО этот массив обязан
   * отрендерить шаблон, и ровно из него собран `ItemList`.
   */
  readonly tiles: readonly CardTile[];
  /**
   * Сколько плиток на этой странице списка ВСЕГО, без учёта фильтра.
   *
   * Нужно видимой подписи «показано N из M»: фильтр прячет часть плиток
   * канонической страницы, и посетитель обязан видеть, что список не кончился.
   */
  readonly tilesOnPage: number;
  /** Активные параметры представления (Э3-10). */
  readonly filter: ViewParams;
  /**
   * Ряд ссылок фильтра. Первая ведёт на ЧИСТЫЙ адрес текущей страницы, то есть
   * на её canonical, — сброс фильтра всегда в один клик.
   */
  readonly filterOptions: readonly FilterOption[];
  /** Ссылки вниз — на дочерние узлы. */
  readonly children: readonly ListItemFacts[];
  /** Ссылка вверх — на родителя. `null` у узла верхнего уровня. */
  readonly parent: ListItemFacts | null;
  /** Смежные узлы вбок (3–6 по ТЗ §5.3; предел ставит запрос). */
  readonly related: readonly ListItemFacts[];
  /**
   * Разметка страницы либо `null` — когда видимого списка нет вовсе.
   *
   * `null` возможен ровно в одном состоянии: фильтр представления не оставил ни
   * одной плитки, а дочерних узлов у подборки нет. Описывать пустой список
   * `ItemList` нельзя (разметка обязана соответствовать видимому содержимому),
   * а страница при этом законно отвечает 200: её статус определяется записью, а
   * не набором параметров.
   */
  readonly jsonLd: CollectionPageJsonLd | null;
}

export interface CollectionPageInput {
  readonly node: Collection;
  /** Карточки ЭТОЙ страницы списка — уже выбранная страница, а не весь список. */
  readonly cards: readonly Card[];
  readonly children: readonly Collection[];
  readonly parent: Collection | null;
  readonly related: readonly Collection[];
  /**
   * Номер показанной страницы, начиная с 1.
   *
   * Обязательный параметр без значения по умолчанию: дефолт `1` означал бы, что
   * маршрут, забывший передать номер, молча отдаёт первую страницу по адресу
   * второй — то есть дубль с чужим canonical. Забывчивость обязана быть ошибкой
   * типов.
   */
  readonly page: number;
  /**
   * Всего страниц у списка (`CardsPage.pageCount`).
   *
   * Тоже обязательный: без него шаблон не выведет ссылок пагинации, и открытки
   * за первой страницей станут недостижимыми — а это уже страницы-сироты.
   */
  readonly pageCount: number;
  /**
   * Параметры представления из строки запроса (Э3-10). Не переданы — фильтра
   * нет.
   *
   * На РЕШЕНИЕ «страница существует» они не влияют вовсе: статус ответа обязан
   * зависеть от записи, а не от набора параметров, иначе один и тот же адрес
   * отдавал бы то 200, то 404 в зависимости от хвоста ссылки.
   */
  readonly view?: ViewParams;
  readonly env?: SharedEnv;
}

/**
 * Содержимое страницы подборки либо `null`, если показывать нечего.
 *
 * @throws Error если `SITE_URL` не задан, если у записи нет сохранённого пути,
 *   если пусты и H1, и title либо если в поле `canonical` лежит абсолютный
 *   адрес.
 */
export function collectionPageContent(input: CollectionPageInput): CollectionPageContent | null {
  const allTiles = cardTiles(input.cards);
  const children = collectionLinks(input.children);
  // Решение «страница существует» принимается по ЗАПИСИ и до применения фильтра:
  // адрес, отдающий 200 без параметров и 404 с ними, — это два разных ответа
  // одной страницы, то есть ровно тот дубль-наоборот, которого ТЗ §6.5 велит
  // избегать.
  if (allTiles.length === 0 && children.length === 0) {
    return null;
  }
  const view = input.view ?? NO_VIEW_PARAMS;
  const tiles = filterTiles(allTiles, view);

  const path = filled(input.node.path);
  if (path === null) {
    throw new Error(
      `У подборки #${String(input.node.id)} нет сохранённого пути, поэтому страницу собрать ` +
        'нельзя: путь — это и адрес страницы, и её self-canonical. Значение считает и хранит ' +
        'CMS; пустое здесь означает, что запись получена не поиском по пути.',
    );
  }

  const page = input.page;
  const isFirstPage = page === 1;
  // Self-canonical страницы пагинации указывает на САМУ СЕБЯ, и строится он от
  // сохранённого пути записи, а не от поля `canonical`. Причина: `/page/N` — это
  // адрес страницы списка, а поле `canonical` описывает посадочную страницу.
  // Дописать номер к чужому переопределению значило бы придумать адрес, которого
  // нет ни у этой записи, ни у той, на которую переопределение указывает. При
  // этом страницы 2+ всё равно закрыты от индексации, поэтому переопределение
  // человека на первой странице своей силы не теряет.
  const canonicalPath = isFirstPage
    ? canonicalPathFor(input.node.canonical, path)
    : paginationPathFor(path, page);
  // АДРЕС САМОЙ СТРАНИЦЫ — не то же, что её canonical, и разводить их обязательно.
  // canonical на первой странице может быть переопределением из поля `canonical`
  // записи, то есть указывать на ДРУГУЮ страницу; адрес же всегда собирается из
  // сохранённого пути. Всё, что ведёт «сюда же» (ряд фильтра, пункт сброса
  // фильтра), обязано брать этот путь, иначе ссылки уводили бы с той страницы,
  // на которой напечатаны (находка вердиктов `reviewer` и `url-guard`).
  // `/page/1` не возникает: `paginationPathFor` на номере 1 отдаёт базовый путь.
  const pagePath = paginationPathFor(path, page);
  // Заголовок и title получают номер страницы: два одинаковых title на двух
  // адресах — это дубль (п. 22.1). Правило одно на подборку и на каталог и живёт
  // в ../routing/pagination.ts.
  const heading = paginationTitle(recordHeading(input.node), page);
  const title = paginationTitle(input.node.title, page);
  // Описание — только на первой странице: повторить его на всех означало бы
  // одинаковый description на разных адресах, а дописать номер — сочинить
  // шаблонный текст (запрет п. 23.4). Пусто → тега нет вовсе.
  const metaDescription = isFirstPage ? filled(input.node.metaDescription) : null;
  const updatedContentAt = filled(input.node.updatedContentAt);
  const parent = collectionLinks([input.parent]).at(0) ?? null;
  // Видимый список страницы: сетка открыток, а у узла без своих открыток — список
  // дочерних узлов. Из ЭТОГО значения собирается ItemList, и другого источника у
  // него нет (обоснование — шапка ../seo/collection-page.ts). С активным фильтром
  // видимой считается ОТФИЛЬТРОВАННАЯ сетка: разметка описывает то, что на
  // экране, а не то, что лежит в базе.
  const items: readonly ListItemFacts[] = tiles.length > 0 ? tiles : children;

  return {
    canonicalPath,
    children,
    filter: view,
    // Ряд ссылок строится от АДРЕСА этой страницы: на второй странице списка
    // фильтр остаётся на второй странице, а сброс ведёт на её чистый адрес. Тот
    // же источник, что у пагинации ниже, — и это условие, а не совпадение.
    filterOptions: filterOptions(pagePath, view),
    heading,
    intro: isFirstPage ? input.node.intro : null,
    jsonLd:
      items.length === 0
        ? null
        : collectionPageJsonLd(
            {
              canonicalPath,
              dateModified: updatedContentAt,
              description: metaDescription,
              heading,
              items,
            },
            input.env,
          ),
    metaDescription,
    page,
    pagination: paginationModel({ basePath: path, page, pageCount: input.pageCount }),
    parent,
    // Из «Смотрите также» исключены все адреса, на которые страница УЖЕ
    // ссылается: свой собственный, родитель из того же блока и ДЕТИ из блока
    // «Разделы подборки». Дети — та же находка, что была исправлена для
    // родителя (ревизия Э3-05/Э3-06, LOW): связь `related` заполняет редактор, и
    // он вправе указать в ней дочерний узел; тогда на группирующем узле ссылка
    // на ребёнка печаталась дважды — вниз и вбок.
    related: withoutPaths(collectionLinks(input.related), [
      canonicalPath,
      path,
      ...(parent === null ? [] : [parent.path]),
      ...children.map((child) => child.path),
    ]),
    // Директива робота: ОДИН разрешатель на все условия (задача Э4-01). До него
    // это была композиция двух функций из двух модулей, и каждый шаблон складывал
    // её сам. Здесь ему передаются только ФАКТЫ: объявленная человеком директива
    // записи, номер страницы (2+ → noindex,follow, решение Ч-01b), активный
    // фильтр (ТЗ §5.2), фактическое описание (его отсутствие закрывает страницу)
    // и статус записи. Открыть страницу разрешатель не может ни по одному факту.
    robots: resolvePageRobots({
      declared: input.node.robots,
      description: metaDescription,
      listPage: page,
      status: input.node.status,
      view,
    }).robots,
    tiles,
    tilesOnPage: allTiles.length,
    title,
    updatedContentAt,
  };
}

/* ------------------------------------------------------------------ */
/* Главная (задача Э3-09)                                             */
/* ------------------------------------------------------------------ */

/**
 * Ссылки сезонного блока главной: подборки, чьё окно показа накрывает день.
 *
 * ПОЧЕМУ ОКНО ПРОВЕРЯЕТСЯ ЗДЕСЬ, если его же проверяет запрос
 * (`./queries.ts`, `seasonalCollectionsQuery`). Запрос отвечает на вопрос «какие
 * записи читать», и без него главная тянула бы всю таксономию. Видимый блок
 * собирается ПО ПОЛЯМ САМОЙ ЗАПИСИ: `showFrom` и `showUntil` приходят в
 * документе, и решение «показывать ли» становится проверяемым без базы —
 * `tests/unit/web-home-page.test.ts` разбирает случай «одна граница пуста», из-за
 * которого блок и мог бы показать подборку в день, которого редактор не
 * назначал. Правило при этом ОДНО и живёт в `../seo/home-page.ts`; здесь только
 * чтение записи.
 *
 * Порядок сохраняется тот, в котором записи вернул запрос (по дате праздника):
 * пересортировки здесь нет — иначе видимый порядок зависел бы от двух мест.
 */
export function seasonalLinks(
  nodes: readonly Collection[],
  today: Date,
): readonly ListItemFacts[] {
  return collectionLinks(nodes.filter((node) => seasonalWindowContains(node.seasonal, today)));
}

/* ------------------------------------------------------------------ */
/* Каталоги разделов /otkrytki и /podborki (задача Э3-08)             */
/* ------------------------------------------------------------------ */

/**
 * Раздел каталога `/podborki`: узел верхнего уровня и его прямые дети.
 *
 * Двух уровней достаточно и больше не нужно: глубже лежат пары «праздник ×
 * адресат», и они достижимы со страницы своего праздничного узла. Отсюда и
 * глубина от главной: главная → `/podborki` → узел верхнего уровня → пара →
 * карточка, то есть ровно четыре перехода (следствие Ч-04-5).
 */
export interface CatalogSection {
  readonly node: ListItemFacts;
  readonly children: readonly ListItemFacts[];
}

/**
 * Разделы каталога подборок из записей CMS.
 *
 * Узел без сохранённого пути выпадает вместе со своими детьми: ссылки на него нет
 * (правило `collectionLinks`), а дети без родителя в плоском виде превратили бы
 * карту разделов в перечень без структуры.
 */
export function catalogSections(
  input: readonly { readonly node: Collection; readonly children: readonly Collection[] }[],
): readonly CatalogSection[] {
  const sections: CatalogSection[] = [];
  for (const entry of input) {
    const node = collectionLinks([entry.node]).at(0);
    if (node === undefined) {
      continue;
    }
    sections.push({ children: collectionLinks(entry.children), node });
  }
  return sections;
}

/**
 * Видимый список каталога подборок ОДНИМ массивом — в порядке показа.
 *
 * Из него собирается `ItemList`, и другого источника у него нет: разметка обязана
 * соответствовать видимому содержимому, а видимое содержимое здесь — вложенный
 * список, то есть узлы верхнего уровня и их дети в порядке вывода.
 */
export function catalogSectionItems(
  sections: readonly CatalogSection[],
): readonly ListItemFacts[] {
  const items: ListItemFacts[] = [];
  for (const section of sections) {
    items.push(section.node);
    items.push(...section.children);
  }
  return items;
}

/**
 * Убирает из списка ссылки на указанные адреса — и повторы внутри самого списка.
 *
 * Зачем это нужно, найдено живой проверкой на собранном сервере: связь `related`
 * заполняет редактор, и он может (законно) указать в ней РОДИТЕЛЯ узла или его
 * РЕБЁНКА. Тогда в блоке «Смотрите также» оказывались две одинаковые ссылки на
 * один адрес — ссылка вверх (или вниз, из «Разделов подборки») и она же вбок. Для
 * посетителя это два элемента навигации, между которыми нечего выбирать, а для
 * краулера — повторная ссылка, ничего не добавляющая; ровно по этой причине
 * повтор пути запрещён и в крошках (`../seo/breadcrumbs.ts`). Убирается и
 * собственный адрес страницы: ссылка туда, где посетитель уже находится.
 */
function withoutPaths(
  links: readonly ListItemFacts[],
  excluded: readonly string[],
): readonly ListItemFacts[] {
  const seen = new Set<string>(excluded);
  const kept: ListItemFacts[] = [];
  for (const link of links) {
    if (seen.has(link.path)) {
      continue;
    }
    seen.add(link.path);
    kept.push(link);
  }
  return kept;
}

/** Ссылки на узлы: заголовок плюс сохранённый путь. Узел без пути выпадает. */
export function collectionLinks(
  nodes: readonly (Collection | null)[],
): readonly ListItemFacts[] {
  const links: ListItemFacts[] = [];
  for (const node of nodes) {
    if (node === null) {
      continue;
    }
    const path = filled(node.path);
    if (path === null) {
      continue;
    }
    links.push({ name: recordHeading(node), path });
  }
  return links;
}
