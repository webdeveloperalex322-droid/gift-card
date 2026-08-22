import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SLUG_MAX_LENGTH, isValidSlug, slugify, SLUG_PATTERN } from '@otkritka/shared';
import * as imagesPackage from '@otkritka/images';
import {
  assertOutputFormat,
  buildDerivativeObjectKey,
  buildImageFileStem,
  buildOriginalObjectKey,
  computeImageRevision,
  createOpaqueImageStorageId,
  DEFAULT_IMAGE_NAME_MAX_LENGTH,
  FILE_EXTENSION_BY_FORMAT,
  IMAGE_REVISION_HASH_ALGORITHM,
  IMAGE_REVISION_LENGTH,
  IMAGE_REVISION_MAX_LENGTH,
  isOpaqueImageStorageId,
  OUTPUT_FORMATS,
} from '@otkritka/images';
import { createPatternPng } from './fixtures/images.js';

// Э2-02, ТЗ §6.1, §6.3, §6.7, §11.
//
// Значения префиксов синтетические: конкретные корни хранилища задаёт адаптер
// Э2-04 (по решению Ч-03 до переезда на S3 это локальная ФС). Пакет их не знает
// и знать не должен — он отдаёт относительный ключ.
const ORIGINALS_PREFIX = 'private-originals-test';
const DERIVATIVES_PREFIX = 'public-derivatives-test';
const REVISION = '9f3a1c7d';
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
    // packages/shared. Расхождение с прежним образцом в CLAUDE.md закрыто
    // решением Ч-24 — правится образец, таблица остаётся нормой.
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

  it('причина отказа названа верно: во входе только цифры (Ч-27 про имя файла — про адрес)', () => {
    // Имя файла — часть публичного адреса, поэтому запрет Ч-27 на него
    // распространяется, в отличие от технической ревизии. Подсказка редактору
    // обязана называть именно эту причину, а не «литеры не поддерживаются».
    for (const source of ['2027', '8', '  0042  ']) {
      expect(() => buildImageFileStem(source), source).toThrow(/только цифры/);
      expect(() => buildImageFileStem(source), source).not.toThrow(/не поддерживают/);
    }

    // Запрет ровно на «одни цифры»: «12 34» даёт «12-34» и остаётся законным
    // именем — расширять запрет за формулировку Ч-27 нельзя.
    expect(buildImageFileStem('  12 34  ')).toBe('12-34');
  });

  it('лимит, не оставляющий места под суффикс, — ошибка вызывающего кода', () => {
    expect(() => buildImageFileStem(TITLE, { maxLength: 2, uniqueSuffix: 2 })).toThrow(/лимит/i);
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
    for (const revision of ['', 'R3', 'r 3', 'ревизия', 'a/b', '-r3', 'a'.repeat(33)]) {
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

  // Реальный баг, найденный владельцем packages/shared: ревизия проверялась
  // через isValidSlug, а тот по решению Ч-27 отклоняет значение из одних цифр.
  // Ревизия по Ч-28 — короткий хеш байтов, и примерно в 2 % случаев 8 hex-цифр
  // состоят только из цифр: загрузка падала бы на случайных изображениях.
  it('ревизия из одних цифр допустима: адресом страницы она не является (Ч-27 не про неё)', () => {
    const digitsOnly = '12345678';

    // Тот же самый строкой slug валидатор адресов по-прежнему отклоняет.
    expect(isValidSlug(digitsOnly)).toBe(false);
    expect(SLUG_PATTERN.test(digitsOnly)).toBe(true);

    const key = buildDerivativeObjectKey({
      prefix: DERIVATIVES_PREFIX,
      revision: digitsOnly,
      description: TITLE,
      format: 'webp',
      width: 640,
    });

    expect(key.startsWith(`${DERIVATIVES_PREFIX}/${digitsOnly}/`)).toBe(true);
  });

  it('ревизия из одних цифр принимается на всей длине хеша, а не только в одном примере', () => {
    for (const revision of ['0', '00000000', '99999999', '2027', '8']) {
      expect(isValidSlug(revision), revision).toBe(false);
      expect(() =>
        buildDerivativeObjectKey({
          prefix: DERIVATIVES_PREFIX,
          revision,
          description: TITLE,
          format: 'webp',
          width: 640,
        }),
      ).not.toThrow();
    }
  });
});

describe('ревизия: короткий хеш байтов оригинала (Ч-28)', () => {
  let workDir: string;
  let base: Buffer;
  let sameBytesCopy: Buffer;
  let otherBytes: Buffer;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'otkritka-revision-'));
    base = await createPatternPng({ width: 640, height: 480 });
    sameBytesCopy = Buffer.from(base);
    otherBytes = await createPatternPng({ width: 640, height: 480, composition: 'rings' });
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('имеет форму технического сегмента: 8 hex-символов в нижнем регистре', async () => {
    const revision = await computeImageRevision(base);

    expect(IMAGE_REVISION_LENGTH).toBe(8);
    expect(IMAGE_REVISION_MAX_LENGTH).toBeGreaterThanOrEqual(IMAGE_REVISION_LENGTH);
    expect(revision).toMatch(/^[0-9a-f]{8}$/);
    expect(SLUG_PATTERN.test(revision)).toBe(true);
  });

  it('алгоритм зафиксирован: префикс sha256 от байтов, без соли и без состояния', async () => {
    expect(IMAGE_REVISION_HASH_ALGORITHM).toBe('sha256');
    expect(await computeImageRevision(base)).toBe(
      createHash(IMAGE_REVISION_HASH_ALGORITHM).update(base).digest('hex').slice(0, IMAGE_REVISION_LENGTH),
    );
  });

  it('сохранение без замены байтов не меняет ключ (условие C2)', async () => {
    const first = await computeImageRevision(base);
    const second = await computeImageRevision(sameBytesCopy);

    expect(second).toBe(first);

    const keyOf = (revision: string): string =>
      buildDerivativeObjectKey({
        prefix: DERIVATIVES_PREFIX,
        revision,
        description: TITLE,
        format: 'webp',
        width: 640,
      });

    expect(keyOf(second)).toBe(keyOf(first));
  });

  it('замена байтов меняет ревизию и ключ (условие C2)', async () => {
    const before = await computeImageRevision(base);
    const after = await computeImageRevision(otherBytes);

    expect(after).not.toBe(before);

    const keyOf = (revision: string): string =>
      buildDerivativeObjectKey({
        prefix: DERIVATIVES_PREFIX,
        revision,
        description: TITLE,
        format: 'webp',
        width: 640,
      });

    expect(keyOf(after)).not.toBe(keyOf(before));
  });

  it('одного изменённого байта достаточно: ревизия не «примерная»', async () => {
    const tweaked = Buffer.from(base);
    const lastIndex = tweaked.length - 1;
    tweaked[lastIndex] = ((tweaked[lastIndex] ?? 0) + 1) % 256;

    expect(await computeImageRevision(tweaked)).not.toBe(await computeImageRevision(base));
  });

  it('не зависит ни от имени файла, ни от времени, ни от состояния хранилища', async () => {
    const first = join(workDir, 'otkrytka-mame-na-8-marta.png');
    const second = join(workDir, 'sovsem-drugoe-imya.png');
    await writeFile(first, base);
    await writeFile(second, base);

    const fromFirstPath = await computeImageRevision(first);
    const fromSecondPath = await computeImageRevision(second);
    const fromBuffer = await computeImageRevision(base);

    // Одинаковые байты под разными именами и в разных местах — одна ревизия.
    expect(fromSecondPath).toBe(fromFirstPath);
    expect(fromBuffer).toBe(fromFirstPath);

    // Повторный вызов позже во времени — та же ревизия: ни Date.now, ни
    // счётчика сохранений в ней нет (иначе каждое сохранение переписывало бы
    // URL всех производных).
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(first, base);
    expect(await computeImageRevision(first)).toBe(fromFirstPath);

    // Удаление другого файла состояние ревизии не меняет.
    await rm(second);
    expect(await computeImageRevision(first)).toBe(fromFirstPath);
  });

  it('вычисленная ревизия принимается построителем ключа как есть', async () => {
    // В том числе если хеш вышел из одних цифр — форму проверяет SLUG_PATTERN,
    // а не валидатор адресов (Ч-27).
    for (const width of [320, 640]) {
      const revision = await computeImageRevision(base);
      expect(() =>
        buildDerivativeObjectKey({
          prefix: DERIVATIVES_PREFIX,
          revision,
          description: TITLE,
          format: 'webp',
          width,
        }),
      ).not.toThrow();
    }
  });
});

describe('суффикс -N: принимается параметром, пакетом не вычисляется (блок 5 п. 3)', () => {
  const base = {
    prefix: DERIVATIVES_PREFIX,
    revision: REVISION,
    description: TITLE,
    format: 'webp',
    width: 640,
  } as const;

  it('добавляется к имени файла перед суффиксом ширины', () => {
    const key = buildDerivativeObjectKey({ ...base, uniqueSuffix: 2 });

    expect(key.endsWith('otkrytka-mame-na-8-marta-s-tyulpanami-2-640.webp')).toBe(true);
    expect(buildImageFileStem(TITLE, { uniqueSuffix: 2 })).toBe(
      'otkrytka-mame-na-8-marta-s-tyulpanami-2',
    );
  });

  it('разные N дают разные ключи, а отсутствие N — первое имя без суффикса', () => {
    const withoutSuffix = buildDerivativeObjectKey(base);
    const second = buildDerivativeObjectKey({ ...base, uniqueSuffix: 2 });
    const third = buildDerivativeObjectKey({ ...base, uniqueSuffix: 3 });

    expect(new Set([withoutSuffix, second, third]).size).toBe(3);
    expect(withoutSuffix).not.toContain('-1-640');
  });

  it('N не вычисляется пакетом: без параметра совпадающий вход даёт совпадающий ключ', () => {
    // Граница обязанностей: без состояния хранилища вычислить N невозможно, а
    // вычисление сделало бы путь зависимым от этого состояния. Присвоение и
    // хранение N — задача Э2-05 в apps/cms.
    const first = buildDerivativeObjectKey(base);
    const second = buildDerivativeObjectKey({ ...base });

    expect(second).toBe(first);
    // Ни счётчика, ни попытки развести совпадение сам пакет не делает.
    const suspicious = Object.keys(imagesPackage).filter((name) =>
      /counter|sequence|nextsuffix|allocate|reserve|dedupe/i.test(name),
    );
    expect(suspicious).toEqual([]);
  });

  it('N — целое число от 2: у первого имени суффикса нет, иначе получилось бы два пути', () => {
    for (const uniqueSuffix of [0, 1, -2, 2.5, Number.NaN]) {
      expect(() => buildDerivativeObjectKey({ ...base, uniqueSuffix }), String(uniqueSuffix)).toThrow(
        /суффикс/i,
      );
    }
  });

  it('суффикс не выносит имя за лимит длины: место под него резервируется', () => {
    const long = 'Очень длинный заголовок открытки про весну цветы и поздравления маме';

    for (const uniqueSuffix of [2, 10, 12345]) {
      const stem = buildImageFileStem(long, { uniqueSuffix });
      expect(stem.length).toBeLessThanOrEqual(DEFAULT_IMAGE_NAME_MAX_LENGTH);
      expect(stem.endsWith(`-${String(uniqueSuffix)}`)).toBe(true);
      expect(isValidSlug(stem)).toBe(true);
    }

    const short = buildImageFileStem(long, { maxLength: 12, uniqueSuffix: 2 });
    expect(short.length).toBeLessThanOrEqual(12);
    expect(short.endsWith('-2')).toBe(true);
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
