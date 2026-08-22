import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  assertSourceImageWidth,
  buildDerivativeObjectKey,
  computePerceptualHash,
  DEFAULT_ENCODE_QUALITY,
  FALLBACK_FORMAT,
  generateDerivatives,
  hammingDistance,
  IMAGE_ENCODE_QUALITY_ENV_KEY,
  IMAGE_WIDTHS,
  METADATA_CONTAINER_BY_FORMAT,
  MIN_SOURCE_IMAGE_WIDTH,
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
  it('на окончательном наборе ширин даёт все форматы для каждой подходящей ширины', async () => {
    const result = await generateDerivatives(sourcePng, { env: {} });

    const expectedWidths = IMAGE_WIDTHS.filter((width) => width <= SOURCE_WIDTH);
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

describe('генерация производных: апскейл — норма, вариант пропускается (блок 5 п. 1)', () => {
  it('не апскейлит: ширина больше исходной пропускается и попадает в отчёт', async () => {
    // Апскейл подтверждён человеком как норма 2026-08-21: он портит качество и
    // раздувает вес без выигрыша, поэтому вариант не выдумывается.
    const narrow = await createPatternPng({ width: 700, height: 525 });
    const result = await generateDerivatives(narrow, { formats: [FALLBACK_FORMAT] });

    expect(result.requestedWidths).toEqual([...IMAGE_WIDTHS]);
    expect(result.skippedWidths).toEqual(IMAGE_WIDTHS.filter((width) => width > 700));
    const producedWidths = [...new Set(result.variants.map((variant) => variant.width))];
    expect(producedWidths).toEqual([320, 640]);
    for (const variant of result.variants) {
      expect(variant.width).toBeLessThanOrEqual(700);
    }
  });

  it('вариантов не бывает ноль: набор форматов всегда даёт хотя бы один файл', async () => {
    for (const source of [
      await createPatternPng({ width: MIN_SOURCE_IMAGE_WIDTH, height: 480 }),
      sourcePng,
    ]) {
      const result = await generateDerivatives(source, { widths: [320, 640] });
      expect(result.variants.length).toBeGreaterThan(0);
    }
  });
});

describe('минимальная ширина исходника 640 px (Ч-09, блок 5 п. 2)', () => {
  it('исходник уже 640 px отклоняется с внятной ошибкой и в пайплайн не идёт', async () => {
    for (const width of [4, 240, 500, MIN_SOURCE_IMAGE_WIDTH - 1]) {
      const tiny = await createPatternPng({ width, height: Math.max(1, Math.round(width * 0.75)) });

      await expect(
        generateDerivatives(tiny, { widths: [320], formats: [FALLBACK_FORMAT] }),
      ).rejects.toThrow(new RegExp(String(MIN_SOURCE_IMAGE_WIDTH)));
      await expect(
        generateDerivatives(tiny, { widths: [320], formats: [FALLBACK_FORMAT] }),
      ).rejects.toThrow(/ширин/i);
    }
  });

  it('ровно 640 px принимается: граница включительна', async () => {
    const border = await createPatternPng({ width: MIN_SOURCE_IMAGE_WIDTH, height: 480 });
    const result = await generateDerivatives(border, {
      widths: [320, 640],
      formats: [FALLBACK_FORMAT],
    });

    expect(result.source.width).toBe(MIN_SOURCE_IMAGE_WIDTH);
    expect(result.variants.map((variant) => variant.width)).toEqual([320, 640]);
  });

  it('порог доступен Э2-05 отдельной проверкой — до чтения байтов пайплайном', () => {
    expect(assertSourceImageWidth(MIN_SOURCE_IMAGE_WIDTH)).toBe(MIN_SOURCE_IMAGE_WIDTH);
    expect(assertSourceImageWidth(1920)).toBe(1920);
    for (const width of [0, -1, 1.5, 639, Number.NaN]) {
      expect(() => assertSourceImageWidth(width), String(width)).toThrow(/ширин/i);
    }
  });

  it('при пороге 640 nativeWidthFallback недостижим (условие C8)', async () => {
    // Признак остаётся в типе как legacy: он описывает записи, загруженные до
    // введения порога. Текущий пайплайн выставить его не может ни на одном
    // допустимом входе — минимальная ширина любого разрешённого набора не
    // превышает 640, а исходник уже 640 px до пайплайна не доходит.
    const sources = [
      await createPatternPng({ width: MIN_SOURCE_IMAGE_WIDTH, height: 480 }),
      await createPatternPng({ width: 700, height: 525 }),
      sourcePng,
    ];

    for (const source of sources) {
      for (const widths of [undefined, [320], [640], [320, 640], [320, 1920]]) {
        const result = await generateDerivatives(source, {
          ...(widths === undefined ? {} : { widths }),
          formats: [FALLBACK_FORMAT],
        });

        expect(result.nativeWidthFallback, JSON.stringify(widths)).toBe(false);
        expect(result.variants.length).toBeGreaterThan(0);
        expect(Math.min(...result.variants.map((variant) => variant.width))).toBeLessThanOrEqual(
          MIN_SOURCE_IMAGE_WIDTH,
        );
      }
    }
  });
});

describe('генерация производных: набор ширин окончателен (Ч-09)', () => {
  it('окружение набор не меняет: расширить его через IMAGE_WIDTHS невозможно', async () => {
    const result = await generateDerivatives(sourcePng, {
      formats: [FALLBACK_FORMAT],
      env: { IMAGE_WIDTHS: '400,800,3840' },
    });

    expect(result.requestedWidths).toEqual([...IMAGE_WIDTHS]);
    expect(result.variants.map((variant) => variant.width)).toEqual(
      IMAGE_WIDTHS.filter((width) => width <= SOURCE_WIDTH),
    );
  });

  it('явные widths сужают набор, но добавить ширину не могут', async () => {
    const result = await generateDerivatives(sourcePng, {
      widths: [320, 960],
      formats: [FALLBACK_FORMAT],
    });

    expect(result.requestedWidths).toEqual([320, 960]);
    expect(result.variants.map((variant) => variant.width)).toEqual([320, 960]);

    for (const widths of [[320, 400], [500], [320, 3840]]) {
      await expect(
        generateDerivatives(sourcePng, { widths, formats: [FALLBACK_FORMAT] }),
      ).rejects.toThrow(/ширин/i);
    }
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

describe('условие C7 закрыто: ключ производной не зависит от настроек', () => {
  it('ключ воспроизводится повторным прогоном того же исходника', async () => {
    // Раньше сценарий «исходник 500 px, ширины 640/960 → ключ -500, потом
    // добавили 320 → ключ не воспроизводится» был открытым риском (C7). Теперь
    // он невозможен с двух сторон: набор ширин заморожен (добавить нельзя), а
    // исходник 500 px до пайплайна не доходит.
    const narrow = await createPatternPng({ width: 700, height: 525 });
    const keyOf = (width: number): string =>
      buildDerivativeObjectKey({
        prefix: 'cards',
        revision: '9f3a1c7d',
        description: 'otkrytka mame',
        format: FALLBACK_FORMAT,
        width,
      });

    const first = await generateDerivatives(narrow, { formats: [FALLBACK_FORMAT] });
    const second = await generateDerivatives(narrow, { formats: [FALLBACK_FORMAT] });

    expect(first.nativeWidthFallback).toBe(false);
    expect(second.variants.map((variant) => keyOf(variant.width))).toEqual(
      first.variants.map((variant) => keyOf(variant.width)),
    );
    expect(first.variants.map((variant) => variant.width)).toEqual([320, 640]);
  });

  it('«запрошенные минус пропущенные» = ширины вариантов: сложного случая больше нет', async () => {
    const narrow = await createPatternPng({ width: 700, height: 525 });

    const result = await generateDerivatives(narrow, { formats: [FALLBACK_FORMAT] });

    expect(result.requestedWidths).toEqual([...IMAGE_WIDTHS]);
    expect(result.skippedWidths).toEqual([960, 1280, 1920]);
    expect(result.variants.map((variant) => variant.targetWidth)).toEqual(
      result.requestedWidths.filter((width) => !result.skippedWidths.includes(width)),
    );
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
