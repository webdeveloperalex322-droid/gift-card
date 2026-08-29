/**
 * Дубли метатегов (задача Э5-01; ТЗ §8.3.1): чистое ядро правил, без Payload и
 * без базы.
 *
 * Требование ТЗ состоит из ДВУХ разных механизмов, и путать их нельзя:
 *
 *   1. «совпадение title или metaDescription с существующими записями →
 *      предупреждение со ссылками на конфликтующие страницы». Предупреждение —
 *      значит сохранение проходит. Форма предупреждения выбрана так, чтобы оно
 *      доходило до ОБОИХ каналов: снимок конфликтов пишется в саму запись
 *      (группа `metaConflict`), поэтому приходит и в форму админки, и в ответ
 *      REST/GraphQL на то же самое сохранение. Журнал сервера для этого не
 *      годится — внешний AI-редактор его не видит (тот же довод уже записан в
 *      `assertDescriptionForIndex` и в `../images/duplicates.ts`);
 *   2. «перевод в review при неразрешённом конфликте — с явным подтверждением».
 *      Это уже отказ ({@link assertMetaConflictResolved}), и снимается он
 *      подтверждением, привязанным к ОТПЕЧАТКУ набора конфликтов
 *      ({@link metaConflictFingerprint}) — иначе редактор подтвердил бы один раз,
 *      и правило умерло бы: виза, выданная прежнему заголовку, действовала бы
 *      для любого следующего.
 *
 * ЧТО СЧИТАЕТСЯ КОНФЛИКТОМ. Совпадение НОРМАЛИЗОВАННЫХ значений одноимённых
 * полей ({@link normalizeMetaValue}): title сравнивается с title, description с
 * description. Заголовок, совпавший с чужим описанием, конфликтом не считается —
 * в выдаче это разные элементы сниппета, и объединять их значило бы блокировать
 * законные тексты. Пустое значение конфликтом не является вовсе: пустой
 * description уже наказан отдельным правилом (`index-requires-description`), а
 * «все пустые совпадают со всеми пустыми» превратило бы предупреждение в шум,
 * который перестают читать.
 *
 * ГДЕ ИЩЕМ — В ОБЕИХ КОНТЕНТНЫХ КОЛЛЕКЦИЯХ. Пространства имён карточек и
 * подборок разведены, но title и description — это выдача поисковика, а не путь:
 * одинаковый заголовок у карточки и у подборки конкурирует в выдаче так же, как
 * у двух карточек.
 *
 * КРУГ ПОИСКА — `published` и `review` ({@link META_DUPLICATE_SEARCH_STATUSES}),
 * и это не копия решения о визуальных дублях, а тот же вывод из другого пункта
 * ТЗ. Обоснование: инвариант «двух записей с одинаковым нормализованным
 * заголовком в review или published не бывает» держится по индукции — каждая
 * запись проходит калитку на СВОЁМ переходе вперёд, поэтому вторая из пары
 * увидит первую. Черновики в круг не входят намеренно: их много, они
 * заполняются по частям, и предупреждение на каждом наброске обесценило бы
 * предупреждение вообще. Принятая цена названа прямо: два черновика с
 * одинаковым title друг о друге не знают, и узнают об этом на первом же
 * переходе в review.
 */
import { createHash } from 'node:crypto';

import { ContentRuleError } from './status-model';

/** Поля, совпадение которых считается дублем метатегов (ТЗ §8.3.1). */
export const META_DUPLICATE_FIELDS = ['title', 'metaDescription'] as const;

export type MetaDuplicateField = (typeof META_DUPLICATE_FIELDS)[number];

export const META_DUPLICATE_FIELD_LABELS: Readonly<Record<MetaDuplicateField, string>> = {
  metaDescription: 'meta description',
  title: 'заголовок (title)',
};

/**
 * Статусы, среди которых ищутся совпадения.
 *
 * Значение сегодня совпадает с `DUPLICATE_SEARCH_STATUSES` (визуальные дубли),
 * но константа СВОЯ: круг поиска визуальных дублей задан ТЗ §6.7 п. 4, круг
 * поиска дублей метатегов — ТЗ §8.3.1, и меняться они могут порознь. Тот же
 * приём, что у `canEditSlug` и `canReplaceImage` в `../access/policies.ts`:
 * правила одинаковой формы записываются отдельно, чтобы правка одного не двигала
 * другое молча.
 */
export const META_DUPLICATE_SEARCH_STATUSES = ['published', 'review'] as const;

/**
 * Сколько конфликтующих записей попадает в снимок.
 *
 * ПРОВЕНАНС: выбор агента, не решение человека (тот же список кандидатов в
 * реестр, что `MAX_BATCH_SELECTION` и `SIMILARITY_SCAN_LIMITS`). Смысл предела:
 * снимок — это предупреждение, которое читают глазами, а не выгрузка. Общее
 * число найденных при этом НЕ теряется — оно хранится отдельно и входит в
 * отпечаток, поэтому усечение списка не делает визу вечной.
 */
export const MAX_LISTED_META_CONFLICTS = 20;

export type MetaDocumentCollection = 'cards' | 'collections';

/** Одно совпадение: чья запись, по какому полю и где её страница. */
export interface MetaConflict {
  readonly documentCollection: MetaDocumentCollection;
  readonly documentId: string;
  readonly field: MetaDuplicateField;
  /** Путь конфликтующей страницы; `null` — путь ещё не собран. */
  readonly path: string | null;
  readonly status: string | null;
  readonly title: string | null;
}

export interface MetaConflictFacts {
  readonly conflicts: readonly MetaConflict[];
  /** Сколько записей нашлось ВСЕГО, включая не попавшие в список. */
  readonly total: number;
  readonly truncated: boolean;
}

/**
 * Нормализованное значение метатега — то, по которому сравниваются записи.
 *
 * Что нормализуется и почему ровно это:
 *   - **регистр**: конфликт, «решённый» заглавной буквой, не решён — в выдаче
 *     это тот же заголовок. `toLowerCase`, а не `toLocaleLowerCase`: значение
 *     хранится в записи и ищется индексом, поэтому оно не имеет права зависеть
 *     от локали процесса, который его записал;
 *   - **пробелы**: любая последовательность пробельных символов (включая
 *     неразрывный пробел и перевод строки) сводится к одному пробелу, края
 *     обрезаются. Двойной пробел — это опечатка, а не другой заголовок;
 *   - **форма Unicode** (NFC): один и тот же русский текст, набранный с
 *     комбинирующими знаками, иначе дал бы два разных ключа.
 *
 * Чего нормализация НЕ делает — сознательно: не убирает пунктуацию, не
 * приравнивает «е» и «ё», не отбрасывает служебные слова. Над-нормализация
 * порождает ложные конфликты, а выходят из них ухудшением заголовка — то есть
 * ровно тем, против чего правило и написано.
 *
 * @returns `null` для пустого значения и для значения не-строки: пустота
 *   конфликтом не является.
 */
export function normalizeMetaValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const collapsed = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  return collapsed === '' ? null : collapsed.toLowerCase();
}

function conflictKey(conflict: MetaConflict): string {
  return `${conflict.documentCollection}#${conflict.documentId}:${conflict.field}`;
}

/**
 * Отпечаток набора конфликтов: короткий хеш от нормализованных значений, состава
 * набора и общего числа найденных.
 *
 * Порядок записей на результат не влияет (список сортируется), поэтому отпечаток
 * не «дрожит» от порядка выборки из базы. Общее число входит в отпечаток
 * отдельно от списка: при усечённом списке появление нового конфликта иначе не
 * устаревало бы визу.
 */
export function metaConflictFingerprint(input: {
  readonly conflicts: readonly MetaConflict[];
  readonly descriptionKey: string | null;
  readonly titleKey: string | null;
  readonly total: number;
}): string {
  const keys = input.conflicts.map((conflict) => conflictKey(conflict)).sort();
  return createHash('sha256')
    .update(
      `${input.titleKey ?? ''}|${input.descriptionKey ?? ''}|${String(input.total)}|${keys.join(',')}`,
    )
    .digest('hex')
    .slice(0, 16);
}

function isMetaDuplicateField(value: unknown): value is MetaDuplicateField {
  return typeof value === 'string' && (META_DUPLICATE_FIELDS as readonly string[]).includes(value);
}

function isMetaDocumentCollection(value: unknown): value is MetaDocumentCollection {
  return value === 'cards' || value === 'collections';
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Читает СОХРАНЁННЫЙ снимок конфликтов из записи.
 *
 * Терпимость к мусору здесь обязательна: снимок читается на каждом чтении
 * записи (в том числе списком в админке), и строка, не разобранная по форме, не
 * должна валить чтение карточки. Неразобранная строка отбрасывается, а не
 * считается конфликтом — конфликт, о котором нельзя сказать, с кем он, редактору
 * бесполезен.
 */
export function readMetaConflictFacts(value: unknown): MetaConflictFacts {
  if (typeof value !== 'object' || value === null) {
    return { conflicts: [], total: 0, truncated: false };
  }
  const record: Record<string, unknown> = { ...value };
  const rows: readonly unknown[] = Array.isArray(record.conflicts) ? record.conflicts : [];
  const conflicts: MetaConflict[] = [];

  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const entry: Record<string, unknown> = { ...row };
    const field = entry.field;
    const documentCollection = entry.documentCollection;
    const documentId = readString(entry.documentId);
    if (!isMetaDuplicateField(field) || !isMetaDocumentCollection(documentCollection) || documentId === null) {
      continue;
    }
    conflicts.push({
      documentCollection,
      documentId,
      field,
      path: readString(entry.path),
      status: readString(entry.status),
      title: readString(entry.title),
    });
  }

  const total = typeof record.total === 'number' && Number.isFinite(record.total) ? record.total : 0;

  return { conflicts, total, truncated: record.truncated === true };
}

function describeConflict(conflict: MetaConflict): string {
  const where = conflict.path ?? `${conflict.documentCollection} #${conflict.documentId}`;
  const status = conflict.status === null ? '' : `, ${conflict.status}`;
  return `${META_DUPLICATE_FIELD_LABELS[conflict.field]} — ${where}${status}`;
}

/**
 * ЕДИНСТВЕННАЯ формулировка набора конфликтов на весь проект.
 *
 * Её печатают и снимок в записи (виртуальное поле-зеркало `metaConflict.summary`,
 * приходит в REST и GraphQL), и текст отказа при переводе в `review`. Две
 * формулировки одного факта расходятся, и тогда предупреждение обещает не то,
 * что делает отказ.
 */
export function describeMetaConflicts(facts: MetaConflictFacts): string {
  if (facts.conflicts.length === 0) {
    return (
      'Совпадений title и meta description не найдено: проверено по открыткам и подборкам ' +
      'в статусах published и review (ТЗ §8.3.1). Черновики в круг поиска не входят.'
    );
  }

  const list = facts.conflicts.map((conflict) => describeConflict(conflict)).join('; ');
  const tail = facts.truncated
    ? ` Всего найдено ${String(facts.total)}, показаны первые ${String(facts.conflicts.length)}.`
    : '';

  return (
    `Совпадение метатегов с уже существующими страницами (${String(facts.total)}): ${list}.` +
    `${tail} Одинаковые title и description у двух страниц заставляют их конкурировать в ` +
    'выдаче за один запрос. Либо перепишите текст, либо подтвердите конфликт осознанно ' +
    '(галочка «Подтверждаю» в группе «Проверка дублей метатегов»).'
  );
}

/** Статусы, в которых страница уже видна проверяющему или поиску. */
function isForwardStatus(status: unknown): boolean {
  return status === 'review' || status === 'published';
}

export interface MetaConflictGate {
  readonly conflicts: readonly MetaConflict[];
  /** Отпечаток, для которого редактор подтвердил конфликт (хранится в записи). */
  readonly confirmedFor: unknown;
  /**
   * Выдано ли подтверждение ЭТОЙ операцией (галочка `metaConflict.confirm` во
   * входных данных), а не унаследовано из записи.
   *
   * Поле обязательное, а не «необязательное со значением по умолчанию»: от него
   * зависит, пропустит ли калитка публикацию, и забытый параметр молча вернул бы
   * прежнее — неверное — поведение.
   */
  readonly confirmedNow: boolean;
  /** Отпечаток НАЙДЕННОГО СЕЙЧАС набора: {@link metaConflictFingerprint}. */
  readonly fingerprint: string;
  /**
   * Меняются ли ЗНАЧЕНИЯ метатегов этой операцией.
   *
   * Поле обязательное, а не «необязательное со значением по умолчанию»: забытый
   * параметр тогда молча снимал бы калитку с правки уже видимой страницы, и
   * заметить это можно было бы только по двум одинаковым заголовкам в выдаче.
   */
  readonly metaChanged: boolean;
  readonly nextStatus: unknown;
  readonly previousStatus: unknown;
}

/**
 * Не даёт увести запись вперёд по статусам, пока конфликт метатегов не разрешён
 * или не подтверждён явно (ТЗ §8.3.1).
 *
 * ДВА СЛУЧАЯ, оба обязательные — ровно как у калитки визуальных дублей:
 *
 *   1. ПЕРЕХОД `draft → review → published`. Править черновик с чужим заголовком
 *      никто не запрещает; запрещено вести его дальше молча.
 *   2. ПРАВКА МЕТАТЕГА у записи, которая уже в `review` или `published`. Статус
 *      при этом не меняется, а две страницы с одинаковым title появляются
 *      сразу — обе уже видны. Не закрыть этот случай значило бы повторить
 *      находку ревизии от 2026-08-22 (подмена изображения у опубликованной
 *      карточки проходила молча), зная о ней.
 *
 * Отказ, а не предупреждение, ровно здесь и только здесь: предупреждение о
 * конфликте редактор уже получил снимком в записи при сохранении. Переход вперёд
 * — момент, после которого страница становится видна, и «предупреждение,
 * которое можно не заметить» на нём равно отсутствию правила.
 *
 * ВИЗА НЕ ПЕРЕЖИВАЕТ ПУБЛИКАЦИЮ. Подтверждение хранится в записи (`confirmedFor`)
 * и по отпечатку годится для любого следующего перехода, пока набор конфликтов
 * тот же. Для перехода в `published` этого мало, и это находка ревизии от
 * 2026-08-29: `ai-editor` подтверждал совпадение на переходе `draft → review`,
 * набор с тех пор не менялся, отпечаток совпадал — и публикация, которую делает
 * уже `admin`, проходила МОЛЧА. Человек, открывающий страницу миру, обязан
 * увидеть то, что подтверждал не он, поэтому на `published` требуется
 * подтверждение ЭТОЙ операции ({@link MetaConflictGate.confirmedNow}).
 * Привязать визу к паре статусов было бы дешевле, но слабее: она всё равно
 * оставалась бы визой, выданной другой ролью.
 *
 * @throws ContentRuleError с кодом `meta-duplicate-unresolved`
 */
export function assertMetaConflictResolved(gate: MetaConflictGate): void {
  const statusChanged = gate.nextStatus !== gate.previousStatus;
  const goingForward = isForwardStatus(gate.nextStatus);
  const editOnVisiblePage =
    gate.metaChanged && goingForward && isForwardStatus(gate.previousStatus);

  if ((!statusChanged && !editOnVisiblePage) || !goingForward || gate.conflicts.length === 0) {
    return;
  }

  const confirmedForThisSet = gate.confirmedFor === gate.fingerprint;
  // Виза есть, но выдана не этой операцией. Для review её достаточно, для
  // публикации — нет: см. «ВИЗА НЕ ПЕРЕЖИВАЕТ ПУБЛИКАЦИЮ» выше.
  const inherited = confirmedForThisSet && !gate.confirmedNow;
  const publishing = gate.nextStatus === 'published';

  if (confirmedForThisSet && !(publishing && inherited)) {
    return;
  }

  const preamble = describeMetaConflicts({
    conflicts: gate.conflicts,
    total: gate.conflicts.length,
    truncated: false,
  });

  const stale =
    !inherited && typeof gate.confirmedFor === 'string' && gate.confirmedFor.trim() !== ''
      ? 'Прежнее подтверждение УСТАРЕЛО: оно выдано для другого набора конфликтов ' +
        '(значения метатегов или круг конфликтующих страниц изменились). Подтвердите заново — ' +
        'иначе виза, выданная прежнему заголовку, пропускала бы любой следующий. '
      : '';

  const notTransferable = inherited
    ? 'Подтверждение по этому набору совпадений уже есть, но выдано оно РАНЬШЕ и другим ' +
      'переходом — возможно, сервисным аккаунтом на пути draft → review. На публикацию оно ' +
      'не переносится: страницу открывает миру человек, и совпадение заголовков он обязан ' +
      'увидеть сам, а не унаследовать чужое решение. Отметьте подтверждение в том же ' +
      'сохранении, которым публикуете. '
    : '';

  throw new ContentRuleError(
    'meta-duplicate-unresolved',
    `${preamble} ${stale}${notTransferable}Переход «${String(gate.previousStatus)}» → ` +
      `«${String(gate.nextStatus)}» заблокирован до явного решения: измените title или ` +
      'meta description либо отметьте подтверждение в том же сохранении. Автоматически ' +
      'такое решение не принимается — совпадение бывает и законным, но решает человек, а ' +
      'не проверка.',
  );
}

/**
 * Не даёт открыть страницу в `index,follow`, пока её метатеги совпадают с чужими
 * (условие п. 5.1 «уникальные title/H1/вводный текст», чек-лист п. 22 —
 * «уникальные title/H1/description на выборке»).
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ КАЛИТКА, ЕСЛИ ЕСТЬ {@link assertMetaConflictResolved}. Та
 * стоит на СМЕНЕ СТАТУСА и на правке метатегов. Включение индексации у уже
 * опубликованной записи — не то и не другое: статус не меняется, значения
 * метатегов тоже, и калитка выходила по первому же условию. Между тем момент
 * открытия в индекс — единственный, на котором условие п. 5.1 вообще
 * применяется: до него страница `noindex` и в выдаче ни с кем не конкурирует.
 * Находка ревизии от 2026-08-29: механика уникальности была построена (ключи,
 * поиск, отпечаток), но к решению об индексации не подключена.
 *
 * ЧТО СЧИТАЕТСЯ НАРУШЕНИЕМ. Любое совпадение из снимка — и по title, и по meta
 * description. Оба поля перечислены в чек-листе приёмки п. 22 отдельными
 * пунктами, поэтому «блокировать только заголовок» означало бы отдать
 * description приёмке, которая упадёт на нём позже и дороже.
 *
 * ЧЕГО КАЛИТКА НЕ ДЕЛАЕТ. Она не решает индексировать: единственный её исход —
 * отказ. Снимается он тем же явным подтверждением в том же сохранении, что и
 * калитка перехода, — и это сознательно: совпадение бывает законным (например, с
 * записью в `review`, которую вот-вот переименуют), а условия п. 5.1 машиной не
 * проверяются и остаются решением человека. Разница с прежним состоянием в том,
 * что решение теперь ПРИНИМАЕТСЯ, а не пропускается молча.
 *
 * @throws ContentRuleError с кодом `index-requires-unique-meta`
 */
export function assertMetaUniqueForIndex(input: {
  readonly conflicts: readonly MetaConflict[];
  /** Подтверждение, выданное ЭТОЙ операцией. Унаследованное не годится. */
  readonly confirmedNow: boolean;
  /** Открывается ли индексация именно этой операцией. */
  readonly indexOpening: boolean;
  /** Путь записи для текста отказа; `null` — путь ещё не собран. */
  readonly path: string | null;
}): void {
  if (!input.indexOpening || input.conflicts.length === 0 || input.confirmedNow) {
    return;
  }

  const preamble = describeMetaConflicts({
    conflicts: input.conflicts,
    total: input.conflicts.length,
    truncated: false,
  });

  throw new ContentRuleError(
    'index-requires-unique-meta',
    `${preamble} Поэтому index,follow ${
      input.path === null ? 'для этой записи' : `для страницы «${input.path}»`
    } не включён: уникальные title, H1 и description — одно из условий п. 5.1 SEO ТЗ и ` +
      'отдельный пункт чек-листа приёмки п. 22. Две страницы с одинаковым заголовком в ' +
      'индексе конкурируют друг с другом за один запрос, и выигрывает от этого не сайт. ' +
      'Перепишите текст — либо, если совпадение законное, отметьте подтверждение в группе ' +
      '«Проверка дублей метатегов» тем же сохранением, которым открываете индексацию.',
  );
}
