/**
 * Настройки сайта: ЧИСТЫЕ правила «выводить или промолчать» (задача Э3-00).
 *
 * Модуль сознательно не знает ни про Payload, ни про сгенерированные типы: он
 * должен читаться и из `apps/cms` (определения полей, валидация), и из
 * `apps/web` (шаблоны, JSON-LD, sitemap). Четыре решения человека формулируют
 * одно и то же требование с разных сторон, и все четыре обязаны иметь ОДНУ
 * трактовку на весь монорепозиторий:
 *
 *   - **Ч-17** — данные `Organization` для JSON-LD главной. При незаполненных
 *     полях блок не выводится ВОВСЕ, а не выводится с фиктивными значениями;
 *   - **Ч-10** — лицензионные поля карточки (`creator`, `creditText`,
 *     `copyrightNotice`, `license`, `acquireLicensePage`) плюс указание на
 *     генерацию ИИ, которое выводится подписью на карточке;
 *   - **Ч-19 + Ч-23** — тексты `/o-proekte`, `/usloviya`, `/kontakty`. Страница
 *     получает `index,follow`, self-canonical и место в sitemap ТОЛЬКО если
 *     наполнена реальным текстом; пока стоит заглушка — `noindex` и вне sitemap.
 *     Признак «наполнена» обязан читаться из данных, поэтому он здесь функцией,
 *     а не догадкой шаблона;
 *   - **Ч-11** — рекламные места. Место резервируется по размерам из настроек
 *     (CLS < 0,1), поэтому блок без размеров не выводится: нулевой контейнер
 *     даёт ровно тот сдвиг макета, от которого резервирование и страхует.
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
import { canonicalizePath, looksLikeAbsoluteUrl } from '@otkritka/shared';

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
/* Ч-10: лицензия изображений                                         */
/* ------------------------------------------------------------------ */

/** Минимальный контракт лицензионных данных (см. {@link OrganizationFacts}). */
export interface ImageLicenseFacts {
  readonly creator?: string | null;
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
 * Сколько символов текста считается «наполнена реальным текстом» (Ч-23).
 *
 * ПАРАМЕТР, А НЕ НОРМА: точного числа человек не утверждал, Ч-23 говорит
 * «наполнены реальным текстом». Порог нужен потому, что без него слово «TODO» в
 * теле страницы открывало бы её в индекс — а п. 5.1 прямо запрещает отдавать
 * слабую страницу как полноценную. 400 символов — это несколько связных
 * предложений, то есть нижняя граница осмысленной информационной страницы;
 * значение подлежит подтверждению человеком (см. отчёт задачи).
 */
export const INFO_PAGE_MIN_TEXT_LENGTH = 400;

/** Минимальный контракт содержимого служебной страницы. */
export interface InfoPageFacts {
  readonly title?: string | null;
  readonly h1?: string | null;
  readonly metaDescription?: string | null;
  /** Лексический документ richText. Форма проверяется в рантайме, а не типом. */
  readonly body?: unknown;
}

/** Чего не хватает странице до права на индексацию. */
export const INFO_PAGE_REQUIRED = ['title', 'metaDescription', 'body'] as const;

export type InfoPageRequirement = (typeof INFO_PAGE_REQUIRED)[number];

export interface InfoPageIndexation {
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
 * Заголовок и description обязательны потому, что они уникальны у каждой
 * индексируемой страницы (чек-лист приёмки п. 22), а `h1` — нет: пустой H1
 * совпадает с title, это правило контентных коллекций проекта, и вторая
 * трактовка здесь означала бы разные требования к одинаковым по смыслу полям.
 *
 * Оговорка о границе автоматизации. Решение об `index,follow` остаётся за
 * человеком: писать в этот глобал может ТОЛЬКО роль `admin`, поэтому наполнение
 * страницы текстом и есть то самое решение человека. Ни код, ни хук, ни
 * сервисный аккаунт открыть страницу в индекс через эту функцию не могут —
 * `ai-editor` глобал не пишет вовсе.
 */
export function infoPageIndexation(page: InfoPageFacts | null | undefined): InfoPageIndexation {
  const textLength = richTextPlainText(page?.body).length;
  const gaps = INFO_PAGE_REQUIRED.filter((requirement) => {
    if (requirement === 'body') {
      return textLength < INFO_PAGE_MIN_TEXT_LENGTH;
    }
    return filledText(page?.[requirement]) === null;
  });

  return { gaps, indexable: gaps.length === 0, textLength };
}

/** Признак наполненности по Ч-23: `false` на заглушке, `true` на реальном тексте. */
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
