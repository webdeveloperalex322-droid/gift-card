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

/* ------------------------------------------------------------------ */
/* Состояние дедлайна для дашборда (задача Э5-07)                      */
/* ------------------------------------------------------------------ */

/**
 * За сколько дней до дедлайна он считается ПРИБЛИЖАЮЩИМСЯ.
 *
 * ПРОВЕНАНС: выбор агента, не решение человека (кандидат в реестр решений рядом
 * с `MAX_BATCH_SELECTION`, `MAX_INVENTORY_ROWS` и `MAX_LISTED_META_CONFLICTS`).
 * Норма задаёт только сам дедлайн (Ч-12: 45 дней до праздника) и окно §8.6
 * (4–8 недель); за сколько дней о нём напоминать, не сказано нигде.
 *
 * Почему 14. Дашборд обязан сообщить о приближении раньше, чем поправить дело
 * станет нельзя: наполнение подборки до порога Ч-06 (20 открыток) — это работа
 * не на один день. Меньшее значение превращает предупреждение в уведомление о
 * свершившемся факте, большее — держит в списке половину календаря, и список
 * перестают читать.
 */
export const SEASONAL_UPCOMING_DAYS = 14;

/**
 * Статусы, в которых контент подборки считается ГОТОВЫМ к сезону.
 *
 * `review` входит намеренно. Дата готовности — это дата готовности КОНТЕНТА, а
 * не дата публикации: публикация остаётся решением человека (п. 7.1 и п. 23),
 * и дашборд, который считал бы сорванным дедлайн у проверенной подборки, ещё не
 * выпущенной человеком, подталкивал бы к публикации по календарю. Ровно от этого
 * страхует статусная модель, поэтому граница здесь проходит по `review`.
 */
export const SEASONAL_READY_STATUSES: readonly string[] = ['published', 'review'];

/** Состояние дедлайна готовности одной подборки. */
export type SeasonalDeadlineState =
  /** Дата готовности не задана и не выводится: планирования по календарю нет. */
  | 'not-planned'
  /** Дедлайн прошёл, а контент не дошёл даже до `review`. */
  | 'overdue'
  /** Дедлайн дальше окна {@link SEASONAL_UPCOMING_DAYS}. */
  | 'planned'
  /** Контент дошёл до `review` или `published` — дедлайн снят. */
  | 'ready'
  /** Дедлайн наступает в ближайшие {@link SEASONAL_UPCOMING_DAYS} дней. */
  | 'upcoming';

/** Что не так с окном показа сезонного блока; `null` — претензий нет. */
export type SeasonalShowWindowIssue = 'half-set' | 'inverted' | null;

/** Поля `seasonal.*` записи плюс её статус — всё, из чего считается состояние. */
export interface SeasonalRecordFacts {
  readonly holidayDate?: unknown;
  readonly readyBy?: unknown;
  readonly showFrom?: unknown;
  readonly showUntil?: unknown;
  readonly status?: unknown;
}

export interface SeasonalDeadline {
  /** Сутки до дедлайна; отрицательное — просрочено; `null` — дедлайна нет. */
  readonly daysLeft: number | null;
  /** ISO-дата праздника или `null`, если не задана либо не разбирается. */
  readonly holidayDate: string | null;
  /** Дата праздника уже прошла: её обновляет редактор, URL при этом не меняется. */
  readonly holidayPassed: boolean;
  /** ISO-дата готовности: своя из записи либо выведенная из праздника. */
  readonly readyBy: string | null;
  /** `true` — дата готовности не хранится в записи, а выведена по Ч-12. */
  readonly readyByDerived: boolean;
  readonly showWindow: SeasonalShowWindowIssue;
  readonly state: SeasonalDeadlineState;
}

/** Момент из значения поля даты либо `null`: пусто, пробелы, мусор. */
function parseDate(value: unknown): Date | null {
  const raw = value instanceof Date ? value : typeof value === 'string' ? value.trim() : '';
  if (raw === '') {
    return null;
  }
  const date = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Полночь UTC того же дня. Сравнение идёт по суткам: у полей стоит `dayOnly`. */
function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Целых суток от `from` до `to`; отрицательное — `to` в прошлом. */
function wholeDaysBetween(from: Date, to: Date): number {
  return Math.round((startOfUtcDay(to) - startOfUtcDay(from)) / MILLISECONDS_PER_DAY);
}

/**
 * Что не так с окном показа сезонного блока.
 *
 * Трактовка пустоты здесь ТА ЖЕ, что на главной (`apps/web`,
 * `seasonalWindowContains`): блок показывается только при ОБЕИХ границах, а
 * пустое поле означает «показывать не по календарю». Поэтому пустое окно
 * претензией не является, а заполненная наполовину граница — является: редактор
 * назначил дату и вправе ожидать показа, которого не будет. Второй трактовки
 * пустоты в проекте нет и заводить её нельзя.
 */
export function seasonalShowWindowIssue(facts: SeasonalRecordFacts): SeasonalShowWindowIssue {
  const from = parseDate(facts.showFrom);
  const until = parseDate(facts.showUntil);
  if (from === null && until === null) {
    return null;
  }
  if (from === null || until === null) {
    return 'half-set';
  }
  return startOfUtcDay(from) > startOfUtcDay(until) ? 'inverted' : null;
}

/**
 * Состояние дедлайна готовности подборки на момент `now`.
 *
 * `now` — АРГУМЕНТ, а не `new Date()` внутри: дашборд считает состояние на
 * момент отрисовки, а тест обязан задавать день сам. Тот же приём, что у
 * `seasonalWindowContains` в `apps/web`.
 *
 * Дата готовности берётся из записи, а если её там нет — ВЫВОДИТСЯ из даты
 * праздника по Ч-12 (45 дней). Поле `readyBy` заполняет хук при сохранении, но
 * запись могла быть заведена раньше хука; показать «не запланировано» у
 * подборки с назначенной датой праздника значило бы промолчать о сезоне,
 * который уже идёт. Выведенное значение помечено `readyByDerived`, чтобы
 * дашборд не выдавал его за введённое человеком.
 *
 * Прошедшая дата праздника отмечается отдельно и НЕ порождает предложения
 * завести узел с годом: год в URL ежегодного праздника не добавляется (правило
 * URL), даты — это данные записи, и обновляются они в ней же.
 */
export function seasonalDeadline(facts: SeasonalRecordFacts, now: Date): SeasonalDeadline {
  const holiday = parseDate(facts.holidayDate);
  const stored = parseDate(facts.readyBy);
  const derived =
    stored === null && holiday !== null ? new Date(readinessDeadline(holiday)) : null;
  const deadline = stored ?? derived;
  const showWindow = seasonalShowWindowIssue(facts);
  const holidayPassed = holiday !== null && wholeDaysBetween(now, holiday) < 0;
  const shared = {
    holidayDate: holiday === null ? null : holiday.toISOString(),
    holidayPassed,
    readyBy: deadline === null ? null : deadline.toISOString(),
    readyByDerived: derived !== null,
    showWindow,
  };

  if (deadline === null) {
    return { ...shared, daysLeft: null, state: 'not-planned' };
  }

  const daysLeft = wholeDaysBetween(now, deadline);
  const status = typeof facts.status === 'string' ? facts.status : '';
  if (SEASONAL_READY_STATUSES.includes(status)) {
    return { ...shared, daysLeft, state: 'ready' };
  }
  if (daysLeft < 0) {
    return { ...shared, daysLeft, state: 'overdue' };
  }
  return { ...shared, daysLeft, state: daysLeft <= SEASONAL_UPCOMING_DAYS ? 'upcoming' : 'planned' };
}

/** Требует ли состояние внимания редактора: приближается или сорвано (ТЗ §8.6). */
export function isSeasonalAlert(deadline: SeasonalDeadline): boolean {
  return deadline.state === 'overdue' || deadline.state === 'upcoming';
}
