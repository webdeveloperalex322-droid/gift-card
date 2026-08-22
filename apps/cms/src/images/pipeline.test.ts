/**
 * Прогон пайплайна на настоящих байтах (задачи Э2-05, Э2-06).
 *
 * Тест намеренно не мокает `@otkritka/images`: проверяется именно связка
 * «пайплайн — ключи — хранилище», а с моком она проверялась бы против
 * собственных ожиданий. Изображения синтетические (`./png-fixture.ts`), поэтому
 * ревизия и pHash воспроизводимы между прогонами.
 *
 * Ключевые проверки:
 *   - полный набор производных и заполненный pHash (DoD Э2-05);
 *   - ключ каждого варианта попадает в ПУБЛИЧНОЕ пространство, оригинал — в
 *     непубличное, и путь оригинала не выводится из публичного;
 *   - замена байтов: имя файла прежнее, ревизия и все ключи новые, старые ключи
 *     объявлены к удалению и в новый набор не попадают (DoD Э2-06);
 *   - отказ по метаданным не готовит к записи ничего.
 *
 * ГРАНИЦА КОНТРАКТА, изменённая ревизией от 2026-08-22: сам прогон в хранилище
 * НЕ пишет. Он возвращает `pending` — ключи и байты, — а записывает их
 * `commitPendingObjects` из фазы `afterChange`, когда документ уже есть. Пока
 * запись шла в `beforeChange`, отказ дальше по операции оставлял производные в
 * публичном пространстве без записи в базе.
 */
import { describe, expect, it } from 'vitest';

import { OUTPUT_FORMATS } from '@otkritka/images';

import { type StemCandidate } from './keys';
import { commitPendingObjects, runImagePipeline } from './pipeline';
import { createPngFixture } from './png-fixture';
import { DERIVATIVE_KEY_PREFIX, ORIGINAL_KEY_PREFIX, type ImageStorage } from './storage';

/** Хранилище в памяти: два раздельных пространства, как у настоящего адаптера. */
function memoryStorage(): ImageStorage & {
  readonly derivatives: Map<string, Buffer>;
  readonly originals: Map<string, Buffer>;
} {
  const derivatives = new Map<string, Buffer>();
  const originals = new Map<string, Buffer>();
  return {
    derivatives,
    kind: 'memory',
    originals,
    deleteDerivative: (key) => Promise.resolve(void derivatives.delete(key)),
    deleteOriginal: (key) => Promise.resolve(void originals.delete(key)),
    hasDerivative: (key) => Promise.resolve(derivatives.has(key)),
    hasOriginal: (key) => Promise.resolve(originals.has(key)),
    putDerivative: (key, data) => Promise.resolve(void derivatives.set(key, data)),
    putOriginal: (key, data) => Promise.resolve(void originals.set(key, data)),
    readOriginal: (key) => {
      const data = originals.get(key);
      return data === undefined
        ? Promise.reject(new Error(`нет оригинала ${key}`))
        : Promise.resolve(data);
    },
  };
}

const firstFree = (candidates: readonly StemCandidate[]): Promise<StemCandidate> => {
  const first = candidates[0];
  return first === undefined
    ? Promise.reject(new Error('нет кандидатов'))
    : Promise.resolve(first);
};

const SOURCE = createPngFixture({ height: 400, width: 660 });

function inputFor(
  overrides: Partial<Parameters<typeof runImagePipeline>[0]> = {},
): Parameters<typeof runImagePipeline>[0] {
  return {
    allocateStem: firstFree,
    buffer: SOURCE,
    byteSize: SOURCE.byteLength,
    declaredHeight: 400,
    declaredWidth: 660,
    description: 'Открытка маме на 8 марта',
    mimeType: 'image/png',
    stored: null,
    ...overrides,
  };
}

/**
 * Прогон плюс запись — то же, что делают две фазы хука подряд. Через один
 * помощник, чтобы каждый тест не повторял связку и не забыл про неё.
 */
async function runAndCommit(
  storage: ReturnType<typeof memoryStorage>,
  overrides: Partial<Parameters<typeof runImagePipeline>[0]> = {},
): Promise<Awaited<ReturnType<typeof runImagePipeline>>> {
  const result = await runImagePipeline(inputFor(overrides));
  await commitPendingObjects(storage, result.pending);
  return result;
}

describe('первая загрузка', () => {
  it('создаёт полный набор производных и заполняет pHash', async () => {
    const storage = memoryStorage();
    const result = await runAndCommit(storage);

    // Исходник 660 px: подходят ширины 320 и 640, остальные пропущены —
    // апскейла пайплайн не делает.
    expect(result.variants.map((variant) => variant.width).sort()).toEqual([
      320, 320, 320, 640, 640, 640,
    ]);
    expect(new Set(result.variants.map((variant) => variant.format))).toEqual(
      new Set(OUTPUT_FORMATS),
    );
    expect(result.pHash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.revision).toMatch(/^[0-9a-f]{8}$/);
    expect(result.source).toEqual({
      exifOrientation: 1,
      format: 'png',
      height: 400,
      width: 660,
    });
    expect(result.replaced).toBe(false);
  }, 60_000);

  it('все ключи вариантов записаны в публичное пространство', async () => {
    const storage = memoryStorage();
    const result = await runAndCommit(storage);

    for (const variant of result.variants) {
      expect(storage.derivatives.has(variant.key), variant.key).toBe(true);
      expect(variant.key.startsWith(`${DERIVATIVE_KEY_PREFIX}/${result.revision}/`)).toBe(true);
      expect(variant.key.endsWith(`-${String(variant.width)}.${variant.format === 'jpeg' ? 'jpg' : variant.format}`)).toBe(true);
      expect(variant.byteSize).toBeGreaterThan(0);
      expect(variant.height).toBeGreaterThan(0);
    }
    expect(storage.derivatives.size).toBe(result.variants.length);
  }, 60_000);

  it('оригинал лежит в непубличном пространстве под непредсказуемым именем', async () => {
    const storage = memoryStorage();
    const result = await runAndCommit(storage);

    expect(result.originalKey).toMatch(
      new RegExp(`^${ORIGINAL_KEY_PREFIX}/[0-9a-f]{32}\\.png$`),
    );
    expect(storage.originals.get(result.originalKey)?.equals(SOURCE)).toBe(true);
    // Из публичного пространства оригинал не достаётся: его ключа там нет, а
    // описательного имени в его пути нет вовсе.
    expect(storage.derivatives.has(result.originalKey)).toBe(false);
    expect(result.originalKey.includes(result.nameStem)).toBe(false);
  }, 60_000);

  it('имя файла занимается один раз и хранится вместе с суффиксом', async () => {
    const storage = memoryStorage();
    const taken = new Set(['otkrytka-mame-na-8-marta', 'otkrytka-mame-na-8-marta-2']);
    const result = await runAndCommit(storage, {
      allocateStem: (candidates) => {
        const free = candidates.find((candidate) => !taken.has(candidate.stem));
        return free === undefined
          ? Promise.reject(new Error('свободных имён нет'))
          : Promise.resolve(free);
      },
    });

    expect(result.nameStem).toBe('otkrytka-mame-na-8-marta-3');
    expect(result.nameSuffix).toBe(3);
    expect(result.keyBase.endsWith('/otkrytka-mame-na-8-marta-3')).toBe(true);
  }, 60_000);
});

describe('замена изображения (Э2-06)', () => {
  it('имя прежнее, ревизия и все ключи новые, старые ключи уходят в отставку', async () => {
    const storage = memoryStorage();
    const first = await runAndCommit(storage);

    const replacement = createPngFixture({ composition: 'rings', height: 400, width: 660 });
    const second = await runAndCommit(storage, {
      buffer: replacement,
      byteSize: replacement.byteLength,
      // Заголовок карточки к этому моменту сменился: имя файла обязано
      // остаться прежним (условие C1).
      description: 'Совсем другое описание открытки',
      stored: {
        keyBase: first.keyBase,
        nameStem: first.nameStem,
        nameSuffix: first.nameSuffix,
        originalKey: first.originalKey,
        revision: first.revision,
        storageId: null,
        variants: first.variants,
      },
    });

    expect(second.nameStem).toBe(first.nameStem);
    expect(second.revision).not.toBe(first.revision);
    expect(second.replaced).toBe(true);

    const oldKeys = new Set(first.variants.map((variant) => variant.key));
    for (const variant of second.variants) {
      expect(oldKeys.has(variant.key), variant.key).toBe(false);
      expect(variant.key.includes(first.nameStem)).toBe(true);
    }

    expect([...second.retired.derivativeKeys].sort()).toEqual([...oldKeys].sort());
    expect(second.retired.originalKey).toBe(first.originalKey);
  }, 90_000);

  it('повторная загрузка ТЕХ ЖЕ байтов не объявляет только что записанные ключи к удалению', async () => {
    // Ревизия — хеш содержимого, поэтому те же байты дают те же пути. Удалить
    // их «как старые» означало бы удалить файлы, которые сами же и записали.
    const storage = memoryStorage();
    const first = await runAndCommit(storage);
    const second = await runAndCommit(storage, {
      stored: {
        nameStem: first.nameStem,
        nameSuffix: first.nameSuffix,
        originalKey: first.originalKey,
        revision: first.revision,
        variants: first.variants,
      },
    });

    expect(second.revision).toBe(first.revision);
    expect(second.retired.derivativeKeys).toEqual([]);
    for (const variant of second.variants) {
      expect(storage.derivatives.has(variant.key)).toBe(true);
    }
  }, 90_000);
});

describe('отказ до подготовки объектов', () => {
  it('мелкий исходник отклоняется и ничего не готовит к записи', async () => {
    const storage = memoryStorage();
    const small = createPngFixture({ height: 300, width: 500 });

    await expect(
      runAndCommit(storage, {
        buffer: small,
        byteSize: small.byteLength,
        declaredHeight: 300,
        declaredWidth: 500,
      }),
    ).rejects.toThrow(/640/);

    expect(storage.derivatives.size).toBe(0);
    expect(storage.originals.size).toBe(0);
  });

  it('недопустимый тип отклоняется и ничего не готовит к записи', async () => {
    const storage = memoryStorage();
    await expect(runAndCommit(storage, { mimeType: 'image/svg+xml' })).rejects.toThrow(/тип/i);
    expect(storage.originals.size).toBe(0);
  });
});

/**
 * Отложенная запись (находка ревизии от 2026-08-22): пайплайн НЕ пишет, а
 * `commitPendingObjects` пишет либо всё, либо ничего.
 */
describe('commitPendingObjects: запись отложена и убирает за собой', () => {
  it('сам прогон в хранилище не пишет ни одного объекта', async () => {
    const storage = memoryStorage();
    const result = await runImagePipeline(inputFor());

    expect(storage.derivatives.size).toBe(0);
    expect(storage.originals.size).toBe(0);
    // Всё готово к записи, но записи ещё нет.
    expect(result.pending.derivatives).toHaveLength(result.variants.length);
    expect(result.pending.original.key).toBe(result.originalKey);
    expect(
      result.pending.derivatives.map((object) => object.key).sort(),
    ).toEqual(result.variants.map((variant) => variant.key).sort());
  }, 60_000);

  it('ошибка на середине набора не оставляет ни одного файла', async () => {
    // Половина набора в публичном пространстве — это файлы, отдающиеся по
    // /media, о которых не знает ни одна запись: удалить их потом некому.
    const storage = memoryStorage();
    const result = await runImagePipeline(inputFor());
    const failing: ImageStorage = {
      ...storage,
      putDerivative: (key, data) =>
        key.endsWith('-640.avif')
          ? Promise.reject(new Error('диск переполнен'))
          : storage.putDerivative(key, data),
    };

    await expect(commitPendingObjects(failing, result.pending)).rejects.toThrow(
      /диск переполнен/,
    );

    expect(storage.derivatives.size).toBe(0);
    expect(storage.originals.size).toBe(0);
  }, 60_000);
});
