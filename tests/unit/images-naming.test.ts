import { describe, expect, it } from 'vitest';
import { DEFAULT_SLUG_MAX_LENGTH, isValidSlug, slugify } from '@otkritka/shared';
import * as imagesPackage from '@otkritka/images';
import {
  assertOutputFormat,
  buildDerivativeObjectKey,
  buildImageFileStem,
  buildOriginalObjectKey,
  createOpaqueImageStorageId,
  DEFAULT_IMAGE_NAME_MAX_LENGTH,
  FILE_EXTENSION_BY_FORMAT,
  isOpaqueImageStorageId,
  OUTPUT_FORMATS,
} from '@otkritka/images';

// Э2-02, ТЗ §6.1, §6.3, §6.7, §11.
//
// Значения префиксов синтетические: реальные бакеты и CDN — решение Ч-03,
// человеком не принятое. Пакет их не знает и знать не должен.
const ORIGINALS_PREFIX = 'private-originals-test';
const DERIVATIVES_PREFIX = 'public-derivatives-test';
const REVISION = 'r2';
const TITLE = 'Открытка маме на 8 марта с тюльпанами';

function pathSegments(key: string): string[] {
  return key.split('/');
}

/** Сегменты без расширения у последнего: то, что обязано быть валидным slug. */
function slugSegments(key: string): string[] {
  const segments = pathSegments(key);
  const last = segments.pop() ?? '';
  const withoutExtension = last.replace(/\.[a-z0-9]+$/, '');
  return [...segments, withoutExtension];
}

describe('имя файла: транслит через shared, без второй таблицы', () => {
  it('строит имя ровно тем же правилом, что и slugify из shared', () => {
    expect(buildImageFileStem(TITLE)).toBe(
      slugify(TITLE, { maxLength: DEFAULT_IMAGE_NAME_MAX_LENGTH }),
    );
  });

  it('даёт короткое описательное имя на транслите', () => {
    // «тюльпанами» → «tyulpanami»: правило ю → yu задано таблицей в
    // packages/shared. Образец в CLAUDE.md написан как «s-tulpanami» — это
    // расхождение вынесено человеку, а не сглажено локальным исключением.
    expect(buildImageFileStem(TITLE)).toBe('otkrytka-mame-na-8-marta-s-tyulpanami');
  });

  it('итоговое имя проходит isValidSlug из shared', () => {
    expect(isValidSlug(buildImageFileStem(TITLE))).toBe(true);
  });

  it('в имени нет кириллицы, пробелов, подчёркиваний, верхнего регистра и параметров', () => {
    const stem = buildImageFileStem('  Открытка_МАМЕ  на 8 Марта?style=retro&utm=x  ');

    expect(stem).toMatch(/^[a-z0-9-]+$/);
    expect(stem).not.toMatch(/[Ѐ-ӿ]/);
    expect(stem).not.toMatch(/[\s_?&=%#]/);
    expect(stem).toBe(stem.toLowerCase());
    expect(isValidSlug(stem)).toBe(true);
  });

  it('длина имени — параметр с дефолтом, а не жёсткая норма', () => {
    const long = 'Очень длинный заголовок открытки про весну цветы и поздравления маме';

    expect(buildImageFileStem(long).length).toBeLessThanOrEqual(DEFAULT_IMAGE_NAME_MAX_LENGTH);
    expect(buildImageFileStem(long, { maxLength: 12 }).length).toBeLessThanOrEqual(12);
    expect(isValidSlug(buildImageFileStem(long, { maxLength: 12 }))).toBe(true);
    // Дефолт оставляет запас под суффикс «-1920.webp» внутри нормы slug.
    expect(DEFAULT_IMAGE_NAME_MAX_LENGTH).toBeLessThan(DEFAULT_SLUG_MAX_LENGTH);
  });

  it('причина отказа названа верно: нет букв и цифр — это одна причина', () => {
    for (const source of ['', '   ', '!!!', '???', '_ _ _', '—', '🙂']) {
      expect(() => buildImageFileStem(source), source).toThrow(/нет ни букв, ни цифр/);
    }
  });

  it('причина отказа названа верно: литеры есть, но правила их не поддерживают', () => {
    // Армянский, грузинский, CJK: символы во входе ЕСТЬ, отказ вызван тем, что
    // таблица транслитерации в packages/shared их не покрывает. Подсказка
    // «дайте латинское имя» здесь была бы объяснением не той причины.
    for (const source of ['Շնորհավոր', 'გილოცავ', '生日快乐']) {
      expect(() => buildImageFileStem(source), source).toThrow(/не поддерживают/);
      expect(() => buildImageFileStem(source), source).not.toThrow(/нет ни букв/);
    }
  });

  it('пустой результат транслитерации — внятная ошибка, а не пустой сегмент', () => {
    for (const source of ['', '   ', '!!!', '—', '???', '_ _ _']) {
      expect(() => buildImageFileStem(source)).toThrow(/имя файла/i);
    }

    expect(() =>
      buildDerivativeObjectKey({
        prefix: DERIVATIVES_PREFIX,
        revision: REVISION,
        description: '???',
        format: 'webp',
        width: 640,
      }),
    ).toThrow(/имя файла/i);
  });
});

describe('путь производной: формат, ширина, расширение', () => {
  it('однозначно кодирует формат и ширину, расширение соответствует формату', () => {
    for (const format of OUTPUT_FORMATS) {
      for (const width of [320, 1920]) {
        const key = buildDerivativeObjectKey({
          prefix: DERIVATIVES_PREFIX,
          revision: REVISION,
          description: TITLE,
          format,
          width,
        });

        expect(key.endsWith(`-${String(width)}.${FILE_EXTENSION_BY_FORMAT[format]}`)).toBe(true);
        expect(key).toContain('otkrytka-mame-na-8-marta-s-tyulpanami');
      }
    }
  });

  it('норма проекта: jpeg — только .jpg, второго написания не существует', () => {
    const key = buildDerivativeObjectKey({
      prefix: DERIVATIVES_PREFIX,
      revision: REVISION,
      description: TITLE,
      format: 'jpeg',
      width: 960,
    });

    expect(FILE_EXTENSION_BY_FORMAT.jpeg).toBe('jpg');
    expect(key.endsWith('.jpg')).toBe(true);
    expect(key).not.toContain('.jpeg');
  });

  it('разные формат и ширина дают разные пути', () => {
    const base = { prefix: DERIVATIVES_PREFIX, revision: REVISION, description: TITLE } as const;
    const keys = new Set(
      OUTPUT_FORMATS.flatMap((format) =>
        [320, 640].map((width) => buildDerivativeObjectKey({ ...base, format, width })),
      ),
    );

    expect(keys.size).toBe(OUTPUT_FORMATS.length * 2);
  });

  it('каждый сегмент пути (имя — без расширения) проходит isValidSlug', () => {
    const key = buildDerivativeObjectKey({
      prefix: 'images/cards',
      revision: REVISION,
      description: TITLE,
      format: 'avif',
      width: 1280,
    });

    for (const segment of slugSegments(key)) {
      expect(isValidSlug(segment), segment).toBe(true);
    }
  });

  it('отклоняет ширину, которая не является целым положительным числом', () => {
    for (const width of [0, -320, 1.5, Number.NaN]) {
      expect(() =>
        buildDerivativeObjectKey({
          prefix: DERIVATIVES_PREFIX,
          revision: REVISION,
          description: TITLE,
          format: 'webp',
          width,
        }),
      ).toThrow(/ширина/i);
    }
  });

  it('формат сужается на границе пакета: строка проверяется в рантайме', () => {
    // Граница принимает string: Payload и внешний AI-редактор зовут пакет из
    // JS-слоя, где тип не проверяется, поэтому проверка обязана быть
    // достижимой без приведений типов в тесте.
    for (const format of OUTPUT_FORMATS) {
      expect(assertOutputFormat(format)).toBe(format);
    }
    for (const bad of ['gif', '', 'JPEG', 'jpg', 'avif ', 'png']) {
      expect(() => assertOutputFormat(bad), bad).toThrow(/формат/i);
    }
  });

  it('неизвестный формат отклоняется и на входе построителя пути', () => {
    expect(() =>
      buildDerivativeObjectKey({
        prefix: DERIVATIVES_PREFIX,
        revision: REVISION,
        description: TITLE,
        format: 'gif',
        width: 640,
      }),
    ).toThrow(/формат/i);
  });
});

describe('постоянство URL файла (ТЗ §6.3)', () => {
  it('тот же вход даёт тот же путь при повторных вызовах', () => {
    const input = {
      prefix: DERIVATIVES_PREFIX,
      revision: REVISION,
      description: TITLE,
      format: 'webp',
      width: 640,
    } as const;

    const keys = [1, 2, 3].map(() => buildDerivativeObjectKey(input));

    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(buildDerivativeObjectKey({ ...input }));
  });

  it('регистр, лишние пробелы и знаки в заголовке не меняют путь', () => {
    const canonical = buildDerivativeObjectKey({
      prefix: DERIVATIVES_PREFIX,
      revision: REVISION,
      description: TITLE,
      format: 'webp',
      width: 640,
    });
    const noisy = buildDerivativeObjectKey({
      prefix: `/${DERIVATIVES_PREFIX}/`,
      revision: REVISION,
      description: `  ${TITLE.toUpperCase()}!  `,
      format: 'webp',
      width: 640,
    });

    expect(noisy).toBe(canonical);
  });

  it('замена изображения меняет путь только через ревизию (ТЗ §6.7)', () => {
    const base = {
      prefix: DERIVATIVES_PREFIX,
      description: TITLE,
      format: 'webp',
      width: 640,
    } as const;

    expect(buildDerivativeObjectKey({ ...base, revision: 'r3' })).not.toBe(
      buildDerivativeObjectKey({ ...base, revision: REVISION }),
    );
  });

  it('отклоняет ревизию, которая не является одним валидным сегментом', () => {
    for (const revision of ['', 'R3', 'r 3', 'ревизия', 'a/b', '-r3']) {
      expect(() =>
        buildDerivativeObjectKey({
          prefix: DERIVATIVES_PREFIX,
          revision,
          description: TITLE,
          format: 'webp',
          width: 640,
        }),
      ).toThrow(/ревизи/i);
    }
  });
});

describe('ключ объекта относительный: ни хоста, ни схемы', () => {
  it('в пути нет схемы, хоста и ведущего слеша', () => {
    const derivative = buildDerivativeObjectKey({
      prefix: DERIVATIVES_PREFIX,
      revision: REVISION,
      description: TITLE,
      format: 'avif',
      width: 960,
    });
    const original = buildOriginalObjectKey({
      prefix: ORIGINALS_PREFIX,
      storageId: createOpaqueImageStorageId(),
      extension: 'png',
    });

    for (const key of [derivative, original]) {
      expect(key).not.toMatch(/^https?:/);
      expect(key).not.toMatch(/^\/\//);
      expect(key).not.toMatch(/^\//);
      expect(key).not.toContain('://');
      expect(key.endsWith('/')).toBe(false);
      expect(key).not.toContain('//');
    }
  });

  it('ни один построитель пути не выдаёт хост: проверка по результату, не по имени', () => {
    const prefixes = ['cards', 'images/cards', '/images/cards/', 'a', 'a-b/c-d'];
    const keys: string[] = [];

    for (const prefix of prefixes) {
      for (const format of OUTPUT_FORMATS) {
        keys.push(
          buildDerivativeObjectKey({
            prefix,
            revision: REVISION,
            description: TITLE,
            format,
            width: 640,
          }),
        );
      }
      keys.push(
        buildOriginalObjectKey({
          prefix,
          storageId: createOpaqueImageStorageId(),
          extension: 'png',
        }),
      );
    }

    for (const key of keys) {
      // Полная форма ключа: сегменты из [a-z0-9-] через слеш плюс расширение.
      expect(key, key).toMatch(/^[a-z0-9][-a-z0-9]*(?:\/[a-z0-9][-a-z0-9]*)*\.[a-z0-9]+$/);
      expect(key).not.toContain('://');
      expect(key).not.toContain('@');
      expect(key.startsWith('/')).toBe(false);
      expect(() => new URL(key)).toThrow();
    }
  });

  it('дополнительно: в публичном API нет имени, обещающего абсолютный URL', () => {
    // `origin(?!al)`: `buildOriginalObjectKey` — про оригинал файла, а не про
    // origin URL. Проверка по именам — только дополнение к проверке по
    // результату выше: имя можно выбрать любое, поведение подделать нельзя.
    const suspicious = Object.keys(imagesPackage).filter((name) =>
      /url|origin(?!al)|cdn|host|absolute/i.test(name),
    );

    expect(suspicious).toEqual([]);
  });

  it('отклоняет префикс, который не является набором валидных сегментов', () => {
    for (const prefix of ['', '   ', 'Originals', 'ориг', 'a b', 'a//b', 'https://cdn.example']) {
      expect(() =>
        buildDerivativeObjectKey({
          prefix,
          revision: REVISION,
          description: TITLE,
          format: 'webp',
          width: 640,
        }),
      ).toThrow(/префикс/i);
    }
  });

  it('нормализует обрамляющие слеши префикса, но не меняет его состав', () => {
    const key = buildDerivativeObjectKey({
      prefix: '/images/cards/',
      revision: REVISION,
      description: TITLE,
      format: 'webp',
      width: 640,
    });

    expect(key.startsWith('images/cards/')).toBe(true);
  });
});

describe('разделение пространств: оригиналы и производные', () => {
  const storageId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

  it('путь оригинала не содержит описательного имени: по имени его не угадать', () => {
    const original = buildOriginalObjectKey({
      prefix: ORIGINALS_PREFIX,
      storageId,
      extension: 'png',
    });

    expect(original).toBe(`${ORIGINALS_PREFIX}/${storageId}.png`);
    expect(original).not.toContain('otkrytka');
    expect(original).not.toContain(DERIVATIVES_PREFIX);
  });

  it('публичный путь производной не содержит ни префикса оригиналов, ни его идентификатора', () => {
    const derivative = buildDerivativeObjectKey({
      prefix: DERIVATIVES_PREFIX,
      revision: REVISION,
      description: TITLE,
      format: 'webp',
      width: 640,
    });

    expect(derivative).not.toContain(ORIGINALS_PREFIX);
    expect(derivative).not.toContain(storageId);
    expect(derivative.startsWith(`${DERIVATIVES_PREFIX}/`)).toBe(true);
  });

  it('даже при одном и том же префиксе путь оригинала из производной не восстановить', () => {
    const samePrefix = 'shared-prefix-test';
    const derivative = buildDerivativeObjectKey({
      prefix: samePrefix,
      revision: REVISION,
      description: TITLE,
      format: 'webp',
      width: 640,
    });
    const original = buildOriginalObjectKey({ prefix: samePrefix, storageId, extension: 'png' });

    expect(derivative).not.toContain(storageId);
    // Единственное общее у двух путей — сам префикс: остальное независимо.
    expect(original.replace(`${samePrefix}/`, '')).not.toContain('otkrytka');
    expect(derivative.replace(`${samePrefix}/`, '')).not.toContain(storageId);
  });

  it('ни одна экспортированная функция не превращает публичный ключ в путь оригинала', async () => {
    // Поведенческая проверка: любой функции пакета скармливается публичный
    // ключ производной. Вернуть путь оригинала она не может — storageId в
    // публичном ключе отсутствует, восстанавливать его нечем.
    const derivative = buildDerivativeObjectKey({
      prefix: DERIVATIVES_PREFIX,
      revision: REVISION,
      description: TITLE,
      format: 'webp',
      width: 640,
    });

    for (const [name, exported] of Object.entries(imagesPackage)) {
      if (typeof exported !== 'function') {
        continue;
      }
      let produced: unknown;
      try {
        // await и на не-промисе безопасен: асинхронные функции пакета отклоняют
        // такой вход, и необработанного отказа при этом не остаётся.
        produced = await (exported as (value: unknown) => unknown)(derivative);
      } catch {
        continue;
      }
      expect(String(produced), name).not.toContain(storageId);
      expect(String(produced), name).not.toContain(ORIGINALS_PREFIX);
    }
  });

  it('дополнительно: имени обратной функции в API тоже нет', () => {
    const suspicious = Object.keys(imagesPackage).filter((name) =>
      /parse|fromkey|tooriginal|resolveoriginal|reverse|decodekey/i.test(name),
    );

    expect(suspicious).toEqual([]);
  });

  it('идентификатор оригинала непредсказуем и не выводится из имени', () => {
    const ids = new Set([1, 2, 3, 4, 5].map(() => createOpaqueImageStorageId()));

    expect(ids.size).toBe(5);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('отклоняет всё, что не выдано собственным генератором', () => {
    const foreignIds = [
      '',
      'otkrytka-mame',
      'ABCDEF0123456789abcdef0123456789',
      'короткий',
      '1234',
      // Предсказуемые идентификаторы записи: последовательный int Postgres и
      // упорядоченный по времени ObjectId — по ним оригиналы перечисляемы.
      '17',
      '507f1f77bcf86cd799439011',
      // UUID с дефисами: форма другая, контракт её не принимает.
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    ];

    for (const storageId of foreignIds) {
      expect(isOpaqueImageStorageId(storageId), storageId).toBe(false);
      expect(() =>
        buildOriginalObjectKey({ prefix: ORIGINALS_PREFIX, storageId, extension: 'png' }),
      ).toThrow(/идентификатор/i);
    }
  });

  it('принимает ровно то, что выдал собственный генератор', () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const generated = createOpaqueImageStorageId();
      expect(isOpaqueImageStorageId(generated)).toBe(true);
      expect(
        buildOriginalObjectKey({
          prefix: ORIGINALS_PREFIX,
          storageId: generated,
          extension: 'png',
        }),
      ).toBe(ORIGINALS_PREFIX + '/' + generated + '.png');
    }
  });

  it('расширение оригинала приводится к нижнему регистру и проверяется', () => {
    expect(
      buildOriginalObjectKey({ prefix: ORIGINALS_PREFIX, storageId, extension: '.PNG' }),
    ).toBe(`${ORIGINALS_PREFIX}/${storageId}.png`);

    for (const extension of ['', 'p n g', 'слишкомдлинное', 'p/g']) {
      expect(() =>
        buildOriginalObjectKey({ prefix: ORIGINALS_PREFIX, storageId, extension }),
      ).toThrow(/расширение/i);
    }
  });

  it('путь оригинала постоянен при том же входе', () => {
    const input = { prefix: ORIGINALS_PREFIX, storageId, extension: 'png' } as const;

    expect(buildOriginalObjectKey(input)).toBe(buildOriginalObjectKey({ ...input }));
  });
});
