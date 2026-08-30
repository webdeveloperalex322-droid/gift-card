/**
 * Чтение значений связей в том виде, в каком их отдаёт Payload.
 *
 * Модуль ЧИСТЫЙ и намеренно отделён от `./content.ts`: тот импортирует
 * `./payload-client.ts`, а через него — конфиг Payload целиком, то есть требует
 * рабочего окружения (в том числе `DATABASE_URL`) уже на загрузке модуля.
 * Разбору связи ничего этого не нужно, а потребителям разбора — тем более: без
 * этого разделения юнит-тест адаптера крошек поднимал бы конфиг CMS ради двух
 * чистых функций.
 *
 * Функции жили в `./content.ts` до задачи Э3-03 и перенесены сюда без изменения
 * поведения; `./content.ts` их реэкспортирует, поэтому прежние импорты работают.
 */

import type { RecordId } from './queries.js';

/**
 * Идентификатор связи из значения, которое отдаёт Payload.
 *
 * При `depth: 0` это число или строка; форма «объект с id» тоже разбирается —
 * тогда вызывающий не обязан знать, каким запросом получена запись.
 */
export function relationId(value: unknown): RecordId | null {
  if (typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && value !== null && 'id' in value) {
    const { id } = value;
    if (typeof id === 'number' || typeof id === 'string') {
      return id;
    }
  }
  return null;
}

/**
 * Восстанавливает порядок записей по списку идентификаторов (задача Э3-05).
 *
 * Зачем это нужно. Порядок связи «многие ко многим» задаёт РЕДАКТОР, и у связи
 * `cards.collections` он значим: первая подборка — основная (контракт коллекции
 * `cards`), из неё строятся крошки, и в том же порядке выводятся видимые
 * атрибуты-ссылки карточки. Запрос же возвращает записи в порядке своей
 * сортировки — по заголовку, потому что сортировать «по списку
 * идентификаторов» на стороне БД нечем. Без этой функции переименование
 * подборки меняло бы порядок атрибутов на всех карточках сразу.
 *
 * Записи, которых в ответе нет (неопубликованные), просто выпадают: ссылки на
 * них не существует, и это то же решение, что у разрыва цепочки крошек.
 * Лишние записи, которых не было в списке, не добавляются.
 */
export function orderByIds<T extends { readonly id: RecordId }>(
  docs: readonly T[],
  ids: readonly RecordId[],
): readonly T[] {
  const byId = new Map<string, T>(docs.map((doc) => [String(doc.id), doc]));
  const ordered: T[] = [];
  for (const id of ids) {
    const doc = byId.get(String(id));
    if (doc !== undefined) {
      ordered.push(doc);
      // Повтор идентификатора в связи не должен давать запись дважды: это была
      // бы вторая одинаковая ссылка в блоке и второй элемент разметки на один
      // адрес.
      byId.delete(String(id));
    }
  }
  return ordered;
}

/** Идентификаторы связи «многие ко многим» в порядке, заданном редактором. */
export function relationIds(value: unknown): readonly RecordId[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids: RecordId[] = [];
  for (const item of value) {
    const id = relationId(item);
    if (id !== null) {
      ids.push(id);
    }
  }
  return ids;
}
