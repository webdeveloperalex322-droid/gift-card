/**
 * Сезонное планирование подборки (ТЗ §8.6, решение Ч-12).
 *
 * Проверяется арифметика дедлайна и то, что дефолт 45 дней лежит внутри окна
 * «4–8 недель» из ТЗ: расхождение дефолта с нормой — это сорванный сезон,
 * который не проявится ни ошибкой сборки, ни падением теста в другом месте.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_READINESS_LEAD_DAYS,
  READINESS_WINDOW_DAYS,
  SEASONAL_UPCOMING_DAYS,
  isWithinReadinessWindow,
  readinessDeadline,
  seasonalDeadline,
  seasonalShowWindowIssue,
} from './seasonal';

describe('дедлайн готовности подборки', () => {
  it('по умолчанию — 45 дней до праздника (Ч-12)', () => {
    expect(DEFAULT_READINESS_LEAD_DAYS).toBe(45);
    expect(readinessDeadline('2027-03-08T00:00:00.000Z')).toBe('2027-01-22T00:00:00.000Z');
  });

  it('считается в UTC, а не в локальном поясе процесса', () => {
    // Иначе дедлайн зависел бы от того, где запущен сервер, и «за 45 дней»
    // означало бы разные сутки на разработке и на production.
    expect(readinessDeadline(new Date('2027-01-01T00:00:00.000Z'))).toBe(
      '2026-11-17T00:00:00.000Z',
    );
  });

  it('переход через февраль и границу года считается календарно', () => {
    expect(readinessDeadline('2028-02-29T00:00:00.000Z', 60)).toBe('2027-12-31T00:00:00.000Z');
  });

  it('запас можно задать явно', () => {
    expect(readinessDeadline('2027-05-09T00:00:00.000Z', 28)).toBe('2027-04-11T00:00:00.000Z');
  });

  it('нераспознанная дата и некорректный запас — громкая ошибка', () => {
    expect(() => readinessDeadline('8 марта')).toThrow(RangeError);
    expect(() => readinessDeadline('2027-03-08T00:00:00.000Z', 0)).toThrow(RangeError);
    expect(() => readinessDeadline('2027-03-08T00:00:00.000Z', 1.5)).toThrow(RangeError);
  });
});

describe('окно готовности ТЗ §8.6', () => {
  it('окно — 4–8 недель в днях', () => {
    expect(READINESS_WINDOW_DAYS.min).toBe(4 * 7);
    expect(READINESS_WINDOW_DAYS.max).toBe(8 * 7);
  });

  it('дефолт Ч-12 лежит внутри окна', () => {
    expect(isWithinReadinessWindow(DEFAULT_READINESS_LEAD_DAYS)).toBe(true);
  });

  it('за пределами окна — false на обеих границах', () => {
    expect(isWithinReadinessWindow(READINESS_WINDOW_DAYS.min - 1)).toBe(false);
    expect(isWithinReadinessWindow(READINESS_WINDOW_DAYS.max + 1)).toBe(false);
  });
});

describe('состояние сезонного дедлайна (Э5-07, дашборд ТЗ §8.6)', () => {
  const now = new Date('2027-01-22T09:41:00.000Z');

  it('ровно 45 дней до праздника — это сегодняшний дедлайн, а не просрочка', () => {
    // День в день: дефолт Ч-12 отсчитан от 8 марта, «сегодня» — 22 января.
    const deadline = seasonalDeadline(
      { holidayDate: '2027-03-08T00:00:00.000Z', readyBy: '2027-01-22T00:00:00.000Z' },
      now,
    );
    expect(deadline.daysLeft).toBe(0);
    expect(deadline.state).toBe('upcoming');
  });

  it('вчерашний дедлайн у черновика — сорван', () => {
    const deadline = seasonalDeadline(
      { holidayDate: '2027-03-08T00:00:00.000Z', readyBy: '2027-01-21T00:00:00.000Z' },
      now,
    );
    expect(deadline.daysLeft).toBe(-1);
    expect(deadline.state).toBe('overdue');
  });

  it('дедлайн дальше окна «приближается» — просто запланирован', () => {
    const far = seasonalDeadline({ readyBy: '2027-03-01T00:00:00.000Z' }, now);
    expect(far.state).toBe('planned');
    expect(far.daysLeft).toBe(38);

    const edge = seasonalDeadline(
      { readyBy: new Date(now.getTime() + SEASONAL_UPCOMING_DAYS * 24 * 60 * 60 * 1000) },
      now,
    );
    expect(edge.daysLeft).toBe(SEASONAL_UPCOMING_DAYS);
    expect(edge.state).toBe('upcoming');
  });

  it('запись, дошедшая до review или published, дедлайн не срывает', () => {
    // Готовность — это состояние КОНТЕНТА. Требовать `published` значило бы, что
    // дашборд подгоняет человека публиковать, а публикация — только его решение.
    for (const status of ['review', 'published']) {
      const deadline = seasonalDeadline({ readyBy: '2026-12-01T00:00:00.000Z', status }, now);
      expect(deadline.state).toBe('ready');
    }
  });

  it('дата готовности не задана — состояние «не запланировано», а не «сорвано»', () => {
    const nothing = seasonalDeadline({}, now);
    expect(nothing.state).toBe('not-planned');
    expect(nothing.daysLeft).toBeNull();
    expect(nothing.readyBy).toBeNull();
  });

  it('задан только праздник — дедлайн выводится из него по Ч-12', () => {
    // Поле `readyBy` заполняет хук при сохранении, но запись могла быть заведена
    // до появления хука или через частичное обновление: считать по празднику
    // честнее, чем показать «не запланировано» у подборки с назначенной датой.
    const deadline = seasonalDeadline({ holidayDate: '2027-03-08T00:00:00.000Z' }, now);
    expect(deadline.readyBy).toBe('2027-01-22T00:00:00.000Z');
    expect(deadline.readyByDerived).toBe(true);
    expect(deadline.state).toBe('upcoming');
  });

  it('задана только дата готовности — праздник неизвестен, и это не мешает', () => {
    const deadline = seasonalDeadline({ readyBy: '2027-01-25T00:00:00.000Z' }, now);
    expect(deadline.holidayDate).toBeNull();
    expect(deadline.holidayPassed).toBe(false);
    expect(deadline.readyByDerived).toBe(false);
    expect(deadline.state).toBe('upcoming');
  });

  it('прошедшая дата праздника названа прямо: обновляется дата, а не URL', () => {
    // Ежегодный праздник живёт по одному адресу навсегда (правило URL), поэтому
    // ответ на прошедшую дату — новая дата в той же записи, а не новый узел.
    const deadline = seasonalDeadline(
      { holidayDate: '2026-03-08T00:00:00.000Z', readyBy: '2026-01-22T00:00:00.000Z' },
      now,
    );
    expect(deadline.holidayPassed).toBe(true);
  });

  it('мусор в датах не притворяется дедлайном', () => {
    const deadline = seasonalDeadline({ holidayDate: '8 марта', readyBy: '' }, now);
    expect(deadline.state).toBe('not-planned');
    expect(deadline.holidayDate).toBeNull();
  });
});

describe('окно показа сезонного блока (та же трактовка пустоты, что на главной)', () => {
  it('обе границы заданы — претензий нет', () => {
    expect(
      seasonalShowWindowIssue({
        showFrom: '2027-02-01T00:00:00.000Z',
        showUntil: '2027-03-09T00:00:00.000Z',
      }),
    ).toBeNull();
  });

  it('обе границы пусты — «показывать не по календарю», а не ошибка', () => {
    expect(seasonalShowWindowIssue({})).toBeNull();
  });

  it('заполнена одна граница — блок не покажется, и это стоит увидеть', () => {
    expect(seasonalShowWindowIssue({ showFrom: '2027-02-01T00:00:00.000Z' })).toBe('half-set');
    expect(seasonalShowWindowIssue({ showUntil: '2027-03-09T00:00:00.000Z' })).toBe('half-set');
  });

  it('перевёрнутое окно — опечатка, а не окно', () => {
    expect(
      seasonalShowWindowIssue({
        showFrom: '2027-03-09T00:00:00.000Z',
        showUntil: '2027-02-01T00:00:00.000Z',
      }),
    ).toBe('inverted');
  });
});
