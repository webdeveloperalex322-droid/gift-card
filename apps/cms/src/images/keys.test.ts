/**
 * Ключи производных и оригинала (задачи Э2-05, Э2-06; условия C1, C2, C8).
 *
 * TDD: тест написан до реализации. Здесь закрываются ровно те условия вето V3,
 * которые `packages/images` закрыть не может, потому что не хранит данных:
 *
 *   - C1: ключ собирается из СОХРАНЁННОГО имени (`nameStem`), а не из текущего
 *     заголовка. Правка заголовка после публикации не меняет ни одного ключа;
 *   - C2: ключ меняется только вместе с `revision`, то есть только при замене
 *     байтов;
 *   - C8: ширина в ключе — та же величина, что сохранена в `variant.width` и
 *     пойдёт в дескриптор `w` и в атрибут `width`. Второго источника ширины нет.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_NAME_SUFFIX,
  buildKeyBase,
  buildOriginalKey,
  derivativeKey,
  originalExtensionForMimeType,
  stemCandidates,
  toVariantRecords,
} from './keys';
import { DERIVATIVE_KEY_PREFIX, ORIGINAL_KEY_PREFIX } from './storage';

const STEM = 'otkrytka-mame-na-8-marta-s-tyulpanami';
const REVISION = 'a1b2c3d4';

const DERIVATIVES = [
  { byteSize: 1000, format: 'avif' as const, height: 240, targetWidth: 320, width: 320 },
  { byteSize: 4000, format: 'avif' as const, height: 480, targetWidth: 640, width: 640 },
  { byteSize: 2000, format: 'webp' as const, height: 240, targetWidth: 320, width: 320 },
  { byteSize: 3000, format: 'jpeg' as const, height: 240, targetWidth: 320, width: 320 },
];

describe('имя файла и суффикс -N', () => {
  it('первый кандидат — без суффикса, дальше -2, -3 (отсчёт с 2)', () => {
    const candidates = stemCandidates('Открытка маме на 8 марта с тюльпанами');
    expect(candidates[0]).toEqual({ stem: STEM, suffix: null });
    expect(candidates[1]).toEqual({ stem: `${STEM}-2`, suffix: 2 });
    expect(candidates[2]).toEqual({ stem: `${STEM}-3`, suffix: 3 });
  });

  it('число кандидатов ограничено: бесконечного перебора при коллизиях нет', () => {
    const candidates = stemCandidates('Открытка');
    expect(candidates).toHaveLength(MAX_NAME_SUFFIX);
    expect(candidates.at(-1)?.suffix).toBe(MAX_NAME_SUFFIX);
  });

  it('имя без букв отклоняется: пустой сегмент в пути недопустим', () => {
    expect(() => stemCandidates('   ')).toThrow();
    expect(() => stemCandidates('2027')).toThrow();
  });

  it('длинное имя укорачивается, но место под суффикс сохраняется', () => {
    const long = 'Очень длинное описание открытки '.repeat(6);
    const candidates = stemCandidates(long);
    expect(candidates[0]?.stem.length).toBeLessThanOrEqual(68);
    expect(candidates[5]?.stem.length).toBeLessThanOrEqual(68);
    expect(candidates[5]?.stem.endsWith('-6')).toBe(true);
  });
});

describe('ключ производной (условия C1, C8)', () => {
  it('собирается из сохранённого имени, ревизии и ФАКТИЧЕСКОЙ ширины варианта', () => {
    expect(derivativeKey({ format: 'webp', revision: REVISION, stem: STEM, width: 640 })).toBe(
      `${DERIVATIVE_KEY_PREFIX}/${REVISION}/${STEM}-640.webp`,
    );
    expect(derivativeKey({ format: 'jpeg', revision: REVISION, stem: STEM, width: 320 })).toBe(
      `${DERIVATIVE_KEY_PREFIX}/${REVISION}/${STEM}-320.jpg`,
    );
  });

  it('сохранённое имя пропускается через построитель без изменений', () => {
    // Идемпотентность обязательна: перегенерация производных (Э2-06) берёт имя
    // ИЗ ЗАПИСИ, и если построитель его переписал бы, ключи после замены
    // изображения разъехались бы с уже опубликованными.
    const stem = stemCandidates('Открытка маме на 8 марта с тюльпанами')[0]?.stem ?? '';
    const first = derivativeKey({ format: 'webp', revision: REVISION, stem, width: 640 });
    const second = derivativeKey({
      format: 'webp',
      revision: REVISION,
      stem: stem,
      width: 640,
    });
    expect(second).toBe(first);
  });

  it('имя с суффиксом -N остаётся с суффиксом, а не получает второй', () => {
    expect(derivativeKey({ format: 'webp', revision: REVISION, stem: `${STEM}-2`, width: 640 })).toBe(
      `${DERIVATIVE_KEY_PREFIX}/${REVISION}/${STEM}-2-640.webp`,
    );
  });

  it('keyBase — общая часть ключей всех вариантов', () => {
    const keyBase = buildKeyBase({ revision: REVISION, stem: STEM });
    expect(keyBase).toBe(`${DERIVATIVE_KEY_PREFIX}/${REVISION}/${STEM}`);
    for (const record of toVariantRecords({ derivatives: DERIVATIVES, revision: REVISION, stem: STEM })) {
      expect(record.key.startsWith(`${keyBase}-`)).toBe(true);
    }
  });

  it('ширина в ключе берётся из variant.width, а не из targetWidth (C8)', () => {
    // Диагностическое targetWidth во внешний мир не идёт: ключ, обещающий
    // ширину, которой у файла нет, дал бы неверный дескриптор w в srcset.
    const records = toVariantRecords({
      derivatives: [{ byteSize: 10, format: 'webp', height: 400, targetWidth: 1280, width: 700 }],
      revision: REVISION,
      stem: STEM,
    });
    expect(records[0]?.key.endsWith('-700.webp')).toBe(true);
    expect(records[0]?.width).toBe(700);
  });

  it('записи вариантов сохраняют формат, размеры и вес файла', () => {
    const records = toVariantRecords({ derivatives: DERIVATIVES, revision: REVISION, stem: STEM });
    expect(records).toHaveLength(DERIVATIVES.length);
    expect(records[0]).toEqual({
      byteSize: 1000,
      format: 'avif',
      height: 240,
      key: `${DERIVATIVE_KEY_PREFIX}/${REVISION}/${STEM}-320.avif`,
      width: 320,
    });
  });

  it('замена байтов меняет все ключи, а имя оставляет прежним (C2, Э2-06)', () => {
    const before = toVariantRecords({ derivatives: DERIVATIVES, revision: 'aaaaaaaa', stem: STEM });
    const after = toVariantRecords({ derivatives: DERIVATIVES, revision: 'bbbbbbbb', stem: STEM });
    const beforeKeys = new Set(before.map((record) => record.key));

    expect(after.every((record) => !beforeKeys.has(record.key))).toBe(true);
    expect(after.every((record) => record.key.includes(STEM))).toBe(true);
  });
});

describe('ключ оригинала', () => {
  it('состоит из непубличного префикса, непредсказуемого id и расширения', () => {
    const storageId = '0123456789abcdef0123456789abcdef';
    expect(buildOriginalKey({ mimeType: 'image/jpeg', storageId })).toBe(
      `${ORIGINAL_KEY_PREFIX}/${storageId}.jpg`,
    );
  });

  it('описательного имени в пути оригинала нет', () => {
    const storageId = 'ffffffffffffffffffffffffffffffff';
    const key = buildOriginalKey({ mimeType: 'image/png', storageId });
    expect(key.includes(STEM)).toBe(false);
    expect(key).toBe(`${ORIGINAL_KEY_PREFIX}/${storageId}.png`);
  });

  it('предсказуемый идентификатор записи в качестве id отклоняется', () => {
    // Последовательный int перечисляется подряд — ровно то, что запрещают
    // ТЗ §6.1 и §11.
    expect(() => buildOriginalKey({ mimeType: 'image/jpeg', storageId: '42' })).toThrow();
  });

  it('расширение оригинала берётся из mime-типа, а не из имени файла', () => {
    // Имя файла приходит от клиента: «kartinka.php.jpg» не должен дать .php.
    expect(originalExtensionForMimeType('image/jpeg')).toBe('jpg');
    expect(originalExtensionForMimeType('image/png')).toBe('png');
    expect(originalExtensionForMimeType('image/webp')).toBe('webp');
    expect(originalExtensionForMimeType('image/avif')).toBe('avif');
    expect(() => originalExtensionForMimeType('image/svg+xml')).toThrow();
  });
});
