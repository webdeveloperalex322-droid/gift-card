/**
 * Зеркало состояния файла в карточке: форма полей и чтение значений.
 *
 * Здесь проверяется то, из-за чего зеркало вообще существует: разметка обязана
 * брать путь производной, дескриптор `w` в `srcset` и атрибуты `width`/`height`
 * из ОДНОГО поля — фактической `variant.width`, прочитанной пайплайном из
 * метаданных готового файла (условие C8). Поэтому тесты сверяют зеркало с
 * ИСТОЧНИКОМ (`card-images.variants[]`), а не с литералами: разъехаться им
 * нельзя, а совпадение с литералом в двух файлах — это уже два источника.
 */
import type { Field } from 'payload';
import { describe, expect, it } from 'vitest';

import { OUTPUT_FORMATS } from '@otkritka/images';

import {
  MIRRORED_VARIANT_FIELD_NAMES,
  imageVariantFields,
  readImageMirror,
  readMirroredVariants,
  sameImageMirror,
} from './image-mirror';

function names(fields: readonly Field[]): readonly string[] {
  return fields.map((field) => ('name' in field ? String(field.name) : '—'));
}

function find(fields: readonly Field[], name: string): Field {
  const field = fields.find((candidate) => 'name' in candidate && candidate.name === name);
  if (field === undefined) {
    throw new Error(`Поля «${name}» нет`);
  }
  return field;
}

describe('форма строки варианта', () => {
  it('зеркало несёт ровно то, что нужно разметке: ключ, формат, ширина, высота', () => {
    expect(names(imageVariantFields({ includeByteSize: false }))).toEqual([
      'key',
      'format',
      'width',
      'height',
    ]);
    expect(MIRRORED_VARIANT_FIELD_NAMES).toEqual(['key', 'format', 'width', 'height']);
  });

  it('в зеркале НЕТ byteSize: разметка его не использует', () => {
    // Поле «на будущее» в зеркале — это второй источник данных о файле, который
    // никто не читает и потому никто не проверяет.
    expect(names(imageVariantFields({ includeByteSize: false }))).not.toContain('byteSize');
    expect(names(imageVariantFields({ includeByteSize: true }))).toContain('byteSize');
  });

  it('в зеркале НЕТ targetWidth: второй источник ширины запрещён (условие C8)', () => {
    // `targetWidth` — ЗАПРОШЕННАЯ ширина, `width` — фактическая из метаданных
    // готового файла. Они расходятся при пропорциях, не делящихся нацело, и
    // выбор «не той» ширины даёт CLS: атрибут width не совпал бы с картинкой.
    expect(names(imageVariantFields({ includeByteSize: true }))).not.toContain('targetWidth');
  });

  it('зеркало — подмножество источника, поле в поле', () => {
    const source = imageVariantFields({ includeByteSize: true });
    const mirror = imageVariantFields({ includeByteSize: false });
    for (const name of MIRRORED_VARIANT_FIELD_NAMES) {
      expect(find(mirror, name), name).toEqual(find(source, name));
    }
  });

  it('набор форматов закрыт набором вывода пайплайна', () => {
    const format = find(imageVariantFields({ includeByteSize: false }), 'format');
    expect(format.type).toBe('select');
    expect('options' in format ? format.options : undefined).toEqual(
      OUTPUT_FORMATS.map((value) => ({ label: value, value })),
    );
  });

  it('ключ, формат и размеры обязательны в каждой строке', () => {
    const mirror = imageVariantFields({ includeByteSize: false });
    for (const name of MIRRORED_VARIANT_FIELD_NAMES) {
      const field = find(mirror, name);
      expect('required' in field ? field.required : undefined, name).toBe(true);
    }
  });
});

describe('чтение вариантов из записи изображения', () => {
  const source = [
    { byteSize: 4096, format: 'avif', height: 200, id: 'row-1', key: 'cards/rev/name-320.avif', width: 320 },
    { byteSize: 9000, format: 'webp', height: 400, id: 'row-2', key: 'cards/rev/name-640.webp', width: 640 },
  ];

  it('переносит ровно четыре поля и сохраняет порядок строк источника', () => {
    expect(readMirroredVariants({ variants: source })).toEqual([
      { format: 'avif', height: 200, key: 'cards/rev/name-320.avif', width: 320 },
      { format: 'webp', height: 400, key: 'cards/rev/name-640.webp', width: 640 },
    ]);
  });

  it('строку с непригодным значением отбрасывает, а не подставляет ноль', () => {
    // Ноль в `width` дал бы дескриптор `0w` и атрибут width="0": браузер
    // зарезервировал бы нулевое место, а это сдвиг макета при загрузке.
    const broken = readMirroredVariants({
      variants: [
        { format: 'webp', height: 400, key: 'cards/rev/name-640.webp', width: 0 },
        { format: 'webp', height: 400, key: '', width: 640 },
        { format: 'tiff', height: 400, key: 'cards/rev/name-640.tiff', width: 640 },
        { format: 'jpeg', height: 400.5, key: 'cards/rev/name-640.jpg', width: 640 },
        source[1],
      ],
    });
    expect(broken).toEqual([
      { format: 'webp', height: 400, key: 'cards/rev/name-640.webp', width: 640 },
    ]);
  });

  it('отсутствие вариантов — пустой список, а не исключение', () => {
    expect(readMirroredVariants({})).toEqual([]);
    expect(readMirroredVariants({ variants: null })).toEqual([]);
    expect(readMirroredVariants({ variants: 'нет' })).toEqual([]);
  });
});

describe('состояние зеркала целиком', () => {
  const image = {
    keyBase: 'cards/a1b2c3d4/otkrytka-mame',
    nameStem: 'otkrytka-mame',
    nameSuffix: null,
    pHash: 'ffffffffffffffff',
    revision: 'a1b2c3d4',
    variants: [{ byteSize: 10, format: 'webp', height: 400, key: 'cards/a1b2c3d4/otkrytka-mame-640.webp', width: 640 }],
  };

  it('читает поля пути и варианты одним вызовом', () => {
    expect(readImageMirror(image)).toEqual({
      keyBase: 'cards/a1b2c3d4/otkrytka-mame',
      nameStem: 'otkrytka-mame',
      nameSuffix: null,
      pHash: 'ffffffffffffffff',
      revision: 'a1b2c3d4',
      variants: [{ format: 'webp', height: 400, key: 'cards/a1b2c3d4/otkrytka-mame-640.webp', width: 640 }],
    });
  });

  it('одинаковое состояние считается одинаковым (несодержательное сохранение)', () => {
    expect(sameImageMirror(readImageMirror(image), readImageMirror({ ...image }))).toBe(true);
  });

  it('новая ревизия и новые ключи считаются изменением (замена байтов, Э2-06)', () => {
    const replaced = {
      ...image,
      keyBase: 'cards/99999999/otkrytka-mame',
      revision: '99999999',
      variants: [{ format: 'webp', height: 400, key: 'cards/99999999/otkrytka-mame-640.webp', width: 640 }],
    };
    expect(sameImageMirror(readImageMirror(image), readImageMirror(replaced))).toBe(false);
  });

  it('изменение одной высоты — тоже изменение: разметка резервирует место по ней', () => {
    const nudged = {
      ...image,
      variants: [{ format: 'webp', height: 401, key: 'cards/a1b2c3d4/otkrytka-mame-640.webp', width: 640 }],
    };
    expect(sameImageMirror(readImageMirror(image), readImageMirror(nudged))).toBe(false);
  });

  it('порядок строк значим: перестановка — другое состояние', () => {
    const two = {
      ...image,
      variants: [
        { format: 'avif', height: 200, key: 'cards/a1b2c3d4/otkrytka-mame-320.avif', width: 320 },
        { format: 'webp', height: 400, key: 'cards/a1b2c3d4/otkrytka-mame-640.webp', width: 640 },
      ],
    };
    const swapped = { ...two, variants: [...two.variants].reverse() };
    expect(sameImageMirror(readImageMirror(two), readImageMirror(swapped))).toBe(false);
  });

  it('пустая запись даёт пустое состояние', () => {
    expect(readImageMirror({})).toEqual({
      keyBase: null,
      nameStem: null,
      nameSuffix: null,
      pHash: null,
      revision: null,
      variants: [],
    });
  });
});
