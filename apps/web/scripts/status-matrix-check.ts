/**
 * Мост между матрицей HTTP-статусов и живым смоуком (задача Э4-06).
 *
 * Матрица (`../src/server/http-status-matrix.ts`) перечисляет ситуации и их
 * ответы; здесь — способ приложить её к настоящему ответу сервера и, главное,
 * СВЕРИТЬ СПИСОК: какие строки матрица поручила этому файлу и все ли из них он
 * отработал.
 *
 * Почему модуль общий, а не по копии в каждом смоуке. Копия проверки «у 410 не
 * бывает Location» живёт только в своём файле: второй смоук про неё не узнает, и
 * два смоука начнут проверять строку по-разному. А копия СВЕРКИ списка ещё хуже
 * — она обязана падать на забытой строке, то есть быть одинаковой везде, иначе
 * забытую строку поймает один смоук и пропустит другой.
 *
 * Модуль ЧИСТЫЙ: без сети и без базы. `record` приходит параметром, потому что у
 * каждого смоука свой журнал проверок и свой код выхода.
 */

import {
  type HttpStatusRowId,
  httpStatusRow,
  liveRowsFor,
  type ObservedResponse,
  statusViolations,
} from '../src/server/http-status-matrix.js';

/** Журнал проверок смоука: имя, исход, подробности. */
export type RecordCheck = (name: string, ok: boolean, detail?: string) => void;

export interface StatusMatrixHarness {
  /**
   * Проверяет один ответ по строке матрицы и отмечает строку отработанной.
   *
   * @param id строка матрицы;
   * @param label адрес или обстоятельство — попадает в название проверки, чтобы
   *   в журнале было видно, ЧТО именно отвечало;
   * @param observed наблюдение: статус, заголовки, тело, число переходов.
   */
  check(id: HttpStatusRowId, label: string, observed: ObservedResponse): void;
  /**
   * Сверяет отработанное с поручённым. Зовётся один раз в конце прогона.
   *
   * Список берётся у матрицы, а не перечисляется в смоуке: строка, которой
   * матрица поручила живую проверку этому файлу и которую забыли отработать,
   * обязана валить прогон, а не оставаться обещанием в комментарии.
   */
  assertAllRowsExercised(): void;
}

/**
 * @param file путь этого смоука от корня монорепозитория — ровно тем
 *   написанием, каким он записан в матрице. Иначе список поручённых строк
 *   окажется пустым, и сверка станет тавтологией.
 */
export function createStatusMatrixHarness(
  file: string,
  record: RecordCheck,
): StatusMatrixHarness {
  const exercised = new Set<HttpStatusRowId>();

  return {
    assertAllRowsExercised(): void {
      const assigned = liveRowsFor(file);
      if (assigned.length === 0) {
        // Пустое поручение — это ошибка настройки моста, а не «нечего делать»:
        // смоук зовёт сверку, значит матрица должна была что-то ему поручить.
        record(
          `матрица статусов: ${file} не значится источником ни одной живой проверки`,
          false,
          'проверьте написание пути в матрице и в вызове createStatusMatrixHarness',
        );
        return;
      }

      const missing = assigned.filter((row) => !exercised.has(row.id));
      record(
        `матрица статусов: отработаны все ${String(assigned.length)} строк, порученных смоуку`,
        missing.length === 0,
        missing.length === 0
          ? assigned.map((row) => row.id).join(', ')
          : `не отработаны: ${missing.map((row) => row.id).join(', ')}`,
      );
    },

    check(id: HttpStatusRowId, label: string, observed: ObservedResponse): void {
      const row = httpStatusRow(id);
      exercised.add(id);
      const violations = statusViolations(row, observed);
      record(
        `матрица «${row.situation} → ${row.answer}»: ${label}`,
        violations.length === 0,
        violations.length === 0 ? `статус ${String(observed.status)}` : violations.join('; '),
      );
    },
  };
}
