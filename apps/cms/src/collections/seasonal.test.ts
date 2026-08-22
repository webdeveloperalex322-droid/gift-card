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
  isWithinReadinessWindow,
  readinessDeadline,
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
