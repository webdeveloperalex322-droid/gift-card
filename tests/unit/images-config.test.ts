import { afterEach, describe, expect, it } from 'vitest';
import * as imagesPackage from '@otkritka/images';
import {
  comparePerceptualHashes,
  DEFAULT_ENCODE_QUALITY,
  DEFAULT_IMAGE_WIDTHS,
  findSimilarPerceptualHashes,
  IMAGE_ENCODE_QUALITY_ENV_KEY,
  IMAGE_WIDTHS_ENV_KEY,
  OUTPUT_FORMATS,
  PHASH_BITS,
  PHASH_DISTANCE_THRESHOLD_ENV_KEY,
  resolveEncodeQuality,
  resolveImageWidths,
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

// Конфигурация пайплайна изображений: набор ширин (Ч-09) и порог pHash (Ч-08).
// Оба вопроса человеком не закрыты, поэтому проверяется именно механизм:
// ширины — параметр с документированным дефолтом из примера ТЗ §6.2,
// порог — параметр БЕЗ дефолта, потому что числа нет ни в ТЗ, ни в решениях.
describe('конфигурация: набор ширин (IMAGE_WIDTHS, Ч-09)', () => {
  it('без переменной окружения отдаёт документированный ряд из примера ТЗ §6.2', () => {
    expect(resolveImageWidths({})).toEqual([320, 640, 960, 1280, 1920]);
    expect(DEFAULT_IMAGE_WIDTHS).toEqual([320, 640, 960, 1280, 1920]);
  });

  it('пустое значение читает как «не сконфигурировано» и берёт дефолт', () => {
    expect(resolveImageWidths({ [IMAGE_WIDTHS_ENV_KEY]: '   ' })).toEqual(DEFAULT_IMAGE_WIDTHS);
  });

  it('читает ширины из окружения, сортирует и убирает повторы', () => {
    expect(resolveImageWidths({ [IMAGE_WIDTHS_ENV_KEY]: '960, 480,960' })).toEqual([480, 960]);
  });

  it('не подменяет дефолтом мусорное значение, а сообщает об ошибке', () => {
    expect(() => resolveImageWidths({ [IMAGE_WIDTHS_ENV_KEY]: '640,abc' })).toThrow(
      /IMAGE_WIDTHS/,
    );
    expect(() => resolveImageWidths({ [IMAGE_WIDTHS_ENV_KEY]: '0' })).toThrow(/IMAGE_WIDTHS/);
    expect(() => resolveImageWidths({ [IMAGE_WIDTHS_ENV_KEY]: '-640' })).toThrow(/IMAGE_WIDTHS/);
    expect(() => resolveImageWidths({ [IMAGE_WIDTHS_ENV_KEY]: '640.5' })).toThrow(/IMAGE_WIDTHS/);
  });

  it('отдаёт свежую копию, а сам дефолт защищён от правки', () => {
    const first = resolveImageWidths({});
    const second = resolveImageWidths({});
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(Object.isFrozen(DEFAULT_IMAGE_WIDTHS)).toBe(true);
  });
});

describe('конфигурация: порог pHash (PHASH_DISTANCE_THRESHOLD, Ч-08)', () => {
  it('без заданного порога отказывает с внятной ошибкой, а не берёт число из кода', () => {
    expect(() => resolvePhashDistanceThreshold({})).toThrow(/PHASH_DISTANCE_THRESHOLD/);
    expect(() => resolvePhashDistanceThreshold({})).toThrow(/Ч-08/);
    expect(() => resolvePhashDistanceThreshold({ [PHASH_DISTANCE_THRESHOLD_ENV_KEY]: '' })).toThrow(
      /PHASH_DISTANCE_THRESHOLD/,
    );
  });

  it('читает целое значение из окружения', () => {
    expect(resolvePhashDistanceThreshold({ [PHASH_DISTANCE_THRESHOLD_ENV_KEY]: '10' })).toBe(10);
    expect(resolvePhashDistanceThreshold({ [PHASH_DISTANCE_THRESHOLD_ENV_KEY]: ' 0 ' })).toBe(0);
  });

  it('отвергает значения вне диапазона расстояния Хэмминга и нецелые', () => {
    for (const value of ['-1', '65', '4.5', 'близко']) {
      expect(() =>
        resolvePhashDistanceThreshold({ [PHASH_DISTANCE_THRESHOLD_ENV_KEY]: value }),
      ).toThrow(/PHASH_DISTANCE_THRESHOLD/);
    }
    expect(PHASH_BITS).toBe(64);
  });

  it('дефолта порога нет нигде: на пустом окружении отказывает КАЖДАЯ функция сравнения', () => {
    // Основное доказательство — поведение, а не имена экспортов: функция с
    // безобидным названием, но с зашитым числом, провалит именно этот тест.
    const hash = '0'.repeat(16);
    setProcessEnv(PHASH_DISTANCE_THRESHOLD_ENV_KEY, undefined);

    expect(() => comparePerceptualHashes(hash, hash)).toThrow(/PHASH_DISTANCE_THRESHOLD/);
    expect(() => findSimilarPerceptualHashes(hash, [{ id: 'a', hash }])).toThrow(
      /PHASH_DISTANCE_THRESHOLD/,
    );
  });

  it('дополнительно: имени с дефолтом порога в публичном API тоже нет', () => {
    const suspicious = Object.keys(imagesPackage).filter(
      (name) => /phash/i.test(name) && /default|threshold_value|fallback/i.test(name),
    );
    expect(suspicious).toEqual([]);
  });

  it('читает порог из process.env, когда срез окружения не передан', () => {
    setProcessEnv(PHASH_DISTANCE_THRESHOLD_ENV_KEY, '7');
    expect(resolvePhashDistanceThreshold()).toBe(7);

    setProcessEnv(PHASH_DISTANCE_THRESHOLD_ENV_KEY, '99');
    expect(() => resolvePhashDistanceThreshold()).toThrow(/PHASH_DISTANCE_THRESHOLD/);
  });
});

describe('конфигурация: чтение process.env — ветка, которая работает в продакшене', () => {
  it('ширины берутся из process.env, когда срез окружения не передан', () => {
    setProcessEnv(IMAGE_WIDTHS_ENV_KEY, '480,960');
    expect(resolveImageWidths()).toEqual([480, 960]);

    setProcessEnv(IMAGE_WIDTHS_ENV_KEY, undefined);
    expect(resolveImageWidths()).toEqual(DEFAULT_IMAGE_WIDTHS);

    setProcessEnv(IMAGE_WIDTHS_ENV_KEY, 'широко');
    expect(() => resolveImageWidths()).toThrow(/IMAGE_WIDTHS/);
  });

  it('качество берётся из process.env, когда срез окружения не передан', () => {
    setProcessEnv(IMAGE_ENCODE_QUALITY_ENV_KEY, 'jpeg=70');
    expect(resolveEncodeQuality().jpeg).toBe(70);

    setProcessEnv(IMAGE_ENCODE_QUALITY_ENV_KEY, undefined);
    expect(resolveEncodeQuality()).toEqual(DEFAULT_ENCODE_QUALITY);
  });
});

describe('конфигурация: качество кодирования (IMAGE_ENCODE_QUALITY)', () => {
  it('без переменной отдаёт дефолты по всем форматам вывода', () => {
    const quality = resolveEncodeQuality({});

    expect(Object.keys(quality).sort()).toEqual([...OUTPUT_FORMATS].sort());
    for (const format of OUTPUT_FORMATS) {
      expect(quality[format]).toBe(DEFAULT_ENCODE_QUALITY[format]);
    }
  });

  it('переопределяет только указанные форматы', () => {
    const quality = resolveEncodeQuality({ [IMAGE_ENCODE_QUALITY_ENV_KEY]: 'avif=40, jpeg=70' });

    expect(quality.avif).toBe(40);
    expect(quality.jpeg).toBe(70);
    expect(quality.webp).toBe(DEFAULT_ENCODE_QUALITY.webp);
  });

  it('не подменяет дефолтом мусорное значение', () => {
    for (const value of ['jpeg', 'jpeg=', 'jpeg=0', 'jpeg=101', 'jpeg=82.5', 'gif=50', '=50']) {
      expect(() =>
        resolveEncodeQuality({ [IMAGE_ENCODE_QUALITY_ENV_KEY]: value }),
      ).toThrow(/IMAGE_ENCODE_QUALITY/);
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
