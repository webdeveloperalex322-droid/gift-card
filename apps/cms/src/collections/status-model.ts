/**
 * Статусная модель контента (задача Э1-08) и блокировка формы URL (задача
 * Э1-09): чистое ядро правил, без Payload и без базы.
 *
 * Почему отдельный модуль, а не тело хуков. Здесь записаны самые дорогие правила
 * проекта: кто вправе опубликовать страницу, когда она может получить
 * `index,follow` и при каких условиях меняется её URL. Правило, живущее внутри
 * хука, проверяется только поднятой базой; вынесенное в чистую функцию —
 * обычным юнит-тестом на каждый случай, включая негативные. А негативные здесь
 * главные: «публикует только человек» подтверждается не тем, что админ смог, а
 * тем, что не смог никто другой.
 *
 * ГЛАВНОЕ СЛЕДСТВИЕ УСТРОЙСТВА PAYLOAD (проверено по исходникам,
 * `payload/dist/fields/hooks/beforeValidate/promise.js`): отказ на уровне ПОЛЯ
 * молчаливый — при `access` со значением `false` поле удаляется из входных
 * данных, а следом на его место подставляется прежнее значение документа.
 * Запрос отдаёт 200, статус не изменился, ошибки нет. Защита при этом работает,
 * но внешний AI-редактор не получает внятного отказа и не может отличить
 * «применено» от «проигнорировано». Поэтому правила этого модуля вызываются
 * ДВАЖДЫ и из разных мест (см. `content-hooks.ts`):
 *
 *   1. {@link assertIncomingChangeAllowed} и {@link assertBulkChangeAllowed} — из
 *      `beforeOperation`, где данные ещё СЫРЫЕ (ни одно поле не срезано). Это
 *      единственная точка, где запрещённая попытка ещё видна, поэтому громкая
 *      ошибка возможна только здесь;
 *   2. {@link planStatusTransition} и {@link assertUrlShapeChangeAllowed} — из
 *      `beforeValidate` коллекции, где данные уже слиты с документом. Здесь
 *      проверяется то, что реально будет записано, включая случаи, до которых
 *      сырой слой не дотягивается (частичное обновление, пакетная операция).
 *
 * Чего в модуле НЕТ: обращений к базе (полнота полей приходит уже посчитанной),
 * записи истории (Э1-07, `seo-history-diff.ts`) и создания редиректов (решение
 * о судьбе URL здесь только ПЛАНИРУЕТСЯ, применяет его `content-hooks.ts`).
 */
import { CONTENT_STATUSES, type ContentStatus } from '@otkritka/shared';

import { type PublishableDoc, hasBeenPublished } from '../access/policies';
import { type RoledUser, isAdmin } from '../access/roles';
import { DEFAULT_ROBOTS, type RobotsDirective, isIndexableRobots, isRobotsDirective } from '../seo/robots';

export type ContentRuleCode =
  | 'bulk-requires-admin'
  | 'bulk-requires-explicit-selection'
  | 'bulk-too-large'
  | 'bulk-url-change'
  // Находка ревизии от 2026-08-22: снятие с публикации пакетом с ОДНИМ решением
  // о судьбе URL на всю выборку. См. `assertBulkChangeAllowed`.
  | 'bulk-withdrawal-forbidden'
  | 'create-not-draft'
  | 'forbidden-transition'
  | 'incomplete-for-review'
  | 'index-not-separate'
  | 'index-requires-admin'
  // Задача Э4: индексируемая директива при пустом description. Правило
  // «страница без описания не индексируется» живёт в шаблоне
  // (`apps/web/src/seo/robots-directive.ts`, причина `no-description`); здесь
  // отказ, потому что иначе решение человека записывается в поле и не
  // действует на сайте — см. `assertDescriptionForIndex`.
  | 'index-requires-description'
  | 'index-requires-published'
  | 'publish-requires-admin'
  // Две границы наполненности подборки. Правила живут в
  // `./collection-volume.ts` (там же порог и области подсчёта), а коды отказа —
  // здесь, потому что набор кодов один на все правила контента: внешний клиент
  // разбирает отказы по нему, а не по тексту сообщения.
  //
  // `empty-for-publish` — узел без опубликованного содержания не публикуется:
  // его публичная страница отдаёт 404, то есть ссылка на него была бы битой.
  // `thin-content-for-index` — открытие в index,follow при содержании ниже
  // порога п. 5.1. Это условие ИНДЕКСАЦИИ, а не публикации: опубликованная
  // страница с меньшим содержанием законна и остаётся noindex,follow.
  | 'empty-for-publish'
  | 'thin-content-for-index'
  | 'unknown-robots'
  | 'unknown-status'
  | 'unpublish-requires-admin'
  | 'unpublish-requires-decision'
  | 'url-change-requires-admin'
  | 'url-locked'
  // Условие C3: год в адресе ежегодного праздника (`CLAUDE.md`, «Правила URL»).
  // Тот же машинный код использует `collection-path.ts` для подборок: правило
  // одно, значит и код отказа для внешнего клиента один.
  | 'year-in-path'
  // Задача Э2-05: перевод в review при визуально похожем изображении. Правило
  // живёт в `../images/duplicates.ts` (там же круг поиска и порог), а код
  // отказа — здесь, потому что набор кодов один на все правила контента:
  // внешний клиент разбирает отказы по нему, а не по тексту сообщения.
  | 'visual-duplicate-unresolved'
  // Задача Э2-06: замена изображения у записи, которая уже публиковалась.
  | 'image-change-requires-admin';

/**
 * Отказ правила статусной модели. Отдельный класс с машинным признаком `rule`:
 * тест обязан проверять, что отказ произошёл по ТОЙ причине, иначе зелёный
 * негативный тест может держаться на опечатке в имени поля.
 */
export class ContentRuleError extends Error {
  readonly rule: ContentRuleCode;

  constructor(rule: ContentRuleCode, message: string) {
    super(message);
    this.name = 'ContentRuleError';
    this.rule = rule;
  }
}

function fail(rule: ContentRuleCode, message: string): never {
  throw new ContentRuleError(rule, message);
}

/**
 * Допустимые переходы. Матрица, а не набор условий в теле функции: сочетание,
 * которого здесь нет, невозможно ни через админку, ни через REST, ни через
 * GraphQL — и это видно глазами.
 *
 * Перескок `draft` → `published` отсутствует НАМЕРЕННО: валидация полноты
 * навешена на вход в `review`, и разрешённый перескок означал бы, что её можно
 * обойти, опубликовав черновик напрямую. Обратные переходы из `published` — это
 * снятие с публикации: только `admin` и только с решением о судьбе URL.
 */
export const ALLOWED_STATUS_TRANSITIONS: Record<ContentStatus, readonly ContentStatus[]> = {
  draft: ['review'],
  published: ['draft', 'review'],
  review: ['draft', 'published'],
};

export function isContentStatus(value: unknown): value is ContentStatus {
  return typeof value === 'string' && (CONTENT_STATUSES as readonly string[]).includes(value);
}

const STATUS_LIST = CONTENT_STATUSES.join(' → ');

/**
 * Статус НОВОЙ записи.
 *
 * Пустое значение — это `draft` (дефолт поля). Любой другой статус отклоняется у
 * ВСЕХ, включая `admin`: требование CLAUDE.md и ТЗ §8.2 — новая запись рождается
 * черновиком с `noindex` и вне sitemap. Создание сразу в `review` обошло бы
 * валидацию полноты, создание в `published` — решение человека о публикации.
 *
 * @throws ContentRuleError
 */
export function assertCreateStatus(value: unknown): ContentStatus {
  if (value === undefined || value === null) {
    return 'draft';
  }
  if (!isContentStatus(value)) {
    return fail(
      'unknown-status',
      `Статус «${describe(value)}» неизвестен. Допустимы только ${STATUS_LIST}. ` +
        'Неизвестное значение отклоняется, а не трактуется как «не published»: иначе ' +
        'опечатка прошла бы проверку и запись оказалась бы в неизвестном состоянии.',
    );
  }
  if (value !== 'draft') {
    return fail(
      'create-not-draft',
      `Новая запись создаётся только в статусе draft, а не «${value}». Это требование ` +
        'ТЗ §8.2 и п. 7.1 SEO ТЗ: путь до публикации обязан пройти через review, где ' +
        'проверяется полнота и дубли. Создайте черновик, затем переведите его дальше.',
    );
  }
  return 'draft';
}

/* ------------------------------------------------------------------ */
/* Полнота перед review (ТЗ §8.2, §8.3 п. 3)                          */
/* ------------------------------------------------------------------ */

export interface ReviewRequirement {
  /** Имя поля в коллекции. */
  readonly field: string;
  /** Человеческое название для текста отказа. */
  readonly label: string;
}

/**
 * Обязательные поля карточки перед `review` — дословно ТЗ §8.2.
 *
 * `image` был перечислен ещё до появления поля загрузки: требование к
 * отсутствующему полю пропускает {@link missingReviewFields}, поэтому до Э2-04
 * оно не блокировало переход. С появлением коллекции `card-images` и поля
 * `cards.image` (Э2-04) требование включилось САМО — ровно так, как обещал тест
 * «как только поле image появится в схеме, пустое значение закроет переход в
 * review». Механизм остаётся в силе для полей ТЗ §8.1, которых в схеме пока нет.
 *
 * `metaDescription` добавлен по вердикту ревизии Э3-05/Э3-06 и не является
 * оформлением. Публичный шаблон при пустом поле не выводит тег
 * `<meta name="description">` вовсе — и правильно, пустой тег хуже
 * отсутствующего. Но без требования полноты карточка без description законно
 * доходила до `published`, а приёмка п. 22 проверяет УНИКАЛЬНОСТЬ description на
 * выборке: страница без него упирала бы проверку в отсутствие значения, то есть
 * условие п. 5.1 «уникальные title/H1/description» не проверялось нигде.
 * У подборок то же требование стоит с самого начала.
 */
export const CARD_REVIEW_REQUIREMENTS: readonly ReviewRequirement[] = [
  { field: 'image', label: 'изображение' },
  { field: 'alt', label: 'alt изображения' },
  { field: 'title', label: 'заголовок (title)' },
  { field: 'metaDescription', label: 'meta description' },
  { field: 'collections', label: 'подборки, в которые входит открытка' },
  { field: 'caption', label: 'подпись или текст поздравления' },
];

/**
 * Обязательные поля подборки перед `review`.
 *
 * `related` в списке потому, что перелинковка — это не оформление: из неё
 * складывается требование «нет страниц-сирот» (каждая индексируемая страница
 * достижима за ≤ 4 перехода от главной). Подборка без смежных ссылок проходит
 * приёмку только случайно.
 */
export const COLLECTION_REVIEW_REQUIREMENTS: readonly ReviewRequirement[] = [
  { field: 'intro', label: 'вводный текст' },
  { field: 'metaDescription', label: 'meta description' },
  { field: 'related', label: 'смежные подборки (перелинковка)' },
  { field: 'responsibleEditor', label: 'ответственный редактор' },
];

/** Узлы lexical, которые сами по себе содержанием не являются. */
const EMPTY_RICH_TEXT_NODE_TYPES: ReadonlySet<string> = new Set([
  'linebreak',
  'paragraph',
  'root',
  'tab',
  'text',
]);

function hasRichTextContent(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some((child) => hasRichTextContent(child));
  }
  if (typeof node !== 'object' || node === null) {
    return false;
  }
  const record: Record<string, unknown> = { ...node };
  const text = record.text;
  if (typeof text === 'string' && text.trim() !== '') {
    return true;
  }
  const type = record.type;
  if (typeof type === 'string' && !EMPTY_RICH_TEXT_NODE_TYPES.has(type)) {
    // Изображение, разделитель, блок — содержание, даже если текста нет.
    return true;
  }
  return hasRichTextContent(record.children) || hasRichTextContent(record.root);
}

/**
 * Заполнено ли значение поля содержательно.
 *
 * `0` и `false` считаются заполненными: это значения, а не пустота. Пустой
 * richText (один абзац без текста) заполненным НЕ считается — иначе вводный
 * текст подборки можно было бы «заполнить» нажатием в редакторе, а уникальный
 * вводный текст входит в условия открытия страницы в индекс (п. 5.1).
 */
export function isFilledContentValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim() !== '';
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'object') {
    if (value instanceof Date) {
      return true;
    }
    return hasRichTextContent(value);
  }
  return true;
}

/**
 * Незаполненные обязательные поля. Возвращается ВЕСЬ список, а не первое
 * нарушение: редактор должен увидеть объём работы одним отказом, а не собирать
 * его по одному полю за сохранение.
 *
 * @param knownFields имена полей, которые в коллекции реально существуют
 */
export function missingReviewFields(args: {
  readonly data: Readonly<Record<string, unknown>>;
  readonly knownFields: ReadonlySet<string>;
  readonly requirements: readonly ReviewRequirement[];
}): readonly ReviewRequirement[] {
  return args.requirements.filter(
    (requirement) =>
      args.knownFields.has(requirement.field) && !isFilledContentValue(args.data[requirement.field]),
  );
}

/* ------------------------------------------------------------------ */
/* Снятие с публикации: решение о судьбе URL (ТЗ §8.2)                */
/* ------------------------------------------------------------------ */

/**
 * Что делать со СТАРЫМ URL при снятии страницы с публикации.
 *
 * Третьего варианта «ничего не решать» нет: URL уже был известен поисковику, и
 * молчаливое исчезновение страницы — это либо потерянный вес ссылки, либо мягкий
 * 404. Вариант `404` в наборе есть, но он тоже решение: запись в `redirects` не
 * создаётся сознательно.
 */
export const WITHDRAWAL_MODES = ['301', '404', '410'] as const;

export type WithdrawalMode = (typeof WITHDRAWAL_MODES)[number];

export interface WithdrawalDecision {
  readonly mode: WithdrawalMode;
  /** Путь замены. Непустой только для `301`. */
  readonly redirectTo: string | null;
}

function isWithdrawalMode(value: unknown): value is WithdrawalMode {
  return typeof value === 'string' && (WITHDRAWAL_MODES as readonly string[]).includes(value);
}

const WITHDRAWAL_HINT =
  'Выберите решение о судьбе URL: 301 с путём замены (страница переехала), 410 ' +
  '(удалено без замены — явная запись в redirects) или 404 (снято без записи). ' +
  'Требование ТЗ §8.2: снятие с публикации сопровождается предложением 301 или 404, ' +
  'потому что этот URL уже известен поисковику.';

function readWithdrawal(value: unknown): WithdrawalDecision {
  if (typeof value !== 'object' || value === null) {
    return fail('unpublish-requires-decision', `Решение о судьбе URL не задано. ${WITHDRAWAL_HINT}`);
  }
  const record: Record<string, unknown> = { ...value };
  const mode = record.mode;
  if (!isWithdrawalMode(mode)) {
    return fail(
      'unpublish-requires-decision',
      `Решение о судьбе URL «${describe(mode)}» не входит в набор ` +
        `(${WITHDRAWAL_MODES.join(' / ')}). ${WITHDRAWAL_HINT}`,
    );
  }
  const rawTarget = record.redirectTo;
  const target = typeof rawTarget === 'string' && rawTarget.trim() !== '' ? rawTarget.trim() : null;

  if (mode === '301' && target === null) {
    return fail(
      'unpublish-requires-decision',
      '301 без пути замены невозможен: это перенос на конкретный URL. Если замены нет, ' +
        'выберите 410 (удалено без замены) или 404.',
    );
  }
  if (mode !== '301' && target !== null) {
    return fail(
      'unpublish-requires-decision',
      `Решение «${mode}» означает «без замены», а путь замены «${target}» задан. ` +
        'Уберите путь или выберите 301.',
    );
  }

  return { mode, redirectTo: target };
}

/**
 * Читает решение о судьбе URL, ничего не требуя.
 *
 * Нужна отдельно от проверяющей версии: в `afterChange` решение уже прошло
 * валидацию на входе, и второй отказ там означал бы исключение ПОСЛЕ записи
 * документа — то есть откат транзакции по причине, о которой пользователь уже
 * получил бы ответ.
 */
export function readWithdrawalDecisionOrNull(value: unknown): WithdrawalDecision | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record: Record<string, unknown> = { ...value };
  if (!isWithdrawalMode(record.mode)) {
    return null;
  }
  const rawTarget = record.redirectTo;
  return {
    mode: record.mode,
    redirectTo: typeof rawTarget === 'string' && rawTarget.trim() !== '' ? rawTarget.trim() : null,
  };
}

/* ------------------------------------------------------------------ */
/* Переход статуса                                                     */
/* ------------------------------------------------------------------ */

export interface TransitionInput {
  /** Незаполненные обязательные поля; считает вызывающий по merged-данным. */
  readonly missingForReview: readonly ReviewRequirement[];
  readonly next: {
    readonly robots: unknown;
    readonly status: unknown;
    readonly withdrawal?: unknown;
  };
  readonly previous: {
    readonly publishedAt?: unknown;
    readonly robots: unknown;
    readonly status: unknown;
  };
  readonly user: RoledUser | null | undefined;
}

export interface TransitionPlan {
  /** Первая публикация в истории записи: только тогда ставится `publishedAt`. */
  readonly firstPublish: boolean;
  readonly previousStatus: ContentStatus;
  /** Директива, которую надо записать (возможно, принудительно понижённая). */
  readonly robots: RobotsDirective;
  /** Была ли директива понижена хуком: повод для предупреждения в журнал. */
  readonly robotsCoerced: boolean;
  readonly status: ContentStatus;
  /** Запись стала опубликованной именно этой операцией. */
  readonly turnedPublished: boolean;
  /** Решение о судьбе URL при снятии с публикации; `null` — снятия не было. */
  readonly withdrawn: WithdrawalDecision | null;
}

function readStatus(value: unknown, place: string): ContentStatus {
  if (!isContentStatus(value)) {
    return fail(
      'unknown-status',
      `Статус «${describe(value)}» (${place}) неизвестен. Допустимы только ${STATUS_LIST}.`,
    );
  }
  return value;
}

function readRobots(value: unknown, place: string): RobotsDirective {
  if (!isRobotsDirective(value)) {
    return fail(
      'unknown-robots',
      `Robots-директива «${describe(value)}» (${place}) не входит в закрытый набор. ` +
        'Набор закрытый потому, что он управляет индексацией: произвольное значение ' +
        'означало бы неизвестное поведение в поиске.',
    );
  }
  return value;
}

/**
 * Проверяет переход статуса и считает, что должно быть записано.
 *
 * Вызывается на КАЖДУЮ запись — в том числе на каждую запись пакетной операции
 * (решение Ч-07): пакет не отменяет ни одной проверки, он лишь избавляет
 * человека от повторения одного и того же решения руками.
 *
 * @throws ContentRuleError на любом запрещённом переходе.
 */
export function planStatusTransition(input: TransitionInput): TransitionPlan {
  const previousStatus = readStatus(input.previous.status, 'текущий');
  const status = readStatus(input.next.status, 'новый');
  const previousRobots = readRobots(input.previous.robots, 'текущая');
  const nextRobots = readRobots(input.next.robots, 'новая');

  const statusChanged = status !== previousStatus;

  if (statusChanged && !ALLOWED_STATUS_TRANSITIONS[previousStatus].includes(status)) {
    fail(
      'forbidden-transition',
      `Переход «${previousStatus}» → «${status}» не предусмотрен моделью ${STATUS_LIST}. ` +
        `Из «${previousStatus}» доступно: ${ALLOWED_STATUS_TRANSITIONS[previousStatus].join(' / ')}. ` +
        'Публикация идёт только через review — там проверяются полнота и дубли, и обойти ' +
        'её прямым переходом нельзя.',
    );
  }

  if (statusChanged && status === 'published' && !isAdmin(input.user)) {
    fail(
      'publish-requires-admin',
      'Публикует только человек с ролью admin (ТЗ §8.2, п. 7.1 и п. 23 SEO ТЗ). ' +
        'Публикация, инициированная кодом, хуком, воркером, расписанием или сервисным ' +
        'аккаунтом ai-editor, запрещена: агент доводит контент до review, решение об ' +
        'открытии страницы принимает человек.',
    );
  }

  if (statusChanged && previousStatus === 'published' && !isAdmin(input.user)) {
    fail(
      'unpublish-requires-admin',
      'Снять страницу с публикации может только admin: её URL уже известен поисковику, ' +
        'и вместе со снятием принимается решение 301 или 404 (ТЗ §8.2).',
    );
  }

  if (statusChanged && (status === 'review' || status === 'published')) {
    if (input.missingForReview.length > 0) {
      const list = input.missingForReview.map((item) => item.label).join(', ');
      fail(
        'incomplete-for-review',
        `Запись не готова: не заполнено — ${list}. Валидация полноты стоит на входе в ` +
          'review (ТЗ §8.2): страница без изображения, alt, description, подписи или ' +
          'привязки к подборкам не должна доходить до проверки человеком, а тем более до ' +
          'индекса — уникальные title/H1/description входят в условия п. 5.1.',
      );
    }
  }

  const withdrawn =
    statusChanged && previousStatus === 'published' ? readWithdrawal(input.next.withdrawal) : null;

  // Индексация. Различаются два случая, и путать их нельзя: ПОПЫТКА открыть
  // индексацию (значение изменено этой операцией) и УНАСЛЕДОВАННОЕ значение
  // записи, которого никто не касался. Первая проверяется по правам и статусу,
  // второе при уходе из published просто понижается.
  let robots = nextRobots;
  let robotsCoerced = false;
  const robotsChanged = nextRobots !== previousRobots;

  if (isIndexableRobots(robots) && robotsChanged) {
    // Порядок проверок важен: сначала роль, потом статус, потом «отдельным
    // действием» — так отказ называет самую грубую причину.
    if (!isAdmin(input.user)) {
      fail(
        'index-requires-admin',
        'Открыть страницу в index,follow может только admin (ТЗ §9): это решение об ' +
          'индексации, а не оформление. Сервисный аккаунт ai-editor robots-директивы не ' +
          'трогает ни поштучно, ни пакетно.',
      );
    }
    if (status !== 'published') {
      fail(
        'index-requires-published',
        `index,follow допустим только для статуса published, а статус — «${status}». ` +
          'Черновик и запись на проверке обязаны оставаться noindex и вне sitemap.',
      );
    }
    if (statusChanged) {
      fail(
        'index-not-separate',
        'Открытие страницы в index,follow — ОТДЕЛЬНОЕ действие администратора, а не ' +
          'побочный эффект публикации (ТЗ §8.2). Опубликуйте запись, проверьте условия ' +
          'п. 5.1 SEO ТЗ (спрос, отдельный интент, объём, уникальные тексты, страница в ' +
          'навигации) и включите индексацию вторым сохранением.',
      );
    }
  } else if (status !== 'published' && isIndexableRobots(robots)) {
    // Понижение, а не отказ: запись уходит из published, и оставить ей
    // index,follow нельзя ни на одно сохранение. Отказ здесь заставил бы
    // администратора снимать индексацию отдельной операцией ДО снятия с
    // публикации, то есть держать страницу в индексе дольше необходимого.
    robots = DEFAULT_ROBOTS;
    robotsCoerced = true;
  }

  const alreadyPublished = hasBeenPublished({
    publishedAt: typeof input.previous.publishedAt === 'string' ? input.previous.publishedAt : null,
  });

  return {
    firstPublish: status === 'published' && !alreadyPublished,
    previousStatus,
    robots,
    robotsCoerced,
    status,
    turnedPublished: statusChanged && status === 'published',
    withdrawn,
  };
}

/* ------------------------------------------------------------------ */
/* Индексируемая директива требует непустого описания (задача Э4)      */
/* ------------------------------------------------------------------ */

/**
 * Индексируемая страница без непустого description не бывает.
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ. Ровно два факта: итоговая директива записи
 * индексируемая ({@link isIndexableRobots} из общего пакета — единственный
 * источник набора) и поле `metaDescription` пусто ({@link isFilledContentValue}
 * — та же трактовка слова «пусто», по которой считается полнота перед `review`).
 * Ни одного третьего условия здесь нет и быть не должно.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Правило «что именно закрывает страницу от индекса»
 * живёт в одном месте — `apps/web/src/seo/robots-directive.ts`, функция
 * `resolvePageRobots`, причина `no-description`. Список её причин (пагинация,
 * фильтр, статус, описание) сюда НЕ копируется: две копии закрывающих условий
 * разошлись бы молча, и CMS начала бы отказывать по правилу, которого у шаблона
 * уже нет, либо пропускать то, что шаблон закрывает. CMS знает только факт
 * «описание пусто» — он ей и так известен, это её собственное поле.
 *
 * ПОЧЕМУ ОТКАЗ, А НЕ ПРЕДУПРЕЖДЕНИЕ. Дефект, который правило закрывает, состоит
 * не в пустом поле, а в РАСХОЖДЕНИИ: администратор ставит `index,follow`,
 * сохраняет, видит в форме `index,follow` — и получает страницу, которая
 * отдаёт `noindex,follow` и не входит в sitemap. Предупреждение это расхождение
 * не убирает: в журнал сервера администратор не смотрит, а всплывающую подсказку
 * админки внешний AI-редактор через REST и GraphQL не получает вовсе. Отказ
 * убирает само состояние: запись, у которой поле обещает индексацию, а страница
 * её не даёт, перестаёт существовать. Тот же довод уже применён в
 * `./collection-volume.ts` (`empty-for-publish`, `thin-content-for-index`) и в
 * `../images/upload-hooks.ts` (`image-in-use`).
 *
 * ЧТО ОТКАЗ НЕ ЗАПРЕЩАЕТ. Промежуточное состояние «сначала директива, потом
 * описание» им не отменяется, потому что такого порядка в модели нет и без него:
 * `index,follow` доступен только записи в статусе `published`, а до `published`
 * запись доходит через `review`, где `metaDescription` — обязательное поле
 * (`CARD_REVIEW_REQUIREMENTS`, `COLLECTION_REVIEW_REQUIREMENTS`). То есть на
 * момент открытия индексации описание уже заполнено, и отказ срабатывает ровно
 * в двух случаях: описание очистили после публикации либо индексацию открывают
 * записи, у которой его очистили раньше. Выход из обоих — одно сохранение:
 * заполнить описание или оставить `noindex,follow`.
 *
 * Функция НИЧЕГО не решает об индексации: она не открывает, не закрывает и не
 * понижает директиву. Единственный её исход — исключение; решение остаётся за
 * человеком (п. 7.1, п. 23 ТЗ).
 *
 * @param robots ИТОГОВАЯ директива записи — та, что будет записана. Передавать
 *   входящее значение нельзя: уход из `published` понижает директиву тем же
 *   сохранением, и отказ на входящем значении держал бы страницу в индексе
 *   дольше необходимого.
 * @throws ContentRuleError с кодом `index-requires-description`
 */
export function assertDescriptionForIndex(input: {
  readonly metaDescription: unknown;
  /** Путь записи для текста отказа; `null` — путь ещё не собран. */
  readonly path: string | null;
  readonly robots: unknown;
}): void {
  if (!isIndexableRobots(input.robots)) {
    return;
  }
  if (isFilledContentValue(input.metaDescription)) {
    return;
  }

  fail(
    'index-requires-description',
    `Директива index,follow не применится: у ${
      input.path === null ? 'этой записи' : `страницы «${input.path}»`
    } пусто описание (meta description). Страница без непустого описания понижается ` +
      'до noindex,follow и не попадает в sitemap, поэтому решение об индексации осталось ' +
      'бы записанным в поле и недействующим на сайте — а узнать об этом можно было бы ' +
      'только по диагностике карты сайта. Заполните meta description или оставьте ' +
      'noindex,follow: сочинить описание за редактора нельзя — шаблонный SEO-текст с ' +
      'заменой пары слов запрещён п. 23 ТЗ, а уникальный description входит и в условия ' +
      'п. 5.1, и в чек-лист приёмки п. 22.',
  );
}

/* ------------------------------------------------------------------ */
/* Форма URL: slug, parent, nodeKind (задача Э1-09)                    */
/* ------------------------------------------------------------------ */

/**
 * Поля, из которых складывается URL записи.
 *
 * У карточки это только `slug` (`/otkrytki/<slug>`), у подборки — все три:
 * итоговый путь собирается из пути родителя и slug, а вид узла определяет,
 * какого родителя вообще можно выбрать. Три поля меняют ОДИН адрес, поэтому
 * правило у них общее — как и предикат доступа `urlShapeFieldAccess`.
 */
export const URL_SHAPE_FIELDS = ['slug', 'parent', 'nodeKind'] as const;

export type UrlShapeField = (typeof URL_SHAPE_FIELDS)[number];

export type UrlShape = Readonly<Partial<Record<UrlShapeField, unknown>>>;

/** Идентификатор связи в том виде, в каком её отдаёт Payload: id, строка или документ. */
export function readRelationId(value: unknown): string | null {
  if (typeof value === 'number' || typeof value === 'string') {
    return String(value);
  }
  if (typeof value === 'object' && value !== null && 'id' in value) {
    const { id } = value;
    if (typeof id === 'number' || typeof id === 'string') {
      return String(id);
    }
  }
  return null;
}

function normalizeShapeValue(field: UrlShapeField, value: unknown): string | null {
  if (field === 'parent') {
    return readRelationId(value);
  }
  if (typeof value === 'string') {
    return value.trim() === '' ? null : value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  // Значение неожиданного типа сравнивается по своему JSON-представлению: так
  // мусорный вход не выглядит «таким же, как раньше» и не проходит проверку
  // неизменности URL молча.
  return value === undefined || value === null ? null : (JSON.stringify(value) ?? null);
}

/**
 * Какие поля формы URL изменились. Поле, отсутствующее во входных данных,
 * изменением не считается: частичное обновление не переписывает URL.
 */
export function urlShapeChanges(previous: UrlShape, next: UrlShape): readonly UrlShapeField[] {
  return URL_SHAPE_FIELDS.filter((field) => {
    if (!(field in next)) {
      return false;
    }
    return normalizeShapeValue(field, next[field]) !== normalizeShapeValue(field, previous[field]);
  });
}

/**
 * Проверяет право изменить форму URL записи.
 *
 * До первой публикации URL меняется свободно (роль проверяет access control
 * полей). После первой публикации — только `admin` и только вместе с ЯВНЫМ
 * подтверждением, потому что то же сохранение создаёт одиночный 301. Критерий
 * «публиковалась» — `publishedAt`, а не текущий статус: иначе URL, известный
 * поисковику, менялся бы в два шага (`published` → `draft` → новый slug).
 *
 * @returns изменившиеся поля (пустой массив — URL не меняется)
 * @throws ContentRuleError
 */
export function assertUrlShapeChangeAllowed(input: {
  /** Явное подтверждение смены URL: одноразовый флаг операции, не свойство записи. */
  readonly confirmed: boolean;
  readonly next: UrlShape;
  readonly previous: UrlShape & PublishableDoc;
  readonly user: RoledUser | null | undefined;
}): readonly UrlShapeField[] {
  const changes = urlShapeChanges(input.previous, input.next);
  if (changes.length === 0) {
    return changes;
  }
  if (!hasBeenPublished(input.previous)) {
    return changes;
  }

  if (!isAdmin(input.user)) {
    fail(
      'url-change-requires-admin',
      `Поля, задающие URL (${changes.join(', ')}), у опубликованной записи меняет только ` +
        'admin: смена URL — это одна операция вместе с созданием одиночного 301 ' +
        '(ТЗ §7.5). Сервисному аккаунту ai-editor она недоступна.',
    );
  }

  if (!input.confirmed) {
    fail(
      'url-locked',
      `URL записи неизменяем после первой публикации, а изменены: ${changes.join(', ')}. ` +
        'Сменить URL можно только одной операцией «смена URL с 301»: подтвердите её в ' +
        'группе «Смена URL» того же сохранения — тогда в той же транзакции появится ' +
        'одиночный 301 со старого пути на новый. Без подтверждения правка отклонена: ' +
        'изменение существующего URL без 301 — критическая ошибка, и она необратима.',
    );
  }

  return changes;
}

/* ------------------------------------------------------------------ */
/* Сырые входные данные (beforeOperation)                              */
/* ------------------------------------------------------------------ */

/**
 * Проверяет СЫРЫЕ входные данные запроса до того, как Payload срежет поля по
 * access control.
 *
 * Смысл ровно один: дать громкий отказ. Молчаливое срезание поля защищает
 * данные, но оставляет внешнего клиента в уверенности, что операция применена, —
 * а значит, ошибка в интеграции AI-редактора обнаружится не здесь, а в поиске.
 *
 * Проверяются только те поля, которые ПРИСУТСТВУЮТ во входных данных: PATCH с
 * одним полем не должен получать отказ за значения, которых в нём нет.
 *
 * @throws ContentRuleError
 */
export function assertIncomingChangeAllowed(input: {
  readonly incoming: Readonly<Record<string, unknown>>;
  readonly operation: 'create' | 'update';
  readonly stored: (Readonly<Record<string, unknown>> & PublishableDoc) | null;
  readonly user: RoledUser | null | undefined;
}): void {
  const { incoming, operation, stored, user } = input;

  if ('robots' in incoming && isIndexableRobots(incoming.robots)) {
    if (!isAdmin(user)) {
      fail(
        'index-requires-admin',
        'Открыть страницу в index,follow может только admin (ТЗ §9). Сервисный аккаунт ' +
          'ai-editor robots-директивы не трогает.',
      );
    }
    const effectiveStatus = 'status' in incoming ? incoming.status : stored?.status;
    if (effectiveStatus !== 'published') {
      fail(
        'index-requires-published',
        `index,follow допустим только для статуса published (сейчас — ` +
          `«${describe(effectiveStatus)}»). Новая запись и черновик обязаны быть noindex ` +
          'и вне sitemap.',
      );
    }
    if ('status' in incoming && incoming.status !== stored?.status) {
      fail(
        'index-not-separate',
        'index,follow включается ОТДЕЛЬНЫМ действием, а не тем же запросом, что меняет ' +
          'статус (ТЗ §8.2). Опубликуйте запись, затем откройте индексацию вторым ' +
          'запросом.',
      );
    }
  }

  if (operation === 'create') {
    assertCreateStatus('status' in incoming ? incoming.status : undefined);
    return;
  }

  if (stored === null) {
    return;
  }

  if ('status' in incoming) {
    const next = incoming.status;
    if (next !== stored.status) {
      const nextStatus = readStatus(next, 'новый');
      const previousStatus = readStatus(stored.status, 'текущий');
      if (!ALLOWED_STATUS_TRANSITIONS[previousStatus].includes(nextStatus)) {
        fail(
          'forbidden-transition',
          `Переход «${previousStatus}» → «${nextStatus}» не предусмотрен моделью ` +
            `${STATUS_LIST}. Из «${previousStatus}» доступно: ` +
            `${ALLOWED_STATUS_TRANSITIONS[previousStatus].join(' / ')}.`,
        );
      }
      if (nextStatus === 'published' && !isAdmin(user)) {
        fail(
          'publish-requires-admin',
          'Публикует только человек с ролью admin (п. 7.1 SEO ТЗ). Запрос сервисного ' +
            'аккаунта отклонён целиком, а не выполнен частично: сервисный аккаунт обязан ' +
            'увидеть отказ, а не 200 с прежним статусом.',
        );
      }
      if (previousStatus === 'published' && !isAdmin(user)) {
        fail(
          'unpublish-requires-admin',
          'Снять страницу с публикации может только admin: вместе со снятием ' +
            'принимается решение 301 или 404 (ТЗ §8.2).',
        );
      }
    }
  }

  const confirmed = readUrlChangeConfirmation(incoming.urlChange);
  assertUrlShapeChangeAllowed({ confirmed, next: incoming, previous: stored, user });
}

/**
 * Читает одноразовое подтверждение смены URL из входных данных.
 *
 * Флаг сознательно живёт в данных операции, а не в состоянии записи: хук
 * сбрасывает его при каждом сохранении, поэтому «подтверждено однажды» не
 * означает «разрешено навсегда».
 */
export function readUrlChangeConfirmation(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record: Record<string, unknown> = { ...value };
  return record.confirm === true || record.confirm === 'true';
}

/* ------------------------------------------------------------------ */
/* Пакетная операция (решение Ч-07, точка вето V11)                    */
/* ------------------------------------------------------------------ */

/**
 * Предел размера пакета — **200 записей**.
 *
 * ПРОВЕНАНС ЗНАЧЕНИЯ: выбор агента, не решение человека (кандидат в реестр
 * решений вместе с `MAX_UPLOAD_BYTES`, пределом обхода при поиске визуальных
 * дублей и диапазоном года в slug). Норма, из которой значение выведено, задана
 * человеком: Ч-07 разрешает применять решение к «выборке, которую выбрал сам».
 *
 * Ограничение содержательное, а не технологическое: список в тысячи id — это уже
 * не выбор человека, а тот же фильтр из кода, только переписанный перечислением.
 * Величина согласована с админкой Payload: на странице списка выбирается не
 * больше сотни строк, поэтому предел не мешает штатной работе.
 */
export const MAX_BATCH_SELECTION = 200;

export interface BulkIntent {
  /** Явно выбранные записи; `null` — операция, для которой выборка не требуется. */
  readonly ids: readonly (number | string)[] | null;
  /**
   * `publish` — перевод в published; `index` — включение index,follow;
   * `status` — любая другая пакетная смена статуса (в том числе уход из
   * published); `other` — пакет, статуса и индексации не касающийся.
   */
  readonly kind: 'index' | 'other' | 'publish' | 'status';
}

function readIdClause(clause: unknown): readonly (number | string)[] | null {
  if (typeof clause !== 'object' || clause === null) {
    return null;
  }
  const keys = Object.keys(clause);
  if (keys.length !== 1 || keys[0] !== 'id') {
    return null;
  }
  const operators: Record<string, unknown> = { ...(clause as Record<string, unknown>) };
  const condition = operators.id;
  if (typeof condition !== 'object' || condition === null) {
    return null;
  }
  const conditionKeys = Object.keys(condition);
  if (conditionKeys.length !== 1) {
    return null;
  }
  const record: Record<string, unknown> = { ...(condition as Record<string, unknown>) };

  if (conditionKeys[0] === 'equals') {
    const value = record.equals;
    return typeof value === 'number' || typeof value === 'string' ? [value] : null;
  }
  if (conditionKeys[0] !== 'in') {
    return null;
  }
  const value = record.in;
  if (typeof value === 'string') {
    const parts = value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    return parts.length > 0 ? parts : null;
  }
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const ids = value.filter(
    (item): item is number | string => typeof item === 'number' || typeof item === 'string',
  );
  return ids.length === value.length ? ids : null;
}

/**
 * Является ли условие выборки ЯВНЫМ перечислением записей.
 *
 * Это машинный критерий «выборку выбрал человек» (решение Ч-07). Принимаются
 * ровно две формы:
 *
 *   1. одиночное условие `{ id: { in: [...] } }` или `{ id: { equals: x } }`;
 *   2. `and`-список, в котором ЕСТЬ такое условие.
 *
 * Вторая форма нужна не для гибкости, а потому что так строит запрос сама
 * админка Payload (`@payloadcms/ui`, `EditMany/DrawerContent`): выбранные строки
 * она отправляет как `{ and: [ … , { id: { in: [...] } } ] }`, добавляя туда же
 * активный фильтр или поиск списка. Отказывать в этой форме означало бы, что
 * штатная пакетная операция админки не работает, стоит редактору отфильтровать
 * список перед выбором строк.
 *
 * Безопасность формы 2 держится на том, что `and` — ПЕРЕСЕЧЕНИЕ: любое
 * дополнительное условие способно только сузить набор, никогда не расширить.
 * Поэтому затронутые записи гарантированно входят в перечисленные id. По той же
 * причине `or` на верхнем уровне не принимается: он расширяет набор.
 *
 * Всё остальное — `status: review`, `id: { not_equals: '' }` (так админка
 * передаёт «выбрать все доступные»), диапазон дат — это фильтр, то есть массовая
 * публикация по признаку, а она осталась запрещённой.
 */
export function readExplicitIdSelection(where: unknown): readonly (number | string)[] | null {
  const direct = readIdClause(where);
  if (direct !== null) {
    return direct;
  }
  if (typeof where !== 'object' || where === null) {
    return null;
  }
  const record: Record<string, unknown> = { ...where };
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== 'and' || !Array.isArray(record.and)) {
    return null;
  }
  const clauses: unknown[] = record.and;
  for (const clause of clauses) {
    const ids = readIdClause(clause);
    if (ids !== null) {
      return ids;
    }
  }
  return null;
}

/**
 * Есть ли во входных данных пакета СОДЕРЖАТЕЛЬНОЕ решение о судьбе URL.
 *
 * Пустая группа (`{ mode: null, redirectTo: null }`) решением не считается: так
 * форма админки присылает незаполненную группу при любой правке, и отказ на ней
 * означал бы, что штатная пакетная операция перестаёт работать. Значимо ровно
 * то, что редактор ввёл сам: режим или путь замены.
 */
function bulkCarriesWithdrawalDecision(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record: Record<string, unknown> = { ...value };
  const mode = record.mode;
  const target = record.redirectTo;
  return (
    (typeof mode === 'string' && mode.trim() !== '') ||
    (typeof target === 'string' && target.trim() !== '')
  );
}

/**
 * Проверяет пакетную операцию (Payload: обновление коллекции по `where`).
 *
 * Ослабление Ч-07 разрешило применять решение к выборке одной операцией, но
 * ровно в границах точки вето V11: только `admin`, только явная выборка,
 * `index,follow` — отдельным действием. Пакет НЕ отменяет ни одной проверки:
 * Payload прогоняет хуки на каждую запись по отдельности, поэтому валидация
 * полноты, запись `seo-history` и остальные правила срабатывают столько раз,
 * сколько записей в выборке.
 *
 * ЛЮБАЯ пакетная смена статуса требует ЯВНОЙ выборки и подчиняется пределу
 * {@link MAX_BATCH_SELECTION} — не только публикация. Это исправление
 * блокирующей находки ревизии от 2026-08-22: прежде гейт срабатывал лишь на
 * `status: published` и на индексируемой robots-директиве, а переход ИЗ
 * published уходил в ветку «прочее» до всех проверок. Одна операция с фильтром
 * «все опубликованные» и общим решением `withdrawal = { mode: '301',
 * redirectTo: '/' }` создавала по 301 с каждого снятого пути на один адрес — то
 * есть ровно тот массовый редирект удалённых страниц на главную, который
 * запрещён п. 23 и разделом «HTTP-статусы» `CLAUDE.md`. Требование выборки на
 * все смены статуса заодно приводит реализацию к дословной формулировке ТЗ §8.5
 * («для ВЫБРАННЫХ записей»), а не к её вольному чтению.
 *
 * Решение о судьбе URL в пакете запрещено ВСЕГДА, при любом режиме и любой
 * выборке: у каждого снятого пути своя судьба. Одно значение `redirectTo` на
 * выборку — это N редиректов в одну точку; общий `404`/`410` — это одно решение,
 * принятое не глядя. ТЗ §8.5 говорит о published «только поштучно», и именно
 * поэтому снятие остаётся поштучным (`assertIncomingChangeAllowed` +
 * {@link planStatusTransition}).
 *
 * Роль: `admin` требуется для публикации и для включения индексации. Пакетная
 * смена `draft ↔ review` доступна и сервисному аккаунту (ТЗ §9) — а если в его
 * выборку попала опубликованная запись, её отклонит проверка КАЖДОЙ записи
 * (`unpublish-requires-admin`, `unpublish-requires-decision`).
 *
 * @throws ContentRuleError
 */
export function assertBulkChangeAllowed(input: {
  readonly incoming: Readonly<Record<string, unknown>>;
  readonly user: RoledUser | null | undefined;
  readonly where: unknown;
}): BulkIntent {
  const { incoming, user, where } = input;

  const shapeChange = URL_SHAPE_FIELDS.filter((field) => field in incoming);
  if (shapeChange.length > 0) {
    fail(
      'bulk-url-change',
      `Пакетная смена полей URL (${shapeChange.join(', ')}) запрещена: каждый переехавший ` +
        'путь требует собственного одиночного 301, а одно значение slug на выборку ' +
        'записей означало бы либо конфликт путей, либо потерю адресов. Переносите записи ' +
        'по одной.',
    );
  }

  if (bulkCarriesWithdrawalDecision(incoming.withdrawal)) {
    fail(
      'bulk-withdrawal-forbidden',
      'Решение о судьбе URL нельзя применить к выборке одной операцией: у каждого снятого ' +
        'с публикации пути своя судьба. Один путь замены на выборку — это редирект с ' +
        'нескольких удалённых страниц на один адрес, что запрещено прямо (п. 23 SEO ТЗ, ' +
        '«массовый редирект удалённых страниц на главную»); общий 404 или 410 — это ' +
        'решение, принятое не глядя. ТЗ §8.5: published — только поштучно. Снимайте ' +
        'записи по одной, выбирая 301 с путём замены, 410 или 404 для каждой.',
    );
  }

  const statusChange = 'status' in incoming;
  const publishing = incoming.status === 'published';
  const indexing = isIndexableRobots(incoming.robots);

  if (!statusChange && !indexing) {
    return { ids: null, kind: 'other' };
  }

  if (publishing && indexing) {
    fail(
      'index-not-separate',
      'Пакетное включение index,follow — отдельное явное действие (решение Ч-07): ' +
        'публикация и открытие в индекс не выполняются одной операцией. Опубликуйте ' +
        'выборку, проверьте условия п. 5.1 SEO ТЗ и включите индексацию вторым пакетом.',
    );
  }

  if ((publishing || indexing) && !isAdmin(user)) {
    fail(
      'bulk-requires-admin',
      'Пакетная публикация и пакетное включение index,follow доступны только роли admin ' +
        '(решение Ч-07). Массовая публикация по расписанию, по вызову API сервисным ' +
        'аккаунтом или из кода остаётся запрещённой. Уточнение к прежней формулировке: ' +
        'проверяется РОЛЬ, а не происхождение запроса — admin с API-ключом ту же операцию ' +
        'выполнит, и обещать «только из админки» текст отказа не вправе.',
    );
  }

  const ids = readExplicitIdSelection(where);
  if (ids === null) {
    fail(
      'bulk-requires-explicit-selection',
      'Пакетная смена статуса применяется только к ЯВНО выбранным записям (ТЗ §8.5 — ' +
        '«для выбранных записей»; решение Ч-07 — «выборка, которую выбрал сам»). Условие ' +
        'вида «все записи в review» или «все опубликованные» — это операция по фильтру: ' +
        'человек не видел, что именно уйдёт в индекс и что именно исчезнет из него. ' +
        'Особенно это касается ухода из published: путь снятой страницы уже известен ' +
        'поисковику, и решение о нём принимается по каждому адресу.',
    );
  }

  if (ids.length > MAX_BATCH_SELECTION) {
    fail(
      'bulk-too-large',
      `В выборке ${String(ids.length)} записей, предел — ${String(MAX_BATCH_SELECTION)}. ` +
        'Перечисление в тысячи id — это тот же фильтр из кода, только записанный ' +
        'списком: человек такую выборку не просматривал.',
    );
  }

  return { ids, kind: publishing ? 'publish' : indexing ? 'index' : 'status' };
}

function describe(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return 'не задан';
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  // JSON.stringify возвращает undefined для функций и символов: подставлять в
  // текст отказа «[object Object]» нельзя — отказ должен быть читаемым.
  return JSON.stringify(value) ?? 'значение неподдерживаемого типа';
}
