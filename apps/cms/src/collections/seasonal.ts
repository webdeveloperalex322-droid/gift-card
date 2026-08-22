/**
 * Сезонное планирование подборки (ТЗ §8.6, решение Ч-12).
 *
 * Календарь праздников — ОФИЦИАЛЬНЫЙ календарь РФ, а даты вводятся в админке
 * (Ч-12): списка праздников в коде нет и быть не должно — иначе он разошёлся бы
 * с календарём в первый же перенос выходных, а обновлять его пришлось бы
 * деплоем.
 *
 * В коде живёт только арифметика дедлайна готовности, потому что её надо
 * проверять тестом: дата готовности участвует в решении «успеваем ли к сезону»,
 * а ошибка на сутки в вычитании — самая частая в работе с датами.
 */

/**
 * Окно готовности из ТЗ §8.6: «за 4–8 недель» до праздника, в днях.
 *
 * Границы объявлены в днях, а не в неделях, чтобы сравнение с {@link
 * DEFAULT_READINESS_LEAD_DAYS} было прямым, без пересчёта в двух местах.
 */
export const READINESS_WINDOW_DAYS = { max: 56, min: 28 } as const;

/**
 * Запас по умолчанию: 45 дней до праздника (решение Ч-12, категория «Д» —
 * человек делегировал выбор). Значение внутри окна §8.6, поэтому дефолт не
 * противоречит норме; редактор вправе поставить свою дату.
 */
export const DEFAULT_READINESS_LEAD_DAYS = 45;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Дата, к которой подборка обязана быть готова.
 *
 * Считается вычитанием суток из момента праздника в UTC, а не через
 * `setDate`/локальное время: у полей `date` Payload значение хранится в UTC, и
 * локальный часовой пояс сервера сдвигал бы дедлайн на сутки в зависимости от
 * того, где запущен процесс.
 *
 * @param holidayDate дата праздника (ISO-строка или `Date`)
 * @param leadDays запас в днях; по умолчанию {@link DEFAULT_READINESS_LEAD_DAYS}
 * @returns ISO-строка даты готовности
 * @throws RangeError если дата не разбирается или запас некорректен
 */
export function readinessDeadline(
  holidayDate: Date | string,
  leadDays: number = DEFAULT_READINESS_LEAD_DAYS,
): string {
  const holiday = holidayDate instanceof Date ? holidayDate : new Date(holidayDate);
  const time = holiday.getTime();

  if (Number.isNaN(time)) {
    throw new RangeError(
      `Дата праздника «${String(holidayDate)}» не разбирается. Ожидается ISO-дата ` +
        'или Date: из неё считается дата готовности подборки (ТЗ §8.6).',
    );
  }

  if (!Number.isSafeInteger(leadDays) || leadDays < 1) {
    throw new RangeError(
      `Запас готовности должен быть целым числом дней >= 1, получено: ${String(leadDays)}.`,
    );
  }

  return new Date(time - leadDays * MILLISECONDS_PER_DAY).toISOString();
}

/** Попадает ли запас в окно ТЗ §8.6 («за 4–8 недель»). */
export function isWithinReadinessWindow(leadDays: number): boolean {
  return leadDays >= READINESS_WINDOW_DAYS.min && leadDays <= READINESS_WINDOW_DAYS.max;
}
