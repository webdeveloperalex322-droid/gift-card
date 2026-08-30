/**
 * Массовая привязка карточек к подборке (задача Э5-06, ТЗ §8.5).
 *
 * ПОЧЕМУ ПАКЕТ ДОБАВЛЯЕТ, А НЕ ЗАМЕНЯЕТ. Связь `cards.collections` —
 * many-to-many, и порядок в ней значим: ПЕРВАЯ подборка основная, из неё
 * строятся хлебные крошки карточки (описание поля в `cards.ts`). Пакетное
 * обновление в Payload — это `update` по `where` с одним значением поля на всю
 * выборку, то есть по умолчанию ЗАМЕНА списка. Применённая к выборке карточек,
 * она стёрла бы все прежние связи и переставила основную подборку у каждой
 * карточки, где её уже выбрали осмысленно, — причём молча: ни одно правило
 * проекта на порядок связи не смотрит, и увидеть последствие можно было бы
 * только на отрендеренных крошках.
 *
 * Поэтому в ПАКЕТЕ значение поля читается как «привязать вдобавок»: набор
 * объединяется с текущим, порядок уже выбранных не меняется, новые id идут в
 * конец. Отвязать пакетом нельзя вовсе — пустой список отклоняет гейт
 * (`bulk-collections-clear` в `./status-model.ts`).
 *
 * ПОЧЕМУ НЕ ОТДЕЛЬНОЕ ПОЛЕ И НЕ ОТДЕЛЬНАЯ РУЧКА. Второй механизм рядом с
 * пакетным гейтом означал бы вторую границу «выборка человека против фильтра»,
 * которую надо защищать отдельно. Здесь используется тот же путь `update` по
 * `where`, тот же `beforeOperation`-гейт и та же проверка каждой записи —
 * меняется только трактовка значения, и меняется она РОВНО в пакете:
 * поштучная правка карточки остаётся заменой списка, потому что там редактор
 * видит и правит связь целиком в форме.
 *
 * ПОЧЕМУ ПРИЗНАК ПАКЕТА ЖИВЁТ В `req.context`. Отличить пакет от одиночной
 * правки можно только там, где видны аргументы операции (`id` против `where`),
 * то есть в `beforeOperation`. Хук поля до аргументов не дотягивается, а
 * строка `operation` в Payload 3.88 у обоих случаев одна и та же (`'update'`,
 * см. комментарий к `guardIncomingOperation`). Признак ставится тем же гейтом,
 * который уже разделил эти два случая, и читается хуком карточки.
 */
import type { CollectionBeforeValidateHook, PayloadRequest, TypeWithID } from 'payload';

import { CARD_COLLECTIONS_FIELD } from './status-model';

/** Идентификатор связи: тип сохраняется как есть — база ждёт число, а не «12». */
type RelationId = number | string;

/**
 * Ключ признака «идёт пакетное обновление» в `req.context`.
 *
 * Ключ СВОЙ у каждой коллекции: в одном запросе хуки одной коллекции вызывают
 * операции над другой (синхронизация редиректов, запись истории, зеркало
 * изображения), и общий ключ означал бы, что одиночная правка внутри пакета по
 * соседней коллекции тоже считается пакетной.
 */
export function bulkUpdateContextKey(collectionSlug: string): string {
  return `otkritka:bulkUpdate:${collectionSlug}`;
}

/** Помечает запрос как пакетное обновление коллекции. Вызывается из `beforeOperation`. */
export function markBulkUpdate(req: PayloadRequest, collectionSlug: string): void {
  req.context[bulkUpdateContextKey(collectionSlug)] = true;
}

/** Идёт ли в этом запросе пакетное обновление коллекции. */
export function isBulkUpdate(req: PayloadRequest, collectionSlug: string): boolean {
  return req.context[bulkUpdateContextKey(collectionSlug)] === true;
}

/**
 * Идентификаторы связи `hasMany` из значения любого вида, в каком его отдаёт или
 * принимает Payload: список id, список документов (на глубине по умолчанию в
 * связь подставляется весь документ), одиночное значение, пусто.
 *
 * Непонятные элементы пропускаются, а не роняют операцию: значение приходит и от
 * внешнего клиента, и от формы админки, и отказ на мусоре здесь подменил бы
 * собой валидацию связи, которую Payload делает сам и делает лучше.
 */
export function readRelationIdList(value: unknown): readonly RelationId[] {
  if (value === null || value === undefined) {
    return [];
  }
  // Каждый элемент явно объявлен `unknown`: `Array.isArray` на значении типа
  // `unknown` сужает его до `any[]`, и дальше проверки типов молча перестали бы
  // что-либо значить.
  const items: readonly unknown[] = Array.isArray(value)
    ? value.map((item: unknown) => item)
    : [value];
  const ids: RelationId[] = [];
  for (const item of items) {
    if (typeof item === 'number' || typeof item === 'string') {
      ids.push(item);
      continue;
    }
    if (typeof item === 'object' && item !== null && 'id' in item) {
      const { id } = item;
      if (typeof id === 'number' || typeof id === 'string') {
        ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * Объединение текущих подборок карточки с привязываемыми.
 *
 * Порядок текущих сохраняется целиком, включая первую (основную): привязка
 * добавляет, а не перестраивает. Совпадение идентификаторов проверяется по
 * строковому виду — REST присылает `"12"`, база хранит `12`, и без нормализации
 * одна и та же подборка попала бы в связь дважды.
 */
export function mergeCardCollections(args: {
  readonly existing: unknown;
  readonly incoming: unknown;
}): readonly RelationId[] {
  const merged = [...readRelationIdList(args.existing)];
  const seen = new Set(merged.map((id) => String(id)));
  for (const id of readRelationIdList(args.incoming)) {
    const key = String(id);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(id);
    }
  }
  return merged;
}

/** Документ карточки в объёме, который нужен привязке. */
type CardRecord = TypeWithID & Record<string, unknown>;

/**
 * Хук карточки: в пакетном обновлении значение связи с подборками читается как
 * «привязать вдобавок».
 *
 * Фаза `beforeValidate` выбрана потому, что здесь уже есть `originalDoc`
 * (текущие связи карточки) и данные ещё не ушли в валидацию — то есть проверять
 * связь Payload будет уже на итоговом списке.
 *
 * Вне пакета хук не делает ничего: одиночная правка карточки остаётся заменой
 * списка, и снять лишнюю подборку можно ровно там, где редактор видит связь
 * целиком.
 */
export function attachCollectionsInBulk(): CollectionBeforeValidateHook<CardRecord> {
  return ({ data, operation, originalDoc, req }) => {
    if (operation !== 'update' || data === undefined || originalDoc === undefined) {
      return data;
    }
    if (!isBulkUpdate(req, 'cards') || !(CARD_COLLECTIONS_FIELD in data)) {
      return data;
    }
    return {
      ...data,
      [CARD_COLLECTIONS_FIELD]: mergeCardCollections({
        existing: originalDoc[CARD_COLLECTIONS_FIELD],
        incoming: data[CARD_COLLECTIONS_FIELD],
      }),
    };
  };
}
