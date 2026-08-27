/**
 * Главная страница: тексты, разметка `WebSite` + `Organization`, окно показа
 * сезонного блока (задача Э3-09).
 *
 * Норма: ТЗ §5.2 («заголовок и вводный блок с уникальным текстом; блоки:
 * актуальные праздничные подборки (сезонность), популярные разделы, свежие
 * открытки; сезонные блоки управляются из админки — дата начала и окончания
 * показа; JSON-LD: `WebSite` + `Organization`»), решение Ч-17 (при
 * незаполненном глобале блок `Organization` не выводится ВОВСЕ), `CLAUDE.md` —
 * разделы «Рендеринг», «Структурированные данные», «Правила индексации»,
 * следствие Ч-04-5 (прямые ссылки с главной на праздничные узлы).
 *
 * Модуль ЧИСТЫЙ: без Astro, без Payload, без чтения `process.env`. Входит в
 * composite-проект `../../tsconfig.node.json`, проверяется юнит-тестом
 * `tests/unit/web-home-page.test.ts`. Чтение записей — `../data/home.ts`.
 *
 * ## Почему тексты главной живут в коде
 *
 * По той же причине, что тексты каталогов (`./catalog-pages.ts`): главная —
 * МАРШРУТ Astro, а не запись CMS. Путь `/` помечен контейнером в реестре
 * зарезервированных маршрутов, то есть записи с таким адресом не бывает, и
 * заголовок с вводным текстом обязаны где-то лежать. Код — единственное место,
 * где они проверяются тестом.
 *
 * Вводный блок написан под эту страницу и рассказывает, как устроен сайт: чем
 * подборка отличается от каталога, откуда берутся изображения и что с ними можно
 * делать. Заготовки с подстановкой слова здесь нет — это прямой запрет п. 23.4.
 *
 * ## Чего в этом модуле нет намеренно
 *
 *   - **`index,follow`.** Главная отдаёт `noindex,follow`: открыть страницу в
 *     индекс может только человек с ролью `admin` (п. 7.1 и п. 23 ТЗ), а
 *     константа здесь описывает то, что страница отдаёт СЕЙЧАС;
 *   - **статических ссылок на узлы таксономии.** Праздничные узлы — ДАННЫЕ:
 *     узел может быть не опубликован, и вписанная в код ссылка вела бы на 404.
 *     Ссылки печатаются из записей (`../data/home.ts`), поэтому на главной их
 *     ровно столько, сколько опубликовано;
 *   - **`ItemList` по блокам главной.** ТЗ §5.2 требует `WebSite` +
 *     `Organization`; списки на главной — это навигация, а не самостоятельный
 *     список товаров или статей. Разметку, которой ТЗ не просит, здесь не
 *     сочиняем;
 *   - **хлебных крошек.** Главная — их корень; звено «Главная» на самой главной
 *     было бы ссылкой на текущую страницу (ТЗ §7.6 такого звена не даёт).
 */

import { buildAbsoluteUrl, type OrganizationJsonLd, type SharedEnv } from '@otkritka/shared';

import { canonicalUrlFor } from '../routing/canonical.js';
import type { RobotsDirective } from '../routing/pagination.js';
import type { JsonLdDocument } from './json-ld.js';

/**
 * Канонический путь главной — корень сайта.
 *
 * Единственный адрес со слешем на всём сайте: правило Ч-21 («без завершающего
 * слеша») к корню неприменимо — пустого пути не существует. Корень при этом НЕ
 * редиректит, и это проверяется приёмкой.
 */
export const HOME_PATH = '/';

/**
 * Директива робота главной.
 *
 * `noindex,follow`, и это не перестраховка: условие 5.1.1 («подтверждённый
 * спрос») данными не подтверждено (решение Ч-04-1), а решение об `index,follow`
 * принимает человек. Правка этой константы агентом — нарушение границы
 * автоматизации (п. 7.1 и п. 23 ТЗ).
 */
export const HOME_ROBOTS: RobotsDirective = 'noindex,follow';

/** Подписи блока страницы: заголовок `<h2>` и подпись списка для скринридера. */
export interface HomeBlockFacts {
  readonly heading: string;
  readonly listLabel: string;
}

export interface HomeFacts {
  /** `<title>`. Отдельно от H1: у страницы это разные роли (ТЗ §8.1). */
  readonly title: string;
  /** Единственный H1 страницы. Он же `WebSite.name` в разметке. */
  readonly heading: string;
  /** `<meta name="description">`. */
  readonly description: string;
  /** Вводный блок: абзацы видимого текста, по одному на элемент. */
  readonly lead: readonly string[];
  /** Блок «актуальные праздничные подборки» (ТЗ §5.2). */
  readonly seasonal: HomeBlockFacts;
  /** Блок «популярные разделы» (ТЗ §5.2). */
  readonly sections: HomeBlockFacts;
  /** Блок «свежие открытки» (ТЗ §5.2). */
  readonly recent: HomeBlockFacts;
}

/**
 * Тексты главной. Написаны под эту страницу; ни одна строка не получена из
 * другой заменой слов.
 */
export const HOME_PAGE: HomeFacts = {
  description:
    'Поздравительные открытки к праздникам и для близких: подборки по поводам и адресатам, ' +
    'страница у каждой открытки, скачивание без регистрации.',
  heading: 'Поздравительные открытки',
  lead: [
    'Открытки на этом сайте разложены по поводам: сначала праздник или адресат, внутри — ' +
      'подборка, а в подборке уже сами открытки. Так проще найти нужную: не листать общий ' +
      'список, а сразу открыть тему, к которой готовитесь.',
    'У каждой открытки своя страница: там она видна целиком, там же подпись, описание и ' +
      'кнопка скачивания. Адрес этой страницы не меняется, поэтому ссылку можно сохранить ' +
      'или отправить — она продолжит работать.',
    'Изображения создаются нейросетью, и каждое перед публикацией смотрит редактор. Условия ' +
      'использования описаны отдельной страницей — она же указана в разметке каждой открытки.',
  ],
  recent: {
    heading: 'Новые открытки',
    listLabel: 'Недавно добавленные открытки',
  },
  seasonal: {
    heading: 'Подборки к ближайшим праздникам',
    listLabel: 'Сезонные подборки',
  },
  sections: {
    heading: 'Разделы сайта',
    listLabel: 'Разделы и подборки сайта',
  },
  title: 'Поздравительные открытки к праздникам — подборки по поводам и адресатам',
};

/**
 * Тождество узла организации внутри документа разметки.
 *
 * Фрагмент, а не отдельный адрес: страницы `/#organization` не существует, и `@id`
 * здесь — идентификатор УЗЛА, по которому на него ссылается `WebSite.publisher`.
 * Так на странице ровно одна сущность организации; вложенная копия внутри
 * `WebSite` дала бы две, и совпадение копий держалось бы на дисциплине.
 */
const ORGANIZATION_NODE_ID = '#organization';

export interface WebSiteJsonLd {
  readonly '@type': 'WebSite';
  /** Абсолютный адрес главной. Совпадает с её self-canonical символ в символ. */
  readonly url: string;
  readonly name: string;
  readonly description?: string;
  /** Ссылка на узел организации. Нет узла — нет и свойства. */
  readonly publisher?: { readonly '@id': string };
}

export interface OrganizationJsonLdNode {
  readonly '@type': 'Organization';
  readonly '@id': string;
  readonly name: string;
  /** Абсолютный адрес файла логотипа: в глобале он хранится путём от корня. */
  readonly logo: string;
  /** Абсолютный адрес сайта организации — та же главная. */
  readonly url: string;
  readonly legalName?: string;
  readonly email?: string;
  readonly telephone?: string;
  readonly sameAs?: readonly string[];
}

export interface HomePageJsonLd extends JsonLdDocument {
  /**
   * `WebSite` первым и всегда; `Organization` — вторым и только при заполненном
   * глобале (решение Ч-17).
   *
   * Тип кортежа с необязательным вторым элементом, а не два разных интерфейса:
   * потребителю (шаблон, тест, смоук) нужен один способ прочитать документ, а
   * состав графа — это факт о данных, а не о форме документа.
   */
  readonly '@graph': readonly [WebSiteJsonLd, OrganizationJsonLdNode?];
}

export interface HomePageJsonLdInput {
  /**
   * Отобранные данные организации из глобала либо `null` — блока не будет вовсе
   * (предикат `organizationJsonLd` из `@otkritka/shared`, решение Ч-17). Своей
   * трактовки «заполнено ли» у этого модуля нет: она одна на монорепозиторий.
   */
  readonly organization: OrganizationJsonLd | null;
}

/**
 * Разметка главной.
 *
 * @param env срез окружения — аргумент, а не чтение `process.env` внутри: тест
 *   обязан проверять несколько значений `SITE_URL` без мутации глобального
 *   окружения.
 * @throws Error если `SITE_URL` не задан или некорректен.
 */
export function homePageJsonLd(input: HomePageJsonLdInput, env?: SharedEnv): HomePageJsonLd {
  // Адрес главной собирает та же обёртка, которой layout печатает self-canonical:
  // два способа собрать один адрес расходятся, а `WebSite.url` обязан совпадать с
  // canonical символ в символ.
  const homeUrl = canonicalUrlFor(HOME_PATH, env);
  const organization = input.organization;

  const site: WebSiteJsonLd = {
    '@type': 'WebSite',
    url: homeUrl,
    // Имя сайта — его видимый H1. Выдумать «бренд» нельзя: разметка обязана
    // соответствовать видимому содержимому, а название проекта, которое человек
    // задал в глобале, попадает в разметку узлом Organization — там, где ему и
    // место.
    name: HOME_PAGE.heading,
    description: HOME_PAGE.description,
    ...(organization === null ? {} : { publisher: { '@id': ORGANIZATION_NODE_ID } }),
  };

  if (organization === null) {
    return { '@context': 'https://schema.org', '@graph': [site] };
  }

  const absolute = (path: string): string =>
    env === undefined ? buildAbsoluteUrl(path) : buildAbsoluteUrl(path, env);

  return {
    '@context': 'https://schema.org',
    '@graph': [
      site,
      {
        '@type': 'Organization',
        '@id': ORGANIZATION_NODE_ID,
        name: organization.name,
        // Путь логотипа хранится от корня сайта (валидация поля в CMS не
        // пускает абсолютный адрес), а в разметке адрес обязан быть абсолютным.
        logo: absolute(organization.logo),
        url: homeUrl,
        ...(organization.legalName === undefined ? {} : { legalName: organization.legalName }),
        ...(organization.email === undefined ? {} : { email: organization.email }),
        ...(organization.telephone === undefined ? {} : { telephone: organization.telephone }),
        ...(organization.sameAs === undefined ? {} : { sameAs: organization.sameAs }),
      },
    ],
  };
}

/** Границы показа сезонной подборки — поля `seasonal.*` записи. */
export interface SeasonalWindow {
  readonly showFrom?: string | null;
  readonly showUntil?: string | null;
}

/**
 * Накрывает ли окно показа указанный день (ТЗ §5.2).
 *
 * Требуются ОБЕ границы. Пустое поле означает «показывать не по календарю», и
 * догадываться за редактора нельзя: подставленная граница вывела бы подборку на
 * главную в день, которого человек не назначал. Ровно так же устроен и запрос
 * (`../data/queries.ts`, `seasonalCollectionsQuery`), где сравнение с NULL не
 * даёт истины; здесь то же правило записано выражением и проверяется тестом без
 * базы.
 *
 * Границы ВКЛЮЧИТЕЛЬНЫЕ: день начала и день окончания — дни показа. Перевёрнутое
 * окно (`showFrom` позже `showUntil`) окном не является: это опечатка редактора,
 * и молча «исправлять» её перестановкой значило бы показать подборку в интервал,
 * которого он не задавал.
 *
 * @param window поля записи; `null`/`undefined` — окна нет.
 * @param today день, на который строится блок. Аргумент, а не `new Date()`
 *   внутри: тест обязан задавать день сам, а главная рендерится на запросе.
 */
export function seasonalWindowContains(
  window: SeasonalWindow | null | undefined,
  today: Date,
): boolean {
  const from = parseDay(window?.showFrom);
  const until = parseDay(window?.showUntil);
  if (from === null || until === null || from > until) {
    return false;
  }
  const day = today.getTime();
  return from <= day && day <= until;
}

/** Момент из значения поля даты либо `null`: пусто, пробелы, мусор. */
function parseDay(value: string | null | undefined): number | null {
  const text = value?.trim() ?? '';
  if (text === '') {
    return null;
  }
  const time = new Date(text).getTime();
  return Number.isNaN(time) ? null : time;
}
