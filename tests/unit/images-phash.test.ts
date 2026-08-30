import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  comparePerceptualHashes,
  computePerceptualHash,
  DEFAULT_PHASH_DISTANCE_THRESHOLD,
  findSimilarPerceptualHashes,
  hammingDistance,
  PHASH_BITS,
  PHASH_DISTANCE_THRESHOLD_ENV_KEY,
} from '@otkritka/images';
import {
  createPatternJpeg,
  createPatternJpegWithExifOrientation,
  createPatternPng,
  createPatternWebpLossless,
  createRotatedPatternPng,
  ROTATED_180_TILE_LUMINANCE,
} from './fixtures/images.js';

// Э2-03, ТЗ §6.4 и §8.3.2: pHash считается при загрузке и сравнивается с уже
// опубликованными. Порог — параметр с утверждённым значением 14 (Ч-08, закрыт
// 2026-08-21). В тестах ниже он задаётся явно и НЕ равен утверждённому: эти
// проверки про механизм сравнения, а не про норму. Саму норму (дефолт 14)
// проверяет tests/unit/images-config.test.ts.
const TEST_THRESHOLD = 10;

const SOURCE = { width: 1400, height: 1050 } as const;

let basePng: Buffer;
let baseJpeg: Buffer;
let baseWebpLossless: Buffer;
let brightenedJpeg: Buffer;
let resizedPng: Buffer;
let otherCompositionPng: Buffer;
let rotated180Png: Buffer;

beforeAll(async () => {
  basePng = await createPatternPng(SOURCE);
  baseJpeg = await createPatternJpeg({ ...SOURCE, quality: 80 });
  baseWebpLossless = await createPatternWebpLossless(SOURCE);
  // «Похожее»: та же сцена после осветления и сильного сжатия.
  brightenedJpeg = await sharp(basePng).modulate({ brightness: 1.12 }).jpeg({ quality: 35 }).toBuffer();
  // «Похожее»: та же сцена в другом размере.
  resizedPng = await sharp(basePng).resize({ width: 640 }).png().toBuffer();
  // «Не похожее»: структурно другая композиция — радиальные кольца против
  // прямоугольной сетки. Не перестановка и не поворот того же кадра.
  otherCompositionPng = await createPatternPng({ ...SOURCE, composition: 'rings' });
  // Отдельный случай: тот же кадр, повёрнутый на 180°. Это дубль, а не другая
  // картинка, и мерить его нужно отдельно — иначе порог Ч-08 занижается.
  rotated180Png = await createPatternPng({ ...SOURCE, tiles: ROTATED_180_TILE_LUMINANCE });
});

describe('pHash: расчёт', () => {
  it('даёт 64-битный хеш в шестнадцатеричном виде', async () => {
    const hash = await computePerceptualHash(basePng);

    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(PHASH_BITS).toBe(64);
  });

  it('детерминирован: повторный вызов даёт тот же результат', async () => {
    const first = await computePerceptualHash(basePng);
    const second = await computePerceptualHash(basePng);

    expect(second).toBe(first);
  });

  it('ни расчёт, ни сравнение не требуют конфигурации (на реальном process.env)', async () => {
    // Смысл теста изменён решением Ч-08: раньше сравнение без настройки
    // отказывало, теперь берёт утверждённый порог 14. Дедупликация —
    // подсказка редактору, и молчать она не должна из-за пустого .env.
    const saved = process.env[PHASH_DISTANCE_THRESHOLD_ENV_KEY];
    delete process.env[PHASH_DISTANCE_THRESHOLD_ENV_KEY];
    try {
      const hash = await computePerceptualHash(basePng);
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
      expect(comparePerceptualHashes(hash, hash)).toEqual({
        distance: 0,
        threshold: DEFAULT_PHASH_DISTANCE_THRESHOLD,
        similar: true,
      });
    } finally {
      if (saved === undefined) {
        delete process.env[PHASH_DISTANCE_THRESHOLD_ENV_KEY];
      } else {
        process.env[PHASH_DISTANCE_THRESHOLD_ENV_KEY] = saved;
      }
    }
  });

  it('не зависит от EXIF-ориентации: запечённый поворот и тег дают один хеш', async () => {
    const bakedRotation = await createRotatedPatternPng({ ...SOURCE, angle: 90 });
    const byExifTag = await createPatternJpegWithExifOrientation({ ...SOURCE, orientation: 6 });

    const distance = hammingDistance(
      await computePerceptualHash(bakedRotation),
      await computePerceptualHash(byExifTag),
    );

    // Оба файла браузер показывает одинаково — визуальный дубль обязан
    // определяться, иначе повёрнутая копия проходит проверку на похожесть.
    expect(distance).toBeLessThan(TEST_THRESHOLD);
    expect(
      hammingDistance(
        await computePerceptualHash(basePng),
        await computePerceptualHash(byExifTag),
      ),
    ).toBeGreaterThan(distance);
  });

  it('не зависит от формата контейнера при том же содержимом', async () => {
    const fromPng = await computePerceptualHash(basePng);
    const fromWebpLossless = await computePerceptualHash(baseWebpLossless);
    const fromJpeg = await computePerceptualHash(baseJpeg);

    expect(fromWebpLossless).toBe(fromPng);
    expect(hammingDistance(fromPng, fromJpeg)).toBeLessThan(TEST_THRESHOLD);
  });
});

describe('pHash: расстояние Хэмминга как метрика', () => {
  it('d(x, x) = 0 и метрика симметрична', async () => {
    const a = await computePerceptualHash(basePng);
    const b = await computePerceptualHash(otherCompositionPng);

    expect(hammingDistance(a, a)).toBe(0);
    expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
  });

  it('считает расстояние по битам, а не по символам', () => {
    expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1);
    expect(hammingDistance('0000000000000000', '000000000000000f')).toBe(4);
    expect(hammingDistance('ffffffffffffffff', '0000000000000000')).toBe(PHASH_BITS);
  });

  it('отвергает значения, которые не являются pHash', () => {
    expect(() => hammingDistance('abc', 'abc')).toThrow(/pHash/i);
    expect(() => hammingDistance('zzzzzzzzzzzzzzzz', '0000000000000000')).toThrow(/pHash/i);
  });
});

describe('pHash: сравнение с порогом', () => {
  it('похожие изображения дают расстояние ниже порога', async () => {
    const base = await computePerceptualHash(basePng);

    for (const candidate of [brightenedJpeg, resizedPng, baseJpeg]) {
      const comparison = comparePerceptualHashes(base, await computePerceptualHash(candidate), {
        threshold: TEST_THRESHOLD,
      });

      expect(comparison.distance).toBeLessThan(TEST_THRESHOLD);
      expect(comparison.similar).toBe(true);
      expect(comparison.threshold).toBe(TEST_THRESHOLD);
    }
  });

  it('поворот кадра на 180° этот алгоритм дублем НЕ считает — известное ограничение', async () => {
    const base = await computePerceptualHash(basePng);
    const toRotated = hammingDistance(base, await computePerceptualHash(rotated180Png));

    // DCT-pHash не инвариантен к повороту: тот же кадр, повёрнутый на 180°,
    // уходит далеко за порог. Отсюда два следствия, которые нельзя путать:
    //   - повёрнутую копию редактору по pHash не покажут; это названо в решении
    //     Ч-08 как ограничение алгоритма, а не как настройка;
    //   - расстояние до повёрнутого кадра НЕЛЬЗЯ выдавать за расстояние до
    //     другого изображения при подборе порога — образец «другой картинки»
    //     это композиция `rings`, а не перестановка той же сетки.
    expect(toRotated).toBeGreaterThan(TEST_THRESHOLD);
  });

  it('непохожие изображения дают расстояние выше порога', async () => {
    const comparison = comparePerceptualHashes(
      await computePerceptualHash(basePng),
      await computePerceptualHash(otherCompositionPng),
      { threshold: TEST_THRESHOLD },
    );

    expect(comparison.distance).toBeGreaterThan(TEST_THRESHOLD);
    expect(comparison.similar).toBe(false);
  });

  it('порог читается из конфигурации: одна и та же пара меняет вердикт', async () => {
    const a = await computePerceptualHash(basePng);
    const b = await computePerceptualHash(brightenedJpeg);
    const distance = hammingDistance(a, b);
    expect(distance).toBeGreaterThan(0);

    const strict = comparePerceptualHashes(a, b, {
      env: { [PHASH_DISTANCE_THRESHOLD_ENV_KEY]: String(distance - 1) },
    });
    const loose = comparePerceptualHashes(a, b, {
      env: { [PHASH_DISTANCE_THRESHOLD_ENV_KEY]: String(distance) },
    });

    expect(strict.similar).toBe(false);
    expect(loose.similar).toBe(true);
    expect(strict.distance).toBe(loose.distance);
  });

  it('без настройки сравнивает по утверждённому порогу 14 (Ч-08)', async () => {
    const a = await computePerceptualHash(basePng);
    const b = await computePerceptualHash(otherCompositionPng);

    const comparison = comparePerceptualHashes(a, b, { env: {} });

    expect(comparison.threshold).toBe(DEFAULT_PHASH_DISTANCE_THRESHOLD);
    // Другая композиция дальше утверждённого порога: 14 выбран ниже 24.
    expect(comparison.distance).toBeGreaterThan(DEFAULT_PHASH_DISTANCE_THRESHOLD);
    expect(comparison.similar).toBe(false);
  });

  it('мусорное значение порога — ошибка, а не молчаливый возврат к дефолту', async () => {
    const a = await computePerceptualHash(basePng);
    const b = await computePerceptualHash(brightenedJpeg);

    for (const value of ['почти', '65', '-1', '10.5']) {
      expect(() =>
        comparePerceptualHashes(a, b, { env: { [PHASH_DISTANCE_THRESHOLD_ENV_KEY]: value } }),
      ).toThrow(/PHASH_DISTANCE_THRESHOLD/);
    }
    // То же для явной опции: сюда зовут из нетипизированного кода.
    for (const threshold of [-1, 65, 10.5, Number.NaN]) {
      expect(() => comparePerceptualHashes(a, b, { threshold })).toThrow(/порог/i);
    }
  });

  it('утверждённый порог 14 признаёт похожими перекодирование, ресайз и осветление', async () => {
    const base = await computePerceptualHash(basePng);

    for (const candidate of [brightenedJpeg, resizedPng, baseJpeg]) {
      const comparison = comparePerceptualHashes(base, await computePerceptualHash(candidate), {
        env: {},
      });

      expect(comparison.threshold).toBe(DEFAULT_PHASH_DISTANCE_THRESHOLD);
      expect(comparison.similar).toBe(true);
    }
  });
});

describe('pHash: поиск похожих среди уже опубликованных', () => {
  it('возвращает совпадения в порядке возрастания расстояния и не режет решение за редактора', async () => {
    const base = await computePerceptualHash(basePng);
    const candidates = [
      { id: 'other', hash: await computePerceptualHash(otherCompositionPng) },
      { id: 'brightened', hash: await computePerceptualHash(brightenedJpeg) },
      { id: 'same', hash: base },
    ];

    const matches = findSimilarPerceptualHashes(base, candidates, { threshold: TEST_THRESHOLD });

    expect(matches.map((match) => match.id)).toEqual(['same', 'brightened']);
    expect(matches[0]?.distance).toBe(0);
    // Непохожий кандидат отброшен, а не просто оказался в конце списка.
    expect(matches.map((match) => match.id)).not.toContain('other');
  });

  it('порядок при равном расстоянии детерминирован по кодовым точкам, а не по локали', async () => {
    const base = await computePerceptualHash(basePng);
    // localeCompare в большинстве локалей ставит 'a' перед 'B'; сравнение по
    // кодовым точкам — наоборот. Модуль обещает детерминизм, значит порядок не
    // должен зависеть от локали и сборки ICU.
    const candidates = [
      { id: 'a-kartochka', hash: base },
      { id: 'B-kartochka', hash: base },
      { id: '1-kartochka', hash: base },
    ];

    const matches = findSimilarPerceptualHashes(base, candidates, { threshold: TEST_THRESHOLD });

    expect(matches.map((match) => match.id)).toEqual([
      '1-kartochka',
      'B-kartochka',
      'a-kartochka',
    ]);
  });

  it('без настройки ищет по утверждённому порогу, а не отказывает', async () => {
    const base = await computePerceptualHash(basePng);
    const candidates = [
      { id: 'other', hash: await computePerceptualHash(otherCompositionPng) },
      { id: 'same', hash: base },
    ];

    const matches = findSimilarPerceptualHashes(base, candidates, { env: {} });

    expect(matches.map((match) => match.id)).toEqual(['same']);
    expect(findSimilarPerceptualHashes(base, [], { env: {} })).toEqual([]);
  });

  it('поворот на 180° не находится и при утверждённом пороге — ограничение алгоритма', async () => {
    const base = await computePerceptualHash(basePng);
    const candidates = [{ id: 'rotated-180', hash: await computePerceptualHash(rotated180Png) }];

    // Не настройка: по DCT-pHash повёрнутый дубль редактору не покажут ни при
    // каком пороге из допустимого диапазона (замеры: 180° — 28, 90° — 36).
    expect(findSimilarPerceptualHashes(base, candidates, { env: {} })).toEqual([]);
  });
});
