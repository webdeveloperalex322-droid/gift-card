/**
 * Отбор карточек категории, пригодных к открытию в `index,follow`.
 *
 * ## Зачем отдельный модуль, а не всё в скрипте
 *
 * Открытие в индекс — решение человека (п. 7.1 и п. 23 ТЗ), и единственное, чем
 * код может ему помочь, — это честно сказать, что произойдёт. Поэтому логика
 * отбора живёт здесь, под юнит-тестами, а CLI остаётся тонким: иначе правила,
 * по которым страница попадает в поиск, проверялись бы только глазами на
 * прогоне.
 *
 * ## Два разных вида находок, и почему их нельзя смешивать
 *
 * - **Жёсткие шлюзы** ({@link findHardGates}) — это НЕ вкусовые пороги. Почти все
 *   они факты о поведении системы: карточка либо не дойдёт до карты сайта, либо
 *   будет отвергнута хуком. Исключение одно и названо явно —
 *   `visual-duplicate-unresolved`: хук `assertVisualDuplicateResolved`
 *   на правку одного `robots` НЕ срабатывает (он выходит досрочно, когда статус
 *   не менялся), а отбор в карту сайта pHash не смотрит. Это правило проекта, а
 *   не защита платформы: открывать в индекс изображение, про которое редактор не
 *   вынес решения, нельзя, потому что проверить это больше нечем.
 * - **Поводы для решения человека** ({@link collectAttention}) — измеримые
 *   признаки слабой страницы. Числа в них выбраны для привлечения внимания и
 *   нормой проекта НЕ являются: решение «открывать или доводить» принимает
 *   человек, и код за него не решает.
 *
 * Смешать их значило бы либо пропустить в индекс страницу, которая туда
 * физически не попадёт, либо заблокировать решение человека выдуманным
 * порогом. Первое — ложный зелёный, второе — подмена роли.
 */
import { CONTENT_STATUSES, type ContentStatus } from '@otkritka/shared';

/** Факты об одной карточке, достаточные для отбора. Собираются вызывающим из Payload. */
export interface CategoryCardFacts {
  readonly id: number;
  readonly slug: string;
  readonly status: ContentStatus;
  readonly robots: string;
  readonly title: string;
  readonly metaDescription: string;
  readonly description: string;
  /** Переопределение canonical. Непустое значение выкидывает страницу из карты сайта. */
  readonly canonical: string;
  /** Привязано ли изображение: без него страница карточки отвечает 404. */
  readonly hasImage: boolean;
  /**
   * Есть ли производные в зеркале карточки. Страница отдаёт 200 не по факту
   * связи с изображением, а когда есть чем его показать, поэтому связь без
   * производных даёт то же 404.
   *
   * ОГРАНИЧЕНИЕ: признак говорит только о НАЛИЧИИ производных, но не о составе
   * форматов. Зеркало с производными, но без резервного JPEG даёт не 404, а
   * исключение в `pickFallbackVariant`, то есть 500 на странице, уже открытой в
   * индекс; из карты сайта такой адрес при этом выпадает, а директива остаётся
   * `index,follow`. Случай редкий (производные пишет один пайплайн, который
   * резервный формат делает всегда), и закрывать его здесь значило бы повторить
   * в этом пакете правила выбора варианта из `apps/web`. Если такая карточка
   * найдётся, её поймает шаг «дельта <loc> не сошлась».
   */
  readonly hasDerivatives: boolean;
  /** Расстояния Хэмминга до похожих из снимка хука (`visualDuplicate.similar`). */
  readonly similarDistances: readonly number[];
  /** Число конфликтов метатегов из снимка хука (`metaConflict`). */
  readonly metaConflicts: number;
  /**
   * Решение редактора о найденном сходстве (`visualDuplicate.decision`).
   * `unique` — «посмотрел, это разные открытки»; `duplicate` — «дубль, менять
   * изображение»; `null` — решения нет. Отличать обязательно: без решения
   * открывать нельзя, а с решением `unique` запрещать уже нечем — иначе
   * выдуманный порог блокировал бы решение человека.
   */
  readonly duplicateDecision: 'unique' | 'duplicate' | null;
  /**
   * Актуально ли решение редактора. Платформа считает решением только то, что
   * выдано ДЛЯ ТЕКУЩЕГО набора похожих (`decisionFor` против отпечатка
   * изображения и круга похожих): виза, выданная старой картинке, новую не
   * пропускает. Устаревшее «уникально» — это отсутствие решения, и шлюз обязан
   * читать его так же, иначе он мягче самой платформы.
   */
  readonly duplicateDecisionCurrent: boolean;
  /**
   * Был ли обход похожих обрезан пределом. Пустой список при обрезанном обходе
   * не гарантирует отсутствия дублей, и молчать об этом нельзя.
   */
  readonly duplicateScanTruncated: boolean;
}

export type HardGateCode =
  | 'not-published'
  | 'no-image'
  | 'canonical-override'
  | 'empty-meta-description'
  | 'meta-conflict'
  | 'visual-duplicate-unresolved';

export interface HardGate {
  readonly code: HardGateCode;
  /** Почему открывать нельзя — текст для человека, а не код ошибки. */
  readonly reason: string;
  readonly cards: readonly CategoryCardFacts[];
}

export type AttentionCode =
  | 'visual-duplicate-resolved'
  | 'duplicate-scan-truncated'
  | 'thin-description'
  | 'meta-description-length'
  | 'long-title'
  | 'shared-title-prefix';

export interface Attention {
  readonly code: AttentionCode;
  readonly reason: string;
  readonly cards: readonly CategoryCardFacts[];
}

/**
 * Границы, по которым текст попадает в поводы для решения.
 *
 * Числа выбраны агентом как отсечки внимания и решением человека НЕ являются.
 * Замер каталога на 2026-10-02: длина `description` 103–225 символов, медианы по
 * категориям 128–144. То есть `thinDescription = 120` — не «нижний край
 * возможного», а произвольная черта, ниже которой стоит посмотреть глазами.
 * Если человек захочет сделать её нормой, это отдельное решение в реестре.
 */
export interface AttentionThresholds {
  readonly thinDescription: number;
  readonly metaMin: number;
  readonly metaMax: number;
  readonly titleMax: number;
  /** Со скольких карточек общий зачин title считается поводом для правки. */
  readonly sharedPrefixFrom: number;
  /** Сколько первых слов title считать зачином. */
  readonly prefixWords: number;
}

export const DEFAULT_ATTENTION_THRESHOLDS: AttentionThresholds = {
  thinDescription: 120,
  metaMin: 120,
  metaMax: 160,
  titleMax: 60,
  sharedPrefixFrom: 5,
  prefixWords: 4,
};

/**
 * Жёсткие шлюзы: карточка либо не дойдёт до карты сайта, либо её отвергнет хук.
 *
 * Про снимки. `metaConflicts` и `similarDistances` заполняются хуками при
 * сохранении записи, поэтому это СНИМОК на момент последнего сохранения, а не
 * свежая проверка. Похожая открытка, пришедшая позже, в снимке ранней записи не
 * появится. Значит «шлюз не сработал» читается как «по снимкам чисто», а
 * авторитетна при применении свежая проверка в хуке — и отказ хука на
 * `--apply` при чистом отчёте штатен, а не удивителен.
 */
export function findHardGates(
  cards: readonly CategoryCardFacts[],
  phashThreshold: number,
): readonly HardGate[] {
  if (!Number.isFinite(phashThreshold)) {
    // Порог приходит из единственного машинного источника, который умеет падать
    // на мусоре. Если сюда всё же попал NaN, сравнения `distance <= NaN` были бы
    // ложными и шлюз дублей выключился бы МОЛЧА, напечатав «чисто».
    throw new Error(
      `Порог pHash должен быть числом, получено ${String(phashThreshold)}. ` +
        'Молчаливое отключение шлюза визуальных дублей недопустимо.',
    );
  }

  const gates: HardGate[] = [];
  const add = (code: HardGateCode, reason: string, picked: readonly CategoryCardFacts[]): void => {
    if (picked.length > 0) gates.push({ cards: picked, code, reason });
  };

  add(
    'not-published',
    'в индекс пускают только опубликованную запись: хук `index-requires-published` откажет',
    cards.filter((c) => c.status !== 'published'),
  );
  add(
    'no-image',
    'нечем показать открытку (нет связи с изображением или нет производных) — страница ' +
      'карточки отвечает 404, а в карту идут только 200',
    cards.filter((c) => !c.hasImage || !c.hasDerivatives),
  );
  add(
    'canonical-override',
    'переопределённый canonical выкидывает страницу из карты сайта (`not-self-canonical`), ' +
      'и она осталась бы индексируемой без self-canonical — прямое нарушение условия п. 5.1',
    cards.filter((c) => c.canonical.trim() !== ''),
  );
  add(
    'empty-meta-description',
    'пустой description: хук `index-requires-description` откажет в открытии',
    cards.filter((c) => c.metaDescription.trim() === ''),
  );
  add(
    'meta-conflict',
    'совпадение title или description по каталогу (снимок хука) — прямая каннибализация',
    cards.filter((c) => c.metaConflicts > 0),
  );
  add(
    'visual-duplicate-unresolved',
    `визуально похожее изображение на расстоянии ≤ ${String(phashThreshold)} (снимок хука), и ` +
      'решения редактора по нему нет: две почти одинаковые открытки на разных индексируемых URL ' +
      'склеиваются фильтром. Платформа тут не защищает — хук на правку robots не срабатывает, ' +
      'отбор в карту pHash не смотрит; решение выносит редактор в админке',
    cards.filter(
      (c) =>
        !(c.duplicateDecision === 'unique' && c.duplicateDecisionCurrent) &&
        c.similarDistances.some((d) => d <= phashThreshold),
    ),
  );

  return gates;
}

/** Поводы посмотреть глазами. Ничего не блокируют — решает человек. */
export function collectAttention(
  cards: readonly CategoryCardFacts[],
  thresholds: AttentionThresholds = DEFAULT_ATTENTION_THRESHOLDS,
): readonly Attention[] {
  const found: Attention[] = [];
  const add = (code: AttentionCode, reason: string, picked: readonly CategoryCardFacts[]): void => {
    if (picked.length > 0) found.push({ cards: picked, code, reason });
  };

  add(
    'visual-duplicate-resolved',
    'есть похожие изображения, но редактор вынес решение «уникально» — запрещать нечем; ' +
      'стоит знать, что в индекс уйдут близкие сюжеты',
    cards.filter(
      (c) =>
        c.duplicateDecision === 'unique' &&
        c.duplicateDecisionCurrent &&
        c.similarDistances.length > 0,
    ),
  );
  add(
    'duplicate-scan-truncated',
    'обход похожих был обрезан пределом: пустой или короткий список похожих ничего не ' +
      'гарантирует, и «по снимкам чисто» здесь особенно слабое утверждение',
    cards.filter((c) => c.duplicateScanTruncated),
  );
  add(
    'thin-description',
    `видимый текст короче ${String(thresholds.thinDescription)} символов — тонко для ` +
      'самостоятельной индексируемой страницы (отсечка внимания, не норма проекта)',
    cards.filter((c) => c.description.length < thresholds.thinDescription),
  );
  add(
    'meta-description-length',
    `длина description вне ${String(thresholds.metaMin)}–${String(thresholds.metaMax)} символов`,
    cards.filter(
      (c) =>
        c.metaDescription.length < thresholds.metaMin ||
        c.metaDescription.length > thresholds.metaMax,
    ),
  );
  add(
    'long-title',
    `title длиннее ${String(thresholds.titleMax)} символов — обрежется в выдаче`,
    cards.filter((c) => c.title.length > thresholds.titleMax),
  );

  for (const [prefix, picked] of groupByTitlePrefix(cards, thresholds.prefixWords)) {
    if (picked.length >= thresholds.sharedPrefixFrom) {
      add(
        'shared-title-prefix',
        `${String(picked.length)} карточек начинают title одинаково («${prefix}…») — ` +
          'в выдаче они выглядят одной страницей',
        picked,
      );
    }
  }

  return found;
}

/** Группировка по зачину title: так видно внутреннюю каннибализацию категории. */
export function groupByTitlePrefix(
  cards: readonly CategoryCardFacts[],
  words: number,
): Map<string, readonly CategoryCardFacts[]> {
  const groups = new Map<string, CategoryCardFacts[]>();
  for (const card of cards) {
    const prefix = card.title.trim().split(/\s+/).slice(0, words).join(' ').toLowerCase();
    if (prefix === '') continue;
    const bucket = groups.get(prefix);
    if (bucket === undefined) groups.set(prefix, [card]);
    else bucket.push(card);
  }
  return groups;
}

/** Медиана длины видимого текста — одно число, по которому видно наполненность категории. */
export function medianDescriptionLength(cards: readonly CategoryCardFacts[]): number {
  if (cards.length === 0) return 0;
  const lengths = cards.map((c) => c.description.length).sort((a, b) => a - b);
  const middle = Math.floor(lengths.length / 2);
  return lengths.length % 2 === 1
    ? (lengths[middle] ?? 0)
    : Math.round((((lengths[middle - 1] ?? 0) + (lengths[middle] ?? 0)) / 2));
}

/**
 * Сколько страниц обход приёмки увидит ПОСЛЕ открытия.
 *
 * Предел (`CRAWL_MAX_REQUESTS` в `tests/seo/support/crawl.ts`) здесь намеренно
 * НЕ дублируется. Единственный авторитетный сигнал о том, что обход не дошёл до
 * конца, печатает сама приёмка — «обход ОБОРВАН пределом запросов»; зеркало
 * числа в продуктовом пакете разъехалось бы при первом же подъёме предела и
 * начало врать человеку в тот момент, когда он решает, открывать ли категорию.
 * Поэтому модуль считает страницы, а судит о пределе прогон.
 *
 * Это НИЖНЯЯ оценка: считаются индексируемые карточки и узлы плюс открываемые
 * сейчас. Пагинация списков, служебные страницы и переходы по фильтрам сюда НЕ
 * входят — обход ограничивает запросы от главной и увидит больше. Доводить
 * оценку до точной значило бы повторить в этом пакете и размер страницы списка
 * (`DEFAULT_CARDS_PER_PAGE` живёт в `apps/web`), и предикат индексируемости
 * служебных страниц (Ч-23 пускает их только с реальным текстом) — то есть
 * завести ещё два зеркала, которые разъедутся. Точный ответ даёт прогон.
 */
export function countCrawlPagesAfter(input: {
  readonly indexableCards: number;
  readonly indexableNodes: number;
  readonly opening: number;
}): number {
  return input.indexableCards + input.indexableNodes + input.opening;
}

/**
 * Разбор явного списка slug'ов в карточки категории.
 *
 * Применение идёт ТОЛЬКО по явному списку, а не по пересчитанному фильтру: между
 * отчётом и применением состав категории мог измениться, и тогда человек
 * подтверждал бы одно множество, а открылось бы другое — это и есть запрещённая
 * «публикация по фильтру из кода». По slug, а не по id: id локальной базы и
 * прода не обязаны совпадать, а slug после первой публикации неизменяем и
 * одинаков на обоих стендах.
 */
export function resolveRequestedSlugs(
  cards: readonly CategoryCardFacts[],
  slugs: readonly string[],
): { readonly picked: readonly CategoryCardFacts[]; readonly missing: readonly string[] } {
  const bySlug = new Map(cards.map((c) => [c.slug, c]));
  const picked: CategoryCardFacts[] = [];
  const missing: string[] = [];
  for (const slug of slugs) {
    const card = bySlug.get(slug);
    if (card === undefined) missing.push(slug);
    else picked.push(card);
  }
  return { missing, picked };
}

/**
 * Набор статусов для отчёта — из общего контракта, а не списком в скрипте: иначе
 * при добавлении статуса в модель отчёт молча перестал бы его показывать.
 */
export const REPORTED_STATUSES: readonly ContentStatus[] = CONTENT_STATUSES;
