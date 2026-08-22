import { afterEach, describe, expect, it } from 'vitest';
import * as imagesPackage from '@otkritka/images';
import {
  comparePerceptualHashes,
  DEFAULT_ENCODE_QUALITY,
  DEFAULT_PHASH_DISTANCE_THRESHOLD,
  findSimilarPerceptualHashes,
  IMAGE_ENCODE_QUALITY_ENV_KEY,
  IMAGE_WIDTHS,
  MIN_SOURCE_IMAGE_WIDTH,
  OUTPUT_FORMATS,
  PHASH_BITS,
  PHASH_DISTANCE_THRESHOLD_ENV_KEY,
  resolveDerivativeWidths,
  resolveEncodeQuality,
  resolvePhashDistanceThreshold,
} from '@otkritka/images';

/**
 * Подмена process.env на время теста. Ветка «аргумент не передан» — та самая,
 * что работает в продакшене, поэтому проверяется отдельно от срезов окружения.
 */
const savedEnv: Record<string, string | undefined> = {};

function setProcessEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) {
    savedEnv[key] = process.env[key];
  }
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
    delete savedEnv[key];
  }
});

// Конфигурация пайплайна изображений. Оба вопроса закрыты человеком 2026-08-21:
// набор ширин (Ч-09) — 320/640/960/1280/1920 окончательно, добавление
// запрещено; порог pHash (Ч-08) — 14, с возможностью переопределить настройкой.
describe('конфигурация: набор ширин окончателен (Ч-09)', () => {
  it('набор — константа пакета: 320/640/960/1280/1920, защищена от правки', () => {
    expect(IMAGE_WIDTHS).toEqual([320, 640, 960, 1280, 1920]);
    expect(Object.isFrozen(IMAGE_WIDTHS)).toBe(true);
  });

  it('без аргумента отдаёт весь набор, и каждый вызов — свежая копия', () => {
    const first = resolveDerivativeWidths();
    const second = resolveDerivativeWidths();

    expect(first).toEqual([...IMAGE_WIDTHS]);
    expect(first).not.toBe(second);
    expect(first).not.toBe(IMAGE_WIDTHS);
  });

  it('набор НЕЛЬЗЯ расширить через окружение: переменной IMAGE_WIDTHS больше нет', () => {
    // Проверка по поведению: любое значение в окружении набор не меняет.
    setProcessEnv('IMAGE_WIDTHS', '400,800,3840');
    expect(resolveDerivativeWidths()).toEqual([...IMAGE_WIDTHS]);

    // И дополнительно по API: ключа окружения для набора ширин пакет не
    // экспортирует — иначе «добавление запрещено» нечем проверить.
    const suspicious = Object.keys(imagesPackage).filter((name) =>
      /WIDTHS.*ENV|ENV.*WIDTHS/i.test(name),
    );
    expect(suspicious).toEqual([]);
  });

  it('добавление ширины отклоняется, даже если она «разумная»', () => {
    for (const widths of [
      [320, 400],
      [320, 3840],
      [320, 640, 641],
      [200, 320],
    ]) {
      expect(() => resolveDerivativeWidths(widths), widths.join(',')).toThrow(/добавл/i);
    }
  });

  it('сужение до подмножества разрешено', () => {
    expect(resolveDerivativeWidths([640, 320])).toEqual([320, 640]);
    expect(resolveDerivativeWidths([320])).toEqual([320]);
    expect(resolveDerivativeWidths([320, 320, 1920])).toEqual([320, 1920]);
    // Ровно порог исходника — граница включительно.
    expect(resolveDerivativeWidths([640])).toEqual([640]);
  });

  it('сужение не поднимает минимальную ширину выше порога исходника', () => {
    // Иначе допустимый по порогу исходник (640 px) снова не попадал бы ни в
    // одну ширину, включался бы nativeWidthFallback и ключ снова зависел бы от
    // набора настроек (условие C7).
    for (const widths of [[960], [960, 1280], [1920]]) {
      expect(() => resolveDerivativeWidths(widths), widths.join(',')).toThrow(
        new RegExp(String(MIN_SOURCE_IMAGE_WIDTH)),
      );
    }
  });

  it('пустое сужение отклоняется', () => {
    expect(() => resolveDerivativeWidths([])).toThrow(/пуст/i);
  });

  it('минимальная ширина набора не превышает порога исходника — отсюда недостижимость fallback', () => {
    expect(MIN_SOURCE_IMAGE_WIDTH).toBe(640);
    expect(Math.min(...IMAGE_WIDTHS)).toBeLessThanOrEqual(MIN_SOURCE_IMAGE_WIDTH);
    expect(IMAGE_WIDTHS).toContain(MIN_SOURCE_IMAGE_WIDTH);
  });
});

describe('конфигурация: порог pHash (PHASH_DISTANCE_THRESHOLD, Ч-08 закрыт)', () => {
  it('без настройки берёт утверждённое значение 14, а не отказывает', () => {
    expect(DEFAULT_PHASH_DISTANCE_THRESHOLD).toBe(14);
    expect(resolvePhashDistanceThreshold({})).toBe(DEFAULT_PHASH_DISTANCE_THRESHOLD);
    expect(resolvePhashDistanceThreshold({ [PHASH_DISTANCE_THRESHOLD_ENV_KEY]: '' })).toBe(14);
    expect(resolvePhashDistanceThreshold({ [PHASH_DISTANCE_THRESHOLD_ENV_KEY]: '   ' })).toBe(14);
  });

  it('дефолт лежит в вилке замеров 12 ≤ порог < 24', () => {
    expect(DEFAULT_PHASH_DISTANCE_THRESHOLD).toBeGreaterThanOrEqual(12);
    expect(DEFAULT_PHASH_DISTANCE_THRESHOLD).toBeLessThan(24);
  });

  it('читает целое значение из окружения', () => {
    expect(resolvePhashDistanceThreshold({ [PHASH_DISTANCE_THRESHOLD_ENV_KEY]: '10' })).toBe(10);
    expect(resolvePhashDistanceThreshold({ [PHASH_DISTANCE_THRESHOLD_ENV_KEY]: ' 0 ' })).toBe(0);
  });

  it('мусорное значение — ошибка, а не молчаливая подмена дефолтом', () => {
    for (const value of ['-1', '65', '4.5', 'близко', '14,15']) {
      expect(() =>
        resolvePhashDistanceThreshold({ [PHASH_DISTANCE_THRESHOLD_ENV_KEY]: value }),
      ).toThrow(/PHASH_DISTANCE_THRESHOLD/);
    }
    expect(PHASH_BITS).toBe(64);
  });

  it('на пустом окружении сравнение работает и берёт дефолт (подсказка, а не блокировка)', () => {
    const hash = '0'.repeat(16);
    setProcessEnv(PHASH_DISTANCE_THRESHOLD_ENV_KEY, undefined);

    expect(comparePerceptualHashes(hash, hash).threshold).toBe(DEFAULT_PHASH_DISTANCE_THRESHOLD);
    expect(findSimilarPerceptualHashes(hash, [{ id: 'a', hash }])).toHaveLength(1);
  });

  it('читает порог из process.env, когда срез окружения не передан', () => {
    setProcessEnv(PHASH_DISTANCE_THRESHOLD_ENV_KEY, '7');
    expect(resolvePhashDistanceThreshold()).toBe(7);

    setProcessEnv(PHASH_DISTANCE_THRESHOLD_ENV_KEY, '99');
    expect(() => resolvePhashDistanceThreshold()).toThrow(/PHASH_DISTANCE_THRESHOLD/);
  });
});

describe('конфигурация: чтение process.env — ветка, которая работает в продакшене', () => {
  it('качество берётся из process.env, когда срез окружения не передан', () => {
    setProcessEnv(IMAGE_ENCODE_QUALITY_ENV_KEY, 'jpeg=70');
    expect(resolveEncodeQuality().jpeg).toBe(70);

    setProcessEnv(IMAGE_ENCODE_QUALITY_ENV_KEY, undefined);
    expect(resolveEncodeQuality()).toEqual(DEFAULT_ENCODE_QUALITY);
  });
});

describe('конфигурация: качество кодирования (IMAGE_ENCODE_QUALITY, Ч-29 закрыт)', () => {
  it('без переменной отдаёт утверждённые значения по всем форматам вывода', () => {
    const quality = resolveEncodeQuality({});

    expect(Object.keys(quality).sort()).toEqual([...OUTPUT_FORMATS].sort());
    for (const format of OUTPUT_FORMATS) {
      expect(quality[format]).toBe(DEFAULT_ENCODE_QUALITY[format]);
    }
    // Решение Ч-29: avif 50 / webp 80 / jpeg 82.
    expect(DEFAULT_ENCODE_QUALITY).toEqual({ avif: 50, webp: 80, jpeg: 82 });
  });

  it('переопределяет только указанные форматы', () => {
    const quality = resolveEncodeQuality({ [IMAGE_ENCODE_QUALITY_ENV_KEY]: 'avif=40, jpeg=70' });

    expect(quality.avif).toBe(40);
    expect(quality.jpeg).toBe(70);
    expect(quality.webp).toBe(DEFAULT_ENCODE_QUALITY.webp);
  });

  it('не подменяет дефолтом мусорное значение', () => {
    for (const value of ['jpeg', 'jpeg=', 'jpeg=0', 'jpeg=101', 'jpeg=82.5', 'gif=50', '=50']) {
      expect(() => resolveEncodeQuality({ [IMAGE_ENCODE_QUALITY_ENV_KEY]: value })).toThrow(
        /IMAGE_ENCODE_QUALITY/,
      );
    }
  });

  it('дефолты защищены от правки и остаются в рабочем диапазоне', () => {
    expect(Object.isFrozen(DEFAULT_ENCODE_QUALITY)).toBe(true);
    for (const format of OUTPUT_FORMATS) {
      expect(DEFAULT_ENCODE_QUALITY[format]).toBeGreaterThan(0);
      expect(DEFAULT_ENCODE_QUALITY[format]).toBeLessThanOrEqual(100);
    }
  });
});
