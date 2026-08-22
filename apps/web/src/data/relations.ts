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
