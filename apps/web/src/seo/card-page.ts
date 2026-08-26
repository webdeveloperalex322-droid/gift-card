/**
 * Разметка страницы карточки: `WebPage` + `ImageObject` (задача Э3-05).
 *
 * Норма: ТЗ §5.4 («JSON-LD: `WebPage` + `ImageObject` (contentUrl, name,
 * description, creator, creditText, copyrightNotice, license,
 * acquireLicensePage) + `BreadcrumbList`»), `CLAUDE.md` — раздел
 * «Структурированные данные» («разметка соответствует видимому содержимому;
 * фиктивные отзывы, рейтинги и авторы запрещены») и решение Ч-10 (лицензионные
 * поля — редактируемые значения глобала; пустое поле означает, что блока нет).
 *
 * `BreadcrumbList` здесь НЕ собирается: его печатает компонент
 * `../components/Breadcrumbs.astro` из той же цепочки, которую показывает на
 * экране (обоснование — шапка `./breadcrumbs.ts`). Второй список в этом модуле
 * означал бы два источника одного значения.
 *
 * Модуль ЧИСТЫЙ: ни запросов, ни `process.env`, ни импортов Astro и Payload.
 * Поэтому он входит в composite-проект `../../tsconfig.node.json` и проверяется
 * юнит-тестом `tests/unit/web-card-page.test.ts`. Чтение записи и отбор
 * заполненных лицензионных полей — за слоем данных (`../data/page-data.ts`).
 *
 * ## Почему `@graph`, а не вложенный `ImageObject`
 *
 * Свойства лицензии (`license`, `acquireLicensePage`, `creditText`,
 * `copyrightNotice`, `creator`) поисковые системы читают у ОБЪЕКТА
 * ИЗОБРАЖЕНИЯ. Отдельный узел `ImageObject` с собственным `@id` (это же его
 * `contentUrl`) и ссылка на него из `WebPage.primaryImageOfPage` дают ровно одну
 * сущность изображения на странице: при вложении копией она появилась бы дважды
 * — во `primaryImageOfPage` и в `image` — и совпадение копий держалось бы только
 * на дисциплине.
 *
 * ## Чего в разметке нет намеренно
 *
 *   - **указания на генерацию ИИ отдельным свойством.** Свойства с таким смыслом
 *     в schema.org нет, а придумывать его нельзя. По решению Ч-10 указание
 *     выводится ВИДИМОЙ подписью на карточке (`aiDisclosureText` из
 *     `@otkritka/shared`); попасть в разметку оно может только через
 *     `creditText`/`copyrightNotice`, то есть словами, которые написал человек;
 *   - **`author`, `aggregateRating`, `review`.** Открытки генерирует нейросеть, у
 *     страницы нет ни автора-человека, ни отзывов; выдуманные — прямой запрет
 *     п. 23.10 ТЗ;
 *   - **`datePublished`/`dateModified`.** У страницы карточки видимой даты нет
 *     (в отличие от подборки, ТЗ §5.3), а дата в разметке без даты на экране —
 *     утверждение, которому нечего соответствовать.
 */

import { buildAbsoluteUrl, type ImageLicenseJsonLd, type SharedEnv } from '@otkritka/shared';

import { type ImageVariant, variantAbsoluteUrl } from '../images/card-image.js';
import { canonicalUrlFor } from '../routing/canonical.js';
import type { JsonLdDocument } from './json-ld.js';

/**
 * Факты об изображении карточки — ровно то, что видно на странице.
 *
 * `variant` — РЕЗЕРВНАЯ производная (самая широкая JPEG), та же, что стоит в
 * `<img src>`: `contentUrl` обязан указывать на файл, который страница
 * действительно показывает, а `width`/`height` — совпадать с его размерами.
 * Собирать `contentUrl` из другого варианта значило бы описывать в разметке
 * файл, которого на странице нет.
 */
export interface CardImageFacts {
  readonly variant: ImageVariant;
  /** Название изображения. Совпадает с видимым H1 карточки. */
  readonly name: string;
  /** Описание изображения: видимое описание открытки, а при пустом — её `alt`. */
  readonly description: string;
  /**
   * Видимая подпись или текст поздравления. Пусто — свойства `caption` нет.
   *
   * Тип с явным `| undefined`: при `exactOptionalPropertyTypes` поле записи,
   * которого может не быть вовсе, обязано быть выразимо здесь — иначе слой
   * данных вынужден был бы нормализовать его сам, то есть завести вторую
   * трактовку «заполнено ли». Трактовка одна, и она здесь.
   */
  readonly caption?: string | null | undefined;
}

export interface CardPageJsonLdInput {
  /** Канонический путь страницы карточки от корня сайта. */
  readonly canonicalPath: string;
  /** Видимый H1. */
  readonly heading: string;
  /** Значение `<meta name="description">`. Пусто — свойства `description` нет. */
  readonly description?: string | null | undefined;
  readonly image: CardImageFacts;
  /**
   * Лицензионные свойства из глобала: ВСЕ пять либо `null` (решение Ч-10,
   * предикат `imageLicenseJsonLd` из `@otkritka/shared`). Своей трактовки
   * «заполнено ли» у этого модуля нет — частично заполненная лицензия выглядит
   * юридически значимой, не будучи ею.
   */
  readonly license: ImageLicenseJsonLd | null;
}

export interface ImageObjectJsonLd {
  readonly '@type': 'ImageObject';
  /** Тождество узла. Это же адрес файла: у одного файла один узел. */
  readonly '@id': string;
  readonly contentUrl: string;
  readonly name: string;
  readonly description: string;
  /** Фактическая ширина файла из зеркала производных. */
  readonly width: number;
  readonly height: number;
  readonly caption?: string;
  readonly creator?: string;
  readonly creditText?: string;
  readonly copyrightNotice?: string;
  /** Абсолютный адрес страницы лицензии. */
  readonly license?: string;
  /** Абсолютный адрес страницы, где лицензию можно получить. */
  readonly acquireLicensePage?: string;
}

export interface WebPageJsonLd {
  readonly '@type': 'WebPage';
  readonly url: string;
  readonly name: string;
  readonly description?: string;
  readonly primaryImageOfPage: { readonly '@id': string };
}

export interface CardPageJsonLd extends JsonLdDocument {
  readonly '@graph': readonly [WebPageJsonLd, ImageObjectJsonLd];
}

/** Заполненное значение либо `undefined` — тогда свойства в разметке нет вовсе. */
function filled(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Требует непустое значение обязательного свойства.
 *
 * @throws Error если значение пусто. Пустая строка в `name` или `description`
 *   узла — это и есть фиктивное значение: разметка выглядит полной, а
 *   утверждение в ней пустое.
 */
function required(value: string, property: string): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error(
      `Свойство «${property}» разметки карточки пусто. Выводить его пустым нельзя: блок ` +
        'выглядел бы заполненным, ничего не утверждая. Заполните соответствующее поле ' +
        'записи — заголовок, описание или alt изображения.',
    );
  }
  return trimmed;
}

/**
 * Лицензионная часть `ImageObject` с абсолютными адресами страниц.
 *
 * Пути в глобале хранятся от корня сайта (правило: хост подставляет
 * единственный хелпер над `SITE_URL`), а в разметке адрес обязан быть
 * абсолютным. Поэтому склейка происходит здесь, ровно один раз, и только для
 * полного набора: неполного набора этот код не видит — предикат
 * `imageLicenseJsonLd` отдаёт либо все пять полей, либо `null`.
 */
function licenseProperties(
  license: ImageLicenseJsonLd,
  env?: SharedEnv,
): Pick<
  ImageObjectJsonLd,
  'acquireLicensePage' | 'copyrightNotice' | 'creator' | 'creditText' | 'license'
> {
  const absolute = (path: string): string =>
    env === undefined ? buildAbsoluteUrl(path) : buildAbsoluteUrl(path, env);

  return {
    acquireLicensePage: absolute(license.acquireLicensePage),
    copyrightNotice: license.copyrightNotice,
    creator: license.creator,
    creditText: license.creditText,
    license: absolute(license.license),
  };
}

/**
 * Разметка страницы карточки.
 *
 * @param env срез окружения — аргумент, а не чтение `process.env` внутри: тест
 *   обязан проверять несколько значений `SITE_URL` без мутации глобального
 *   окружения.
 * @throws Error если `SITE_URL` не задан или некорректен, если путь страницы
 *   задан абсолютным адресом либо если обязательное свойство пусто.
 */
export function cardPageJsonLd(input: CardPageJsonLdInput, env?: SharedEnv): CardPageJsonLd {
  // Адрес страницы собирает та же обёртка, которой BaseLayout печатает
  // self-canonical (`canonicalUrlFor`): `WebPage.url` обязан совпадать с
  // canonical символ в символ, а два способа собрать один адрес расходятся.
  const pageUrl = canonicalUrlFor(input.canonicalPath, env);
  const contentUrl = variantAbsoluteUrl(input.image.variant, env);

  const description = filled(input.description);
  const caption = filled(input.image.caption);

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        url: pageUrl,
        name: required(input.heading, 'WebPage.name'),
        ...(description === undefined ? {} : { description }),
        primaryImageOfPage: { '@id': contentUrl },
      },
      {
        '@type': 'ImageObject',
        '@id': contentUrl,
        contentUrl,
        name: required(input.image.name, 'ImageObject.name'),
        description: required(input.image.description, 'ImageObject.description'),
        width: input.image.variant.width,
        height: input.image.variant.height,
        ...(caption === undefined ? {} : { caption }),
        ...(input.license === null ? {} : licenseProperties(input.license, env)),
      },
    ],
  };
}
