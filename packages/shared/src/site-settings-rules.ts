/**
 * Настройки сайта: ЧИСТЫЕ правила «выводить или промолчать» (задача Э3-00).
 *
 * ПОЧЕМУ МОДУЛЬ ЖИВЁТ В `packages/shared`. Он не знает ни про Payload, ни про
 * сгенерированные типы, и его зовут два приложения: `apps/cms` (определения
 * полей, валидация) и `apps/web` (шаблоны, JSON-LD, sitemap). Пока файл лежал в
 * `apps/cms` и экспортировался отдельной записью `exports`, инвариант «ни одного
 * импорта из `payload`» держался только комментарием: первый же импорт ЗНАЧЕНИЯ
 * из `payload` сломал бы сборку `apps/web`, и узнали бы об этом по факту. Здесь
 * такой импорт невозможен структурно — `payload` не значится в зависимостях
 * пакета. Из `apps/cms` в `apps/web` экспортируется только `./types`
 * (сгенерированные типы Payload, дублировать которые нельзя).
 *
 * Четыре решения человека формулируют
 * одно и то же требование с разных сторон, и все четыре обязаны иметь ОДНУ
 * трактовку на весь монорепозиторий:
 *
 *   - **Ч-17** — данные `Organization` для JSON-LD главной. При незаполненных
 *     полях блок не выводится ВОВСЕ, а не выводится с фиктивными значениями;
 *   - **Ч-10** — лицензионные поля карточки (`creator` вместе с ВИДОМ
 *     правообладателя, `creditText`, `copyrightNotice`, `license`,
 *     `acquireLicensePage`) плюс указание на генерацию ИИ, которое выводится
 *     подписью на карточке. Вид правообладателя появился по вердикту ревизии
 *     Э3-05/Э3-06: диапазон свойства `creator` в schema.org — `Person |
 *     Organization`, и строка без типа для потребителя разметки равна
 *     отсутствию свойства;
 *   - **Ч-19 + Ч-23** — тексты `/o-proekte`, `/usloviya`, `/kontakty`. Страница
 *     получает `index,follow`, self-canonical и место в sitemap ТОЛЬКО при
 *     конъюнкции двух условий: человек ЯВНО включил выключатель
 *     {@link INFO_PAGE_INDEXING_FIELD} И страница наполнена реальным текстом.
 *     Пока хоть одно не выполнено — `noindex` и вне sitemap. Признак
 *     «наполнена» обязан читаться из данных, поэтому он здесь функцией, а не
 *     догадкой шаблона;
 *   - **Ч-11** — рекламные места. Место резервируется по размерам из настроек
 *     (CLS < 0,1), поэтому блок без размеров не выводится: нулевой контейнер
 *     даёт ровно тот сдвиг макета, от которого резервирование и страхует;
 *   - **Ч-36** — сторонние счётчики (Яндекс.Метрика и подобное). Код вставляет
 *     человек, и до явного включения выключателя страница не печатает ничего:
 *     счётчик передаёт данные посетителей третьей стороне, и включаться сам он
 *     не должен.
 *
 * ПОЧЕМУ ЭТО ФУНКЦИИ, А НЕ ПРАВИЛА В ШАБЛОНЕ. Условие Ч-23 решает, попадёт ли
 * страница в индекс и в sitemap. Две трактовки условия — в CMS и в шаблоне —
 * рано или поздно разойдутся, и расхождение проявится не ошибкой сборки, а
 * страницей-заглушкой в индексе. Поэтому `apps/web` обязан звать
 * {@link isInfoPageIndexable}, а не проверять «текст вроде бы есть».
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Сборки абсолютных URL: `logo`, `license` и
 * `acquireLicensePage` хранятся путями от корня, хост подставляет единственный
 * хелпер из `SITE_URL` (`packages/shared`). Сборки самой разметки JSON-LD: здесь
 * только ОТБОР заполненных значений, а `@context`/`@type` и порядок ключей —
 * дело шаблона.
 */
import { canonicalizePath, looksLikeAbsoluteUrl } from './routes.js';

/** Слаг глобала. Он же адрес REST (`/api/globals/site-settings`) и имя в GraphQL. */
export const SITE_SETTINGS_SLUG = 'site-settings';

/* ------------------------------------------------------------------ */
/* Общее: что считается заполненным                                   */
/* ------------------------------------------------------------------ */

/**
 * Заполненное текстовое значение.
 *
 * Строка из пробелов — это ПУСТО. Иначе поле, в которое редактор случайно
 * поставил пробел, открывало бы блок разметки или индексацию страницы: ровно то
 * молчаливое «почти заполнено», от которого страхуют решения Ч-10 и Ч-17.
 */
function filledText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/* ------------------------------------------------------------------ */
/* Ч-17: Organization                                                 */
/* ------------------------------------------------------------------ */

/**
 * Минимальный контракт данных организации.
 *
 * Намеренно шире сгенерированного типа глобала: те же предикаты вызывает
 * `apps/web`, получая данные из REST-ответа, где форма гарантирована не типом, а
 * договорённостью. Соответствие сгенерированному типу проверяется в
 * `site-settings.ts` функциями-читателями.
 */
export interface OrganizationFacts {
  readonly name?: string | null;
  readonly legalName?: string | null;
  readonly logo?: string | null;
  readonly email?: string | null;
  readonly telephone?: string | null;
  readonly sameAs?: readonly ({ readonly url?: string | null } | null)[] | null;
}

/**
 * Поля, без которых блок `Organization` не выводится.
 *
 * `name` — идентичность организации: без него блока нет по определению. `logo` —
 * единственное свойство, которое поисковые системы ждут от разметки организации
 * помимо имени, и именно оно делает блок полезным; разметка из одного имени
 * дублирует видимый заголовок сайта и не добавляет ничего.
 *
 * Остальные поля (`legalName`, `email`, `telephone`, `sameAs`) необязательны и
 * попадают в разметку ПООДИНОЧКЕ, по факту заполнения: пустое свойство в JSON-LD
 * — это и есть фиктивное значение, запрещённое п. 23 ТЗ.
 */
export const ORGANIZATION_JSON_LD_REQUIRED = ['name', 'logo'] as const;

export type OrganizationRequiredField = (typeof ORGANIZATION_JSON_LD_REQUIRED)[number];

/** Отобранные заполненные данные организации. Сборка разметки — за шаблоном. */
export interface OrganizationJsonLd {
  readonly name: string;
  readonly logo: string;
  readonly legalName?: string;
  readonly email?: string;
  readonly telephone?: string;
  readonly sameAs?: readonly string[];
}

/** Каких обязательных полей не хватает, чтобы вывести блок. Порядок — как в наборе. */
export function organizationJsonLdGaps(
  organization: OrganizationFacts | null | undefined,
): readonly OrganizationRequiredField[] {
  return ORGANIZATION_JSON_LD_REQUIRED.filter(
    (field) => filledText(organization?.[field]) === null,
  );
}

/** Выводится ли блок `Organization` (Ч-17). */
export function isOrganizationJsonLdRendered(
  organization: OrganizationFacts | null | undefined,
): boolean {
  return organizationJsonLdGaps(organization).length === 0;
}

/**
 * Данные для блока `Organization` или `null`, если выводить нечего.
 *
 * Возвращать `null` вместо частично заполненного объекта — часть правила: тогда
 * шаблон физически не может отрендерить блок с пустыми свойствами, даже если
 * забудет спросить предикат.
 */
export function organizationJsonLd(
  organization: OrganizationFacts | null | undefined,
): OrganizationJsonLd | null {
  const name = filledText(organization?.name);
  const logo = filledText(organization?.logo);
  if (name === null || logo === null) {
    return null;
  }

  const sameAs = (organization?.sameAs ?? [])
    .map((entry) => filledText(entry?.url))
    .filter((url): url is string => url !== null);

  const legalName = filledText(organization?.legalName);
  const email = filledText(organization?.email);
  const telephone = filledText(organization?.telephone);

  return {
    logo,
    name,
    ...(legalName === null ? {} : { legalName }),
    ...(email === null ? {} : { email }),
    ...(telephone === null ? {} : { telephone }),
    ...(sameAs.length === 0 ? {} : { sameAs }),
  };
}

/* ------------------------------------------------------------------ */
/* Ч-17: имя сайта — одно на видимую подпись и на разметку             */
/* ------------------------------------------------------------------ */

/** Откуда взято имя сайта. Нужен потребителю разметки, см. {@link resolveSiteName}. */
export type SiteNameSource = 'organization' | 'visible-heading';

export interface SiteName {
  /** Готовое имя: обрезанное по краям, непустое. */
  readonly value: string;
  readonly source: SiteNameSource;
}

/**
 * Имя сайта: заполненное `organization.name` из глобала, иначе — видимое
 * название, переданное аргументом.
 *
 * ЗАЧЕМ ЭТО ФУНКЦИЯ, А НЕ КОНСТАНТА В ШАБЛОНЕ. `WebSite.name` на главной до
 * этого правила брался ТОЛЬКО из кода (видимый H1), а `Organization.name` —
 * из глобала. Пока глобал пуст, имя в разметке одно; как только человек заполнит
 * поле, в одном документе разметки окажутся два разных имени одного сайта, и
 * решение человека в `WebSite.name` не попадёт вовсе (находка ревизии Э3-13).
 * Одно значение с одним источником снимает и то, и другое.
 *
 * ПОЧЕМУ ГЛОБАЛ ПЕРЕВЕШИВАЕТ КОД. Так описано само поле в админке: «название
 * проекта так, как оно видно на сайте… не „красивое“ имя, а то же самое».
 * Значение по этому контракту — и есть видимое название сайта, а «красивое»
 * юридическое имя живёт отдельным полем `legalName`.
 *
 * ПОЧЕМУ НЕ ЗАВИСИТ ОТ ЛОГОТИПА. Ч-17 закрывает БЛОК `Organization` без
 * логотипа (без него разметка организации бесполезна), но имя сайта к логотипу
 * отношения не имеет: заполненное имя остаётся именем и при отсутствующем блоке.
 *
 * ОБЯЗАННОСТЬ ПОТРЕБИТЕЛЯ. Разметка обязана соответствовать видимому
 * содержимому (п. 23 ТЗ), поэтому `source === 'organization'` означает, что это
 * же значение обязано быть НАПЕЧАТАНО на странице (подпись сайта в шапке или
 * подвале). Пока такой подписи нет, единственное видимое название сайта — H1
 * главной, и он же обязан приходить сюда аргументом.
 *
 * @param visibleHeading видимое название сайта — то, что напечатано на странице.
 * @throws Error если видимое название пусто: пустое `WebSite.name` в разметке
 *   хуже отсутствующего свойства, а молчаливая подстановка выдумала бы бренд.
 */
export function resolveSiteName(
  organization: OrganizationFacts | null | undefined,
  visibleHeading: string,
): SiteName {
  const fromGlobal = filledText(organization?.name);
  if (fromGlobal !== null) {
    return { source: 'organization', value: fromGlobal };
  }

  const visible = filledText(visibleHeading);
  if (visible === null) {
    throw new Error(
      'resolveSiteName: видимое название сайта пусто, а имя глобала не заполнено. ' +
        'Имя сайта не выдумывается: вызывающий обязан передать то, что напечатано на ' +
        'странице (H1 главной), либо человек заполняет organization.name в настройках.',
    );
  }
  return { source: 'visible-heading', value: visible };
}

/* ------------------------------------------------------------------ */
/* Ч-10: лицензия изображений                                         */
/* ------------------------------------------------------------------ */

/**
 * Вид правообладателя для свойства `creator`.
 *
 * ЗАЧЕМ ОТДЕЛЬНОЕ ПОЛЕ, А НЕ ОДНА СТРОКА. Диапазон свойства `creator` в
 * schema.org — `Person | Organization`, то есть УЗЕЛ с собственным типом.
 * Значение типа Text потребитель разметки игнорирует: свойство фактически
 * отсутствует, хотя код считает его выведенным (находка ревизии Э3-05/Э3-06).
 * Догадаться о виде по строке нельзя — «Проект «Открытки»» это организация, а
 * «Иван Петров» человек, и различие тут юридическое, а не стилистическое.
 * Поэтому вид выбирает человек, а пока не выбрал — узла нет вовсе, как и у
 * остальных незаполненных значений (Ч-10).
 */
export const IMAGE_CREATOR_KINDS = ['Organization', 'Person'] as const;

export type ImageCreatorKind = (typeof IMAGE_CREATOR_KINDS)[number];

export function isImageCreatorKind(value: unknown): value is ImageCreatorKind {
  return typeof value === 'string' && (IMAGE_CREATOR_KINDS as readonly string[]).includes(value);
}

/** Подписи видов правообладателя для админки. */
export const IMAGE_CREATOR_KIND_LABELS: Readonly<Record<ImageCreatorKind, string>> = {
  Organization: 'Организация',
  Person: 'Человек',
};

/** Узел `creator` разметки: тип и имя. Сборку JSON-LD делает шаблон. */
export interface ImageCreatorJsonLd {
  readonly kind: ImageCreatorKind;
  readonly name: string;
}

/** Минимальный контракт лицензионных данных (см. {@link OrganizationFacts}). */
export interface ImageLicenseFacts {
  readonly creator?: string | null;
  /** Вид правообладателя: `Organization` или `Person` (см. {@link IMAGE_CREATOR_KINDS}). */
  readonly creatorKind?: string | null;
  readonly creditText?: string | null;
  readonly copyrightNotice?: string | null;
  readonly license?: string | null;
  readonly acquireLicensePage?: string | null;
  readonly aiDisclosure?: string | null;
}

/**
 * Свойства `ImageObject`, которые CLAUDE.md перечисляет для карточки, и которые
 * Ч-10 требует держать редактируемыми полями, а не хардкодом.
 *
 * Набор проверяется ЦЕЛИКОМ: частично заполненная лицензия хуже отсутствующей —
 * она выглядит юридически значимой, не будучи ею, а правится потом сразу на всём
 * массиве опубликованных карточек (цена поздней смены по Ч-10 — «дорого»).
 */
export const IMAGE_LICENSE_REQUIRED = [
  'creator',
  'creditText',
  'copyrightNotice',
  'license',
  'acquireLicensePage',
] as const;

export type ImageLicenseField = (typeof IMAGE_LICENSE_REQUIRED)[number];

export type ImageLicenseJsonLd = Readonly<Record<ImageLicenseField, string>>;

/** Каких лицензионных полей не хватает. Порядок — как в наборе. */
export function imageLicenseGaps(
  license: ImageLicenseFacts | null | undefined,
): readonly ImageLicenseField[] {
  return IMAGE_LICENSE_REQUIRED.filter((field) => filledText(license?.[field]) === null);
}

/**
 * Проверка поля «вид правообладателя»: заполненное имя без вида недопустимо.
 *
 * ПОЧЕМУ ЗАПРЕТ СТОИТ НА ВВОДЕ, А НЕ В СБОРКЕ РАЗМЕТКИ. Диапазон свойства
 * `creator` в schema.org — `Person | Organization`, то есть узел со своим типом;
 * значение типа Text потребитель игнорирует, и свойство фактически
 * отсутствует, хотя выглядит выведенным. Второй раз то же условие проверять в
 * шаблоне не нужно: если имя без вида НЕВОЗМОЖНО сохранить, шаблону не приходится
 * решать, что делать с половиной данных. Обратное направление (вид выбран, имя
 * пусто) отказом не является: это просто незаполненное поле, и узел не
 * выводится — как любое пустое значение по Ч-10.
 */
export function validateImageCreatorKind(
  value: unknown,
  siblingData: { readonly creator?: unknown } | null | undefined,
): string | true {
  const kind = filledText(value);
  if (kind !== null && !isImageCreatorKind(kind)) {
    return (
      `«${kind}» не входит в набор видов правообладателя ` +
      `(${IMAGE_CREATOR_KINDS.join(' / ')}). Набор закрыт диапазоном свойства creator в ` +
      'schema.org: другой тип узла потребитель разметки не поймёт.'
    );
  }
  if (kind === null && filledText(siblingData?.creator) !== null) {
    return (
      'Имя правообладателя заполнено, а вид не выбран. Свойство creator в schema.org — это ' +
      `узел типа ${IMAGE_CREATOR_KINDS.join(' или ')}, и строку без типа потребитель ` +
      'разметки игнорирует: свойство выглядело бы выведенным, фактически отсутствуя. ' +
      'Выберите вид либо очистите имя.'
    );
  }
  return true;
}

/**
 * Узел `creator` либо `null`.
 *
 * `null` — когда имя пусто ИЛИ вид правообладателя не выбран человеком. Вторая
 * половина условия и есть смысл правки: строку без типа потребитель разметки
 * игнорирует, то есть свойство считалось бы выведенным, не будучи им. Пустое
 * место лучше — оно видно.
 */
export function imageCreatorJsonLd(
  license: ImageLicenseFacts | null | undefined,
): ImageCreatorJsonLd | null {
  const name = filledText(license?.creator);
  const kind = filledText(license?.creatorKind);
  if (name === null || !isImageCreatorKind(kind)) {
    return null;
  }
  return { kind, name };
}

/** Заполнен ли лицензионный блок целиком (Ч-10). */
export function isImageLicenseComplete(license: ImageLicenseFacts | null | undefined): boolean {
  return imageLicenseGaps(license).length === 0;
}

/** Лицензионные свойства `ImageObject` или `null`, если набор неполон. */
export function imageLicenseJsonLd(
  license: ImageLicenseFacts | null | undefined,
): ImageLicenseJsonLd | null {
  const values: Partial<Record<ImageLicenseField, string>> = {};
  for (const field of IMAGE_LICENSE_REQUIRED) {
    const value = filledText(license?.[field]);
    if (value === null) {
      return null;
    }
    values[field] = value;
  }
  return values as ImageLicenseJsonLd;
}

/**
 * Указание на генерацию изображений нейросетью (Ч-10).
 *
 * Отдельно от JSON-LD НАМЕРЕННО: по Ч-10 формулировка живёт в «Условиях
 * использования» и выводится ПОДПИСЬЮ на карточке, то есть это видимый текст, а
 * не свойство разметки. Свойства `ImageObject` с таким смыслом в schema.org нет,
 * и придумывать его нельзя — разметка обязана соответствовать видимому
 * содержимому.
 */
export function aiDisclosureText(license: ImageLicenseFacts | null | undefined): string | null {
  return filledText(license?.aiDisclosure);
}

/* ------------------------------------------------------------------ */
/* Ч-19 + Ч-23: служебные информационные страницы                     */
/* ------------------------------------------------------------------ */

/** Ключи трёх служебных страниц. Набор закрыт: это именованное исключение Ч-23. */
export const INFO_PAGE_KEYS = ['about', 'terms', 'contacts'] as const;

export type InfoPageKey = (typeof INFO_PAGE_KEYS)[number];

/**
 * Пути служебных страниц.
 *
 * Каждый путь уже занят в реестре зарезервированных маршрутов
 * (`packages/shared`) как «занят целиком»: это статические маршруты Astro, а не
 * записи CMS. Совпадение реестра и этой таблицы проверяется тестом — расхождение
 * обязано падать сборкой, а не жить как страница без маршрута.
 */
export const INFO_PAGE_PATHS: Readonly<Record<InfoPageKey, string>> = {
  about: '/o-proekte',
  terms: '/usloviya',
  contacts: '/kontakty',
};

export const INFO_PAGE_LABELS: Readonly<Record<InfoPageKey, string>> = {
  about: 'О проекте (/o-proekte)',
  terms: 'Условия использования (/usloviya)',
  contacts: 'Контакты (/kontakty)',
};

/**
 * Имя поля-выключателя «открыть страницу в index,follow».
 *
 * Константа, а не литерал в двух местах: имя обязано совпасть у поля глобала
 * (`apps/cms`) и у предиката, который его читает. Расхождение не сломало бы
 * сборку — предикат увидел бы `undefined` и честно сказал «не индексировать», то
 * есть выключатель перестал бы работать МОЛЧА.
 */
export const INFO_PAGE_INDEXING_FIELD = 'allowIndexing';

/**
 * Сколько символов текста считается «наполнена реальным текстом» (Ч-23).
 *
 * ПАРАМЕТР, А НЕ НОРМА И НЕ РЕШЕНИЕ ОБ ИНДЕКСАЦИИ. Точного числа человек не
 * утверждал; вопрос внесён в `docs/otkrytye-voprosy.md` (раздел 7) со статусом
 * «открыт». После введения выключателя {@link INFO_PAGE_INDEXING_FIELD} порог
 * перестал решать, попадёт ли страница в индекс: решение принимает человек, а
 * порог остался СТРАХОВКОЙ от «TODO» в теле — без него слово-заглушка на
 * странице с включённым выключателем ушла бы в индекс, а п. 5.1 запрещает
 * отдавать слабую страницу как полноценную. 400 символов — несколько связных
 * предложений, то есть нижняя граница осмысленной информационной страницы.
 */
export const INFO_PAGE_MIN_TEXT_LENGTH = 400;

/** Минимальный контракт содержимого служебной страницы. */
export interface InfoPageFacts {
  readonly title?: string | null;
  readonly h1?: string | null;
  readonly metaDescription?: string | null;
  /** Лексический документ richText. Форма проверяется в рантайме, а не типом. */
  readonly body?: unknown;
  /**
   * Явное решение человека открыть страницу в `index,follow` (п. 7.1 ТЗ).
   *
   * Отдельно от наполненности НАМЕРЕННО: заполненный текст — это работа
   * редактора, а индексация — решение, и выводить второе из первого значит
   * отдать переключение `index/noindex` коду.
   */
  readonly [INFO_PAGE_INDEXING_FIELD]?: boolean | null;
}

/** Чего не хватает НАПОЛНЕНИЮ страницы. Решение человека сюда не входит. */
export const INFO_PAGE_REQUIRED = ['title', 'metaDescription', 'body'] as const;

export type InfoPageRequirement = (typeof INFO_PAGE_REQUIRED)[number];

export interface InfoPageIndexation {
  /**
   * Выключатель включён: человек решил открыть страницу в индекс.
   *
   * Отдельным полем, а не строкой в {@link gaps}: «человек не решал» и «редактор
   * не дописал текст» — разные состояния, и админке с шаблоном полезно их
   * различать. Слить их в один список — значит однажды получить `gaps: []` как
   * достаточное условие индексации.
   */
  readonly approved: boolean;
  readonly gaps: readonly InfoPageRequirement[];
  readonly indexable: boolean;
  readonly textLength: number;
}

function collectRichText(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectRichText(item, out);
    }
    return;
  }
  const record = readRecord(node);
  if (record === null) {
    return;
  }
  if (typeof record.text === 'string') {
    out.push(record.text);
  }
  collectRichText(record.children, out);
}

/**
 * Простой текст лексического документа.
 *
 * Нужен ровно для одного вопроса — «сколько здесь реального текста» — поэтому
 * форматирование, ссылки и структура отбрасываются, а пробелы схлопываются.
 * Восстановить документ из результата нельзя, и не требуется.
 */
export function richTextPlainText(value: unknown): string {
  const record = readRecord(value);
  if (record === null) {
    return '';
  }
  const out: string[] = [];
  collectRichText(record.root ?? record, out);
  return out.join(' ').replace(/\s+/gu, ' ').trim();
}

/**
 * Готова ли служебная страница к индексации (Ч-23) и что мешает.
 *
 * КОНЪЮНКЦИЯ ДВУХ РАЗНОРОДНЫХ УСЛОВИЙ, и это главное в функции:
 *   1. `approved` — человек ЯВНО включил выключатель. Признаётся только `true`:
 *      строка `'true'`, единица и прочее «похожее на да» согласием не считаются,
 *      иначе значение из REST-ответа или из формы решало бы за человека;
 *   2. `gaps` — наполнение. Заголовок и description обязательны, потому что они
 *      уникальны у каждой индексируемой страницы (чек-лист приёмки п. 22), а
 *      `h1` — нет: пустой H1 совпадает с title, это правило контентных
 *      коллекций проекта, и вторая трактовка здесь означала бы разные
 *      требования к одинаковым по смыслу полям.
 *
 * ПОЧЕМУ НЕДОСТАТОЧНО «ПИСАТЬ МОЖЕТ ТОЛЬКО ADMIN». Прежняя версия выводила право
 * на индексацию из длины текста и опиралась ровно на этот довод. Он неверен:
 * под `admin` пишет не только человек в админке, но и скрипт, миграция, смоук и
 * будущая обёртка MCP — то есть заполнение поля открывало страницу в индекс
 * БЕЗ решения об индексации. П. 7.1 и п. 23 ТЗ требуют, чтобы переключение
 * `index/noindex` было отдельным осознанным действием, поэтому оно и стало
 * отдельным полем с закрывающим дефолтом `false`.
 */
export function infoPageIndexation(page: InfoPageFacts | null | undefined): InfoPageIndexation {
  const approved = page?.[INFO_PAGE_INDEXING_FIELD] === true;
  const textLength = richTextPlainText(page?.body).length;
  const gaps = INFO_PAGE_REQUIRED.filter((requirement) => {
    if (requirement === 'body') {
      return textLength < INFO_PAGE_MIN_TEXT_LENGTH;
    }
    return filledText(page?.[requirement]) === null;
  });

  return { approved, gaps, indexable: approved && gaps.length === 0, textLength };
}

/** Право страницы на `index,follow` по Ч-23: решение человека И реальный текст. */
export function isInfoPageIndexable(page: InfoPageFacts | null | undefined): boolean {
  return infoPageIndexation(page).indexable;
}

/* ------------------------------------------------------------------ */
/* Ч-11: рекламные места                                              */
/* ------------------------------------------------------------------ */

/**
 * Два ряда рекламных блоков (Ч-11): под H1 (над сеткой) и после пагинации.
 *
 * Набор закрыт: позиция определяет, где шаблон резервирует место, и произвольное
 * значение означало бы блок, который шаблон не выведет нигде.
 */
export const AD_SLOT_POSITIONS = ['under-h1', 'after-pagination'] as const;

export type AdSlotPosition = (typeof AD_SLOT_POSITIONS)[number];

export const AD_SLOT_POSITION_LABELS: Readonly<Record<AdSlotPosition, string>> = {
  'under-h1': 'Под H1, над сеткой открыток',
  'after-pagination': 'После пагинации',
};

/** Блоков в ряду — три (Ч-11: «два ряда по три блока»). */
export const MAX_AD_SLOTS_PER_POSITION = 3;

/** Минимальный контракт рекламного места. */
export interface AdSlotFacts {
  readonly position?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly enabled?: boolean | null;
}

/** Место, под которое шаблон обязан зарезервировать ровно эти размеры. */
export interface RenderableAdSlot {
  readonly position: AdSlotPosition;
  readonly width: number;
  readonly height: number;
}

export function isAdSlotPosition(value: unknown): value is AdSlotPosition {
  return typeof value === 'string' && (AD_SLOT_POSITIONS as readonly string[]).includes(value);
}

function pixelSize(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Выводится ли рекламное место.
 *
 * Требуются ВСЕ четыре условия: включённость, известная позиция и оба размера
 * целыми пикселями. Блок без размеров не выводится — иначе шаблон зарезервировал
 * бы нулевое место, реклама подгрузилась бы в него и дала ровно тот сдвиг
 * макета, против которого резервирование и существует (CLS < 0,1, ТЗ §10).
 */
export function isAdSlotRenderable(slot: AdSlotFacts | null | undefined): boolean {
  return (
    slot?.enabled === true &&
    isAdSlotPosition(slot.position) &&
    pixelSize(slot.width) !== null &&
    pixelSize(slot.height) !== null
  );
}

/** Выводимые места одного ряда, в порядке, заданном редактором. */
export function renderableAdSlots(
  slots: readonly (AdSlotFacts | null)[] | null | undefined,
  position: AdSlotPosition,
): readonly RenderableAdSlot[] {
  const result: RenderableAdSlot[] = [];
  for (const slot of slots ?? []) {
    if (!isAdSlotRenderable(slot) || slot?.position !== position) {
      continue;
    }
    const width = pixelSize(slot?.width);
    const height = pixelSize(slot?.height);
    if (width === null || height === null) {
      continue;
    }
    result.push({ height, position, width });
  }
  return result;
}

/**
 * Проверяет состав рядов: не больше трёх блоков на позицию (Ч-11).
 *
 * Отказ, а не предупреждение: реклама не должна занимать первый экран целиком
 * (ТЗ §5.7), а четвёртый блок в ряду под H1 сдвигает контент ниже сгиба на всех
 * мобильных разрешениях сразу.
 */
export function validateAdSlotRows(slots: readonly unknown[] | null | undefined): string | true {
  const counts = new Map<string, number>();
  for (const slot of slots ?? []) {
    const position = readRecord(slot)?.position;
    if (typeof position !== 'string') {
      continue;
    }
    counts.set(position, (counts.get(position) ?? 0) + 1);
  }

  for (const [position, count] of counts) {
    if (count > MAX_AD_SLOTS_PER_POSITION) {
      return (
        `В ряду «${position}» ${count} блоков, а решением Ч-11 предусмотрено не больше ` +
        `${MAX_AD_SLOTS_PER_POSITION}. Лишний блок сдвигает контент ниже сгиба: первый ` +
        'экран не должен быть занят рекламой целиком (ТЗ §5.7).'
      );
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Ч-36: сторонние счётчики                                           */
/* ------------------------------------------------------------------ */

/**
 * Маркеры области, внутри которой шаблон печатает код счётчиков из админки.
 *
 * ЗАЧЕМ ОНИ ВООБЩЕ НУЖНЫ. Инвариант проекта — ноль клиентского JS по умолчанию,
 * и приёмка (`tests/seo/no-client-javascript.spec.ts`) падает на любом
 * исполняемом `<script>`. Код счётчика — произвольный HTML от человека, по
 * которому нельзя сказать заранее, как он выглядит, поэтому послабление приёмки
 * сделано не по содержимому скрипта, а по МЕСТУ: скрипт допустим ровно между
 * этими маркерами, любой другой по-прежнему валит приёмку. Общего послабления
 * «скрипты разрешены» не появляется.
 *
 * ПОЧЕМУ ЗНАЧЕНИЕ ЗАПРЕЩЕНО ВНУТРИ САМОГО КОДА (см. {@link
 * validateSiteCountersCode}). Код печатается как есть, то есть мог бы содержать
 * закрывающий маркер и оборвать область раньше времени — остальная его часть
 * оказалась бы ЗА маркерами, и приёмка сочла бы её обычным скриптом страницы.
 * Хуже другое направление: открывающий маркер в коде дал бы вторую область,
 * внутри которой скрипт разрешён, то есть послабление расширялось бы
 * содержимым поля.
 */
export const SITE_COUNTERS_MARKER_START = 'site-counters:start';
export const SITE_COUNTERS_MARKER_END = 'site-counters:end';

/** Минимальный контракт группы счётчиков (см. {@link OrganizationFacts}). */
export interface SiteCountersFacts {
  /**
   * Явное решение человека включить счётчики.
   *
   * Отдельно от заполненности кода НАМЕРЕННО, по той же причине, что
   * {@link INFO_PAGE_INDEXING_FIELD}: вставленный в поле код — это работа, а его
   * включение на живом сайте — решение. Выводить второе из первого значит
   * включать передачу данных посетителей третьей стороне фактом заполнения поля.
   */
  readonly enabled?: boolean | null;
  /** Произвольный HTML счётчиков. Печатается как есть — см. {@link siteCountersCode}. */
  readonly code?: string | null;
}

/**
 * Код счётчиков для вставки в страницу либо `null`, если вставлять нечего.
 *
 * `null` — когда выключатель не включён ЯВНО (`true`; строка `'true'`, единица и
 * прочее «похожее на да» согласием не считаются — иначе значение из REST-ответа
 * решало бы за человека) ИЛИ код пуст. Пустая строка и пробелы — это пусто: иначе
 * шаблон напечатал бы маркированную область без содержимого.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: экранирования и разбора. Содержимое — исполняемый код, который
 * человек вставил осознанно; «обезопасить» его подстановкой сущностей значило бы
 * сломать его молча. Гарантия тут не в фильтре, а в правах: писать в глобал может
 * только роль `admin` (`apps/cms/src/globals/site-settings.ts`).
 */
export function siteCountersCode(counters: SiteCountersFacts | null | undefined): string | null {
  if (counters?.enabled !== true) {
    return null;
  }
  return filledText(counters.code);
}

/**
 * Теги, которые в коде счётчика ломают проверяемые требования п. 22 ТЗ.
 *
 * Набор закрыт и перечисляет РОВНО то, что ломает требование, за которым стоит
 * тест, — а не «всё подозрительное». Довод тот же, которым обоснован отказ на
 * пикселе, и здесь он весомее: решение Ч-36 требует держать выключатель снятым
 * на стенде, поэтому живой код счётчика приёмкой не проверяется НИКОГДА и
 * приезжает сразу в прод (находка контролёра `seo-auditor`). Цена при этом —
 * не чей-то злой умысел, а опечатка при вставке чужого сниппета.
 *
 * Чего в наборе НЕТ намеренно: `<style>` и `<iframe>`. Ни одного проверяемого
 * требования они не ломают (инлайновый стиль приезжает до первой отрисовки,
 * рамка чужого домена — не изображение и не ссылка), поэтому запрет был бы
 * вкусовым, а описание поля в админке обещало бы отказ, которого нет.
 */
const COUNTERS_FORBIDDEN_TAGS: readonly (readonly [string, string])[] = [
  [
    'img',
    'у каждого изображения обязаны быть width, height и alt, и ровно одно изображение ' +
      'обходится без lazy-загрузки — пиксель счётчика валит обе проверки',
  ],
  [
    'noscript',
    'в счётчиках этот блок несёт тот самый пиксель-изображение без width/height/alt',
  ],
  [
    'base',
    'он переписывает КАЖДЫЙ относительный адрес страницы — ссылки, изображения, формы',
  ],
  ['link', 'так на странице появляется второй canonical, и он перебивает настоящий'],
  ['meta', 'так в страницу вписывается директива robots — например index,follow у пагинации'],
  ['title', 'у страницы станет два title, и какой из них возьмёт поисковик — лотерея'],
  ['h1', 'H1 на странице обязан быть ровно один'],
];

/**
 * Проверка поля с кодом счётчиков.
 *
 * Отклоняется ровно то, что ломает проверяемые требования проекта, а не «всё
 * подозрительное»:
 *
 *   - **теги из {@link COUNTERS_FORBIDDEN_TAGS}** — те, что ломают требование, за
 *     которым стоит тест приёмки: пиксель `<img>` в `<noscript>` (атрибуты
 *     изображений, п. 22), `<base>` (переписывает все относительные адреса),
 *     `<link>` (второй canonical), `<meta>` (чужая директива robots), `<title>`
 *     и `<h1>` (уникальность и единственность). Отказ стоит на вводе, потому что
 *     иначе он проявился бы красной приёмкой уже на проде, причём на коде,
 *     который человек считал вставленным верно;
 *   - **маркеры области** — см. {@link SITE_COUNTERS_MARKER_START};
 *   - **внешний `<script src>` без `async`/`defer`** (находка контролёра
 *     `perf-guard`). Синхронный тег в теле ответа сканер предзагрузки видит
 *     сразу и начинает соединение с чужим доменом параллельно первому экрану —
 *     `fetchpriority="high"` у LCP-изображения спасает порядок, но не полосу.
 *     Инлайнового скрипта правило не касается: штатный код счётчика создаёт тег
 *     со `src` сам, уже в рантайме, и для сканера его не существует;
 *   - **включённый выключатель при пустом коде.** Состояние «включено, но ничего
 *     не отправляется» выглядит как работающий счётчик и не является им.
 *
 * Пустое поле при выключенном выключателе — норма: это и есть «человек не
 * заполнил».
 *
 * ЧЕГО ПРОВЕРКА НЕ ЛОВИТ И НЕ ПЫТАЕТСЯ. Запись сессий («вебвизор», карта
 * кликов) включается в кабинете счётчика, а не в этом поле: кода, по которому её
 * видно, в разметке нет вовсе, поэтому отказать на вводе невозможно. Риск при
 * этом реальный — запись мутаций DOM даёт длинные задачи и бьёт по INP, — и
 * закрывается он предупреждением в админке, а не валидацией.
 */
export function validateSiteCountersCode(
  value: unknown,
  siblingData: { readonly enabled?: unknown; readonly code?: unknown } | null | undefined,
): string | true {
  // `value` — СЫРОЕ входное значение поля, `siblingData` — уже слитое с
  // сохранённым документом (payload 3.88: `deepMergeWithSourceArrays` в
  // `fields/hooks/beforeChange/promise.js`). Разница существенна: частичная
  // запись, не присылающая `counters.code`, даёт `value === undefined` при
  // заполненном поле в базе, и сверка одного `value` отклоняла бы её с
  // «выключатель включён, а код пуст». Такие записи в проекте есть — смоуки
  // правят одну группу глобала, не присылая остальные.
  const code = filledText(value === undefined ? siblingData?.code : value);

  if (code === null) {
    if (siblingData?.enabled === true) {
      return (
        'Выключатель счётчиков включён, а код пуст. Такое состояние выглядит как работающий ' +
        'счётчик, не будучи им: страница не отправит ни одного обращения. Вставьте код либо ' +
        'снимите выключатель.'
      );
    }
    return true;
  }

  for (const [tag, why] of COUNTERS_FORBIDDEN_TAGS) {
    if (new RegExp(`<${tag}\\b`, 'iu').test(code)) {
      return (
        `В коде есть <${tag}>, а такой тег ломает требование приёмки (п. 22 ТЗ): ${why}. ` +
        'Код счётчика печатается на КАЖДОЙ странице сайта, поэтому ошибка здесь ломает ' +
        'сразу весь сайт, а не одну запись. Уберите этот тег — работающий счётчик без него ' +
        'обходится: у Метрики это блок <noscript> с пикселем, нужный только посетителям с ' +
        'отключённым JS, которых скриптовый счётчик всё равно не учитывает.'
      );
    }
  }

  for (const tag of code.match(/<script\b[^>]*>/giu) ?? []) {
    if (!/\bsrc\s*=/iu.test(tag)) {
      continue;
    }
    if (!/\b(?:async|defer)\b/iu.test(tag)) {
      return (
        `Внешний скрипт «${tag.slice(0, 120)}» загружается синхронно: нет ни async, ни defer. ` +
        'Такой тег виден сканеру предзагрузки сразу и начинает соединение с чужим доменом ' +
        'параллельно загрузке первого экрана, то есть отбирает полосу у LCP-изображения ' +
        '(LCP ≤ 2,5 с, раздел «Производительность»). Допишите async. Штатный код счётчика ' +
        'этого ограничения обычно не касается вовсе: тег со src он создаёт сам в рантайме.'
      );
    }
  }

  for (const marker of [SITE_COUNTERS_MARKER_START, SITE_COUNTERS_MARKER_END]) {
    if (code.includes(marker)) {
      return (
        `В коде есть служебный маркер «${marker}». Этими маркерами шаблон обводит область, ` +
        'внутри которой приёмка разрешает исполняемый JS; маркер в самом коде сдвинул бы ' +
        'границу области, то есть расширил бы послабление содержимым поля. Уберите его.'
      );
    }
  }

  return true;
}

/* ------------------------------------------------------------------ */
/* Пути в полях глобала                                               */
/* ------------------------------------------------------------------ */

/**
 * Проверяет, что значение — путь от корня сайта, а не абсолютный адрес.
 *
 * Пусто — норма: это и есть состояние «человек не заполнил», из которого
 * предикаты выше делают вывод «не выводить». Абсолютный URL отклоняется, потому
 * что хост попадает в разметку только из `SITE_URL` через единственный хелпер:
 * вписанный руками домен разошёлся бы с ним при первом переезде, причём молча.
 */
export function validateSiteRootPath(value: unknown): string | true {
  const path = filledText(value);
  if (path === null) {
    return true;
  }
  if (typeof value !== 'string') {
    return 'Значение задаётся путём от корня сайта, например /usloviya.';
  }

  if (looksLikeAbsoluteUrl(path)) {
    return (
      `«${path}» — абсолютный адрес. Здесь ожидается путь от корня сайта: хост ` +
      'подставляет единственный хелпер из SITE_URL, и вписанный руками домен ' +
      'разошёлся бы с ним при первом же переезде.'
    );
  }

  try {
    canonicalizePath(path);
  } catch (error) {
    return `«${path}» не является путём: ${error instanceof Error ? error.message : String(error)}`;
  }
  return true;
}

/**
 * Проверяет ссылку на внешний профиль (`sameAs`).
 *
 * Здесь абсолютный адрес — единственная законная форма: профиль живёт на чужом
 * хосте, и правило «хост только из SITE_URL» к нему не относится. Поэтому
 * проверка отдельная, а не переиспользованная: одна функция для двух разных
 * правил означала бы, что послабление для профилей однажды распространится на
 * canonical.
 */
export function validateProfileUrl(value: unknown): string | true {
  const raw = filledText(value);
  if (raw === null) {
    return true;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return `«${raw}» не является адресом. Профиль указывается полным адресом, например https://vk.com/otkritka.`;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return `«${raw}» — адрес не той схемы. Профиль указывается по http или https.`;
  }
  return true;
}
