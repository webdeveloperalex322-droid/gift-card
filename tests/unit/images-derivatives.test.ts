import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  buildDerivativeObjectKey,
  computePerceptualHash,
  DEFAULT_ENCODE_QUALITY,
  DEFAULT_IMAGE_WIDTHS,
  FALLBACK_FORMAT,
  generateDerivatives,
  hammingDistance,
  IMAGE_ENCODE_QUALITY_ENV_KEY,
  IMAGE_WIDTHS_ENV_KEY,
  METADATA_CONTAINER_BY_FORMAT,
  OUTPUT_FORMATS,
} from '@otkritka/images';
import {
  createPatternJpegWithExifOrientation,
  createPatternPng,
  createRotatedPatternPng,
} from './fixtures/images.js';

// Э2-01, ТЗ §6.2 и §6.5: производные AVIF/WebP/JPEG в наборе ширин, у каждого
// варианта известны фактические width/height (без них шаблон не резервирует
// место и получаем CLS).

const SOURCE_WIDTH = 1400;
const SOURCE_HEIGHT = 1050;

let sourcePng: Buffer;
let workDir: string;
let sourcePath: string;

beforeAll(async () => {
  sourcePng = await createPatternPng({ width: SOURCE_WIDTH, height: SOURCE_HEIGHT });
  workDir = await mkdtemp(join(tmpdir(), 'otkritka-images-'));
  sourcePath = join(workDir, 'otkrytka-mame-na-8-marta-s-tulpanami.png');
  await writeFile(sourcePath, sourcePng);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('генерация производных: форматы и ширины', () => {
  it('на дефолтном наборе ширин даёт все форматы для каждой подходящей ширины', async () => {
    const result = await generateDerivatives(sourcePng, { env: {} });

    const expectedWidths = DEFAULT_IMAGE_WIDTHS.filter((width) => width <= SOURCE_WIDTH);
    expect(expectedWidths.length).toBeGreaterThan(1);

    for (const format of OUTPUT_FORMATS) {
      const widthsForFormat = result.variants
        .filter((variant) => variant.format === format)
        .map((variant) => variant.targetWidth);
      expect(widthsForFormat).toEqual([...expectedWidths]);
    }

    expect(result.variants).toHaveLength(expectedWidths.length * OUTPUT_FORMATS.length);
    expect(result.source).toEqual({
      format: 'png',
      width: SOURCE_WIDTH,
      height: SOURCE_HEIGHT,
      exifOrientation: 1,
    });
    expect(result.nativeWidthFallback).toBe(false);
    expect(OUTPUT_FORMATS).toContain(FALLBACK_FORMAT);
  });

  it('заявленные width/height совпадают с метаданными самого файла варианта', async () => {
    const result = await generateDerivatives(sourcePng, { widths: [320, 640] });

    for (const variant of result.variants) {
      const metadata = await sharp(variant.data).metadata();
      expect(metadata.width).toBe(variant.width);
      expect(metadata.height).toBe(variant.height);
      // AVIF в метаданных выглядит как heif/av1 — сверяемся по таблице
      // контейнеров, а не по собственному ярлыку формата.
      const expected = METADATA_CONTAINER_BY_FORMAT[variant.format];
      expect(metadata.format).toBe(expected.container);
      if (expected.compression !== undefined) {
        expect(metadata.compression).toBe(expected.compression);
      }
      expect(variant.byteSize).toBe(variant.data.byteLength);
      // Условие C8 («во внешний мир идёт только фактическая variant.width,
      // из targetWidth — никогда») здесь НЕ проверяется и проверено быть не
      // может: при текущем коде ресайз по одной ширине с withoutEnlargement
      // всегда даёт ровно targetWidth, поэтому любое сравнение двух полей
      // между собой тавтологично и сработало бы как ложный сторож — упало бы
      // первым, если ширины однажды разойдутся. C8 остаётся оговоркой
      // контракта (docstring `ImageDerivative.width`) и закрывается на
      // Э2-05/Э3-04, где появятся ключ объекта и разметка: там есть что
      // различать — из какого поля собран URL и дескриптор `w`.
      //
      // Здесь проверяется единственное, что различимо на этом уровне:
      // заявленная ширина совпадает с метаданными самого файла (выше).
      //
      // Пропорция исходника сохранена: 4:3 у эталона.
      expect(variant.height).toBe(Math.round((variant.width * SOURCE_HEIGHT) / SOURCE_WIDTH));
    }
  });

  it('принимает путь к файлу так же, как буфер', async () => {
    const fromPath = await generateDerivatives(sourcePath, { widths: [320] });
    const fromBuffer = await generateDerivatives(sourcePng, { widths: [320] });

    expect(fromPath.source).toEqual(fromBuffer.source);
    expect(fromPath.variants.map((v) => [v.format, v.width, v.height])).toEqual(
      fromBuffer.variants.map((v) => [v.format, v.width, v.height]),
    );
  });
});

describe('генерация производных: апскейл и границы', () => {
  it('не апскейлит: ширина больше исходной пропускается и попадает в отчёт', async () => {
    const result = await generateDerivatives(sourcePng, {
      widths: [640, SOURCE_WIDTH, SOURCE_WIDTH + 1, 4096],
    });

    expect(result.skippedWidths).toEqual([SOURCE_WIDTH + 1, 4096]);
    const producedWidths = [...new Set(result.variants.map((variant) => variant.targetWidth))];
    expect(producedWidths).toEqual([640, SOURCE_WIDTH]);
    for (const variant of result.variants) {
      expect(variant.width).toBeLessThanOrEqual(SOURCE_WIDTH);
    }
  });

  it('исходник уже всех настроенных ширин: отдаётся натуральная ширина, а не пустой результат', async () => {
    // Пустой набор вариантов Э2-05 не отличит от успеха, и карточка ушла бы
    // без изображения. Поэтому крайний случай даёт ровно один вариант на
    // формат — в натуральную ширину исходника, без апскейла, с явным признаком.
    const tiny = await createPatternPng({ width: 240, height: 180 });
    const result = await generateDerivatives(tiny, { widths: [320, 640] });

    expect(result.variants).toHaveLength(OUTPUT_FORMATS.length);
    expect(result.nativeWidthFallback).toBe(true);
    expect(result.skippedWidths).toEqual([320, 640]);
    expect(result.source.width).toBe(240);
    for (const variant of result.variants) {
      expect(variant.targetWidth).toBe(240);
      expect(variant.width).toBe(240);
      expect(variant.height).toBe(180);
    }
    expect(new Set(result.variants.map((variant) => variant.format))).toEqual(
      new Set(OUTPUT_FORMATS),
    );
  });

  it('вариантов не бывает ноль: набор форматов всегда даёт хотя бы один файл', async () => {
    for (const source of [
      await createPatternPng({ width: 240, height: 180 }),
      await createPatternPng({ width: 4, height: 4 }),
      sourcePng,
    ]) {
      const result = await generateDerivatives(source, { widths: [320, 640] });
      expect(result.variants.length).toBeGreaterThan(0);
    }
  });
});

describe('генерация производных: набор ширин — параметр, а не константа', () => {
  it('переопределение через IMAGE_WIDTHS реально меняет результат', async () => {
    const overridden = await generateDerivatives(sourcePng, {
      env: { [IMAGE_WIDTHS_ENV_KEY]: '400,800' },
    });

    expect(overridden.requestedWidths).toEqual([400, 800]);
    expect([...new Set(overridden.variants.map((variant) => variant.width))]).toEqual([400, 800]);
    expect(overridden.variants).toHaveLength(2 * OUTPUT_FORMATS.length);
  });

  it('явные widths в вызове важнее окружения', async () => {
    const result = await generateDerivatives(sourcePng, {
      widths: [500],
      env: { [IMAGE_WIDTHS_ENV_KEY]: '400,800' },
    });

    expect(result.requestedWidths).toEqual([500]);
    expect([...new Set(result.variants.map((variant) => variant.width))]).toEqual([500]);
  });

  it('набор форматов без резервного JPEG отклоняется (ТЗ §6.2)', async () => {
    await expect(generateDerivatives(sourcePng, { widths: [320], formats: ['avif'] })).rejects.toThrow(
      /резервн/i,
    );
    await expect(
      generateDerivatives(sourcePng, { widths: [320], formats: ['avif', 'webp'] }),
    ).rejects.toThrow(/резервн/i);
  });

  it('пустой набор форматов отклоняется', async () => {
    await expect(generateDerivatives(sourcePng, { widths: [320], formats: [] })).rejects.toThrow(
      /формат/i,
    );
  });

  it('неизвестный формат отклоняется даже при наличии резервного', async () => {
    // Приведения типов не нужно: граница пакета принимает string и сужает сама.
    await expect(
      generateDerivatives(sourcePng, { widths: [320], formats: ['gif', 'jpeg'] }),
    ).rejects.toThrow(/gif/i);
  });

  it('сужение набора до резервного формата допустимо', async () => {
    const result = await generateDerivatives(sourcePng, {
      widths: [320],
      formats: [FALLBACK_FORMAT],
    });

    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.format).toBe('jpeg');
  });
});

describe('генерация производных: оригинал неприкосновенен', () => {
  it('файл-оригинал не меняется ни по размеру, ни по содержимому', async () => {
    const before = await readFile(sourcePath);
    const beforeStat = await stat(sourcePath);
    const beforeHash = createHash('sha256').update(before).digest('hex');

    await generateDerivatives(sourcePath, { widths: [320, 640] });

    const after = await readFile(sourcePath);
    const afterStat = await stat(sourcePath);
    const afterHash = createHash('sha256').update(after).digest('hex');

    expect(afterHash).toBe(beforeHash);
    expect(afterStat.size).toBe(beforeStat.size);
  });

  it('входной буфер не мутируется', async () => {
    const input = Buffer.from(sourcePng);
    const hashBefore = createHash('sha256').update(input).digest('hex');

    await generateDerivatives(input, { widths: [320] });

    expect(createHash('sha256').update(input).digest('hex')).toBe(hashBefore);
  });
});

describe('генерация производных: EXIF-ориентация (ТЗ §6.2, §6.5, §10)', () => {
  // Камера пишет ландшафтные пиксели и тег Orientation=6 («показывать
  // повёрнутым на 90° по часовой»). sharp срезает метаданные при кодировании,
  // поэтому ориентацию обязан применить пайплайн: иначе в хранилище попадает
  // повёрнутая производная с ПОСТОЯННЫМ URL, а ресайз по ширине идёт по не той
  // оси. На этапе 3 это уже неисправимо — шаблон получает готовые байты.
  const ORIENTATION = 6;

  it('размеры исходника отдаются ориентированными и с признаком тега', async () => {
    const rotatedByExif = await createPatternJpegWithExifOrientation({
      width: SOURCE_WIDTH,
      height: SOURCE_HEIGHT,
      orientation: ORIENTATION,
    });

    const result = await generateDerivatives(rotatedByExif, { widths: [640] });

    expect(result.source.width).toBe(SOURCE_HEIGHT);
    expect(result.source.height).toBe(SOURCE_WIDTH);
    expect(result.source.exifOrientation).toBe(ORIENTATION);
  });

  it('ресайз идёт по правильной оси: пропорция производной портретная', async () => {
    const rotatedByExif = await createPatternJpegWithExifOrientation({
      width: SOURCE_WIDTH,
      height: SOURCE_HEIGHT,
      orientation: ORIENTATION,
    });

    const result = await generateDerivatives(rotatedByExif, { widths: [640] });

    for (const variant of result.variants) {
      expect(variant.width).toBe(640);
      // 640 * 1400/1050 = 853, а не 480 (что вышло бы без учёта ориентации).
      expect(variant.height).toBe(Math.round((640 * SOURCE_WIDTH) / SOURCE_HEIGHT));
      expect(variant.height).toBeGreaterThan(variant.width);
      const metadata = await sharp(variant.data).metadata();
      expect(metadata.width).toBe(variant.width);
      expect(metadata.height).toBe(variant.height);
    }
  });

  it('содержимое производной повёрнуто так, как обязан показать браузер', async () => {
    const rotatedByExif = await createPatternJpegWithExifOrientation({
      width: SOURCE_WIDTH,
      height: SOURCE_HEIGHT,
      orientation: ORIENTATION,
    });
    const expectedView = await createRotatedPatternPng({
      width: SOURCE_WIDTH,
      height: SOURCE_HEIGHT,
      angle: 90,
    });

    const result = await generateDerivatives(rotatedByExif, {
      widths: [640],
      formats: [FALLBACK_FORMAT],
    });
    const produced = result.variants[0]?.data;
    expect(produced).toBeDefined();

    const producedHash = await computePerceptualHash(produced ?? Buffer.alloc(0));
    const expectedHash = await computePerceptualHash(expectedView);
    const notOrientedHash = await computePerceptualHash(
      await createPatternPng({ width: SOURCE_WIDTH, height: SOURCE_HEIGHT }),
    );

    expect(hammingDistance(producedHash, expectedHash)).toBeLessThan(6);
    expect(hammingDistance(producedHash, notOrientedHash)).toBeGreaterThan(
      hammingDistance(producedHash, expectedHash),
    );
  });

  it('без тега Orientation поведение не меняется', async () => {
    const withoutExif = await createPatternJpegWithExifOrientation({
      width: SOURCE_WIDTH,
      height: SOURCE_HEIGHT,
      orientation: 1,
    });

    const result = await generateDerivatives(withoutExif, { widths: [640] });

    expect(result.source.width).toBe(SOURCE_WIDTH);
    expect(result.source.height).toBe(SOURCE_HEIGHT);
    expect(result.source.exifOrientation).toBe(1);
    expect(result.variants[0]?.height).toBe(
      Math.round((640 * SOURCE_HEIGHT) / SOURCE_WIDTH),
    );
  });
});

describe('генерация производных: fallback делает ключ зависимым от настроек (условие C7)', () => {
  it('добавление ширины убирает fallback и меняет ключ уже опубликованного файла', async () => {
    const narrow = await createPatternPng({ width: 500, height: 500 });
    const keyOf = (width: number): string =>
      buildDerivativeObjectKey({
        prefix: 'cards',
        revision: 'r1',
        description: 'otkrytka mame',
        format: FALLBACK_FORMAT,
        width,
      });

    const before = await generateDerivatives(narrow, {
      widths: [640, 960],
      formats: [FALLBACK_FORMAT],
    });
    const after = await generateDerivatives(narrow, {
      widths: [320, 640, 960],
      formats: [FALLBACK_FORMAT],
    });

    expect(before.nativeWidthFallback).toBe(true);
    expect(before.variants[0]?.width).toBe(500);
    // Ширины только ДОБАВИЛИ, а fallback исчез и ширина варианта другая.
    expect(after.nativeWidthFallback).toBe(false);
    expect(after.variants[0]?.width).toBe(320);
    expect(keyOf(after.variants[0]?.width ?? 0)).not.toBe(keyOf(before.variants[0]?.width ?? 0));
  });

  it('в режиме fallback «запрошенные минус пропущенные» пусто, а варианты есть', async () => {
    const narrow = await createPatternPng({ width: 500, height: 500 });

    const result = await generateDerivatives(narrow, {
      widths: [640, 960],
      formats: [FALLBACK_FORMAT],
    });

    expect(result.requestedWidths).toEqual([640, 960]);
    expect(result.skippedWidths).toEqual([640, 960]);
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.targetWidth).toBe(500);
  });
});

describe('генерация производных: качество кодирования — параметр', () => {
  it('дефолты применяются, если ничего не переопределено', async () => {
    const result = await generateDerivatives(sourcePng, {
      widths: [640],
      formats: [FALLBACK_FORMAT],
      env: {},
    });

    expect(DEFAULT_ENCODE_QUALITY.jpeg).toBeGreaterThan(0);
    expect(result.variants[0]?.byteSize).toBeGreaterThan(0);
  });

  it('опция quality реально меняет результат', async () => {
    const base = { widths: [640], formats: [FALLBACK_FORMAT], env: {} } as const;
    const normal = await generateDerivatives(sourcePng, base);
    const cheap = await generateDerivatives(sourcePng, { ...base, quality: { jpeg: 20 } });

    expect(cheap.variants[0]?.byteSize).toBeLessThan(normal.variants[0]?.byteSize ?? 0);
    expect(cheap.variants[0]?.width).toBe(normal.variants[0]?.width);
  });

  it('IMAGE_ENCODE_QUALITY из окружения меняет результат так же', async () => {
    const base = { widths: [640], formats: [FALLBACK_FORMAT] } as const;
    const normal = await generateDerivatives(sourcePng, { ...base, env: {} });
    const cheap = await generateDerivatives(sourcePng, {
      ...base,
      env: { [IMAGE_ENCODE_QUALITY_ENV_KEY]: 'jpeg=20' },
    });

    expect(cheap.variants[0]?.byteSize).toBeLessThan(normal.variants[0]?.byteSize ?? 0);
  });

  it('отклоняет качество вне диапазона', async () => {
    for (const jpeg of [0, 101, 82.5]) {
      await expect(
        generateDerivatives(sourcePng, {
          widths: [320],
          formats: [FALLBACK_FORMAT],
          env: {},
          quality: { jpeg },
        }),
      ).rejects.toThrow(/качество/i);
    }
  });

  it('явная опция важнее окружения', async () => {
    const base = { widths: [640], formats: [FALLBACK_FORMAT] } as const;
    const fromEnv = await generateDerivatives(sourcePng, {
      ...base,
      env: { [IMAGE_ENCODE_QUALITY_ENV_KEY]: 'jpeg=20' },
    });
    const fromOption = await generateDerivatives(sourcePng, {
      ...base,
      env: { [IMAGE_ENCODE_QUALITY_ENV_KEY]: 'jpeg=20' },
      quality: { jpeg: DEFAULT_ENCODE_QUALITY.jpeg },
    });

    expect(fromOption.variants[0]?.byteSize).toBeGreaterThan(fromEnv.variants[0]?.byteSize ?? 0);
  });
});
