/**
 * Валидация загружаемого файла (задача Э2-05, DoD «валидация типа и размера»).
 *
 * TDD: тест написан до реализации. Проверки идут ДО генерации производных и до
 * обращения к хранилищу: отказ обязан быть дешёвым, иначе мусорный файл сначала
 * прогоняется через sharp и пишется на диск, а уже потом отклоняется.
 */
import { describe, expect, it } from 'vitest';

import {
  ACCEPTED_IMAGE_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  assertAcceptedUpload,
} from './upload-validation';

const OK = {
  byteSize: 512 * 1024,
  declaredHeight: 900,
  declaredWidth: 1200,
  mimeType: 'image/jpeg',
};

describe('тип файла', () => {
  it('принимает растровые форматы, которые понимает пайплайн', () => {
    expect([...ACCEPTED_IMAGE_MIME_TYPES]).toEqual([
      'image/avif',
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
    for (const mimeType of ACCEPTED_IMAGE_MIME_TYPES) {
      expect(() => assertAcceptedUpload({ ...OK, mimeType })).not.toThrow();
    }
  });

  it('отклоняет SVG и всё, что не изображение', () => {
    // SVG — вектор: у него нет ни ширины в пикселях для srcset, ни осмысленного
    // pHash, зато есть исполняемое содержимое. В каталог открыток он не идёт.
    for (const mimeType of ['image/svg+xml', 'image/gif', 'application/pdf', 'text/html', '']) {
      expect(() => assertAcceptedUpload({ ...OK, mimeType }), mimeType).toThrow(/тип/i);
    }
  });
});

describe('размер файла', () => {
  it('предел зафиксирован и указан в отказе', () => {
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
    expect(() => assertAcceptedUpload({ ...OK, byteSize: MAX_UPLOAD_BYTES })).not.toThrow();
    expect(() => assertAcceptedUpload({ ...OK, byteSize: MAX_UPLOAD_BYTES + 1 })).toThrow(/25/);
  });

  it('пустой файл отклоняется', () => {
    expect(() => assertAcceptedUpload({ ...OK, byteSize: 0 })).toThrow();
  });
});

describe('минимальная ширина исходника (Ч-09, блок 5 п. 2)', () => {
  it('исходник уже 640 px отклоняется по метаданным, до генерации', () => {
    expect(() =>
      assertAcceptedUpload({ ...OK, declaredHeight: 400, declaredWidth: 500 }),
    ).toThrow(/640/);
  });

  it('ровно 640 px проходит: порог — «уже 640», а не «640 и меньше»', () => {
    expect(() =>
      assertAcceptedUpload({ ...OK, declaredHeight: 480, declaredWidth: 640 }),
    ).not.toThrow();
  });

  it('портрет с EXIF-поворотом не отклоняется по «узкой» стороне', () => {
    // Метаданные Payload могут быть без учёта тега Orientation: у повёрнутого
    // кадра 400x800 видимая ширина — 800. Ранняя проверка обязана быть такой,
    // чтобы НЕ отклонить законный файл; окончательное решение принимает
    // generateDerivatives по ориентированной ширине.
    expect(() =>
      assertAcceptedUpload({ ...OK, declaredHeight: 800, declaredWidth: 400 }),
    ).not.toThrow();
  });

  it('без размеров в метаданных ранняя проверка пропускается, а не угадывает', () => {
    expect(() =>
      assertAcceptedUpload({ ...OK, declaredHeight: null, declaredWidth: null }),
    ).not.toThrow();
  });
});
