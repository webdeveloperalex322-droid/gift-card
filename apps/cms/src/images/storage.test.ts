/**
 * Контракт хранилища изображений (задача Э2-04): публичный путь производной,
 * заголовки кеширования и форма ключа.
 *
 * TDD: тест написан до реализации. Проверяется ровно то, что при ошибке даёт
 * тихий, а не громкий отказ:
 *   - публичный путь собирается ТОЛЬКО из ключа объекта и префикса `/media`,
 *     хост в него не попадает (хост добавляет единственный хелпер над
 *     `SITE_URL` из `@otkritka/shared`, решение Ч-03: `IMAGES_CDN_ORIGIN` нет);
 *   - `Cache-Control: public, max-age=31536000, immutable` — дословно из решения
 *     Ч-03. Заголовок законен только потому, что путь производной постоянен;
 *   - ключ с `..`, ведущим слешем, обратным слешем или схемой отклоняется: из
 *     такого ключа собрался бы путь наружу публичного пространства.
 */
import { describe, expect, it } from 'vitest';

import { isReservedPath } from '@otkritka/shared';

import {
  DERIVATIVE_KEY_PREFIX,
  IMMUTABLE_CACHE_CONTROL,
  MEDIA_ROUTE_PREFIX,
  ORIGINAL_KEY_PREFIX,
  assertStorageKey,
  derivativeAbsoluteUrl,
  derivativeCacheHeaders,
  derivativePublicPath,
} from './storage';

const KEY = `${DERIVATIVE_KEY_PREFIX}/a1b2c3d4/otkrytka-mame-na-8-marta-640.webp`;

describe('контракт публичного пути производной', () => {
  it('путь — /media + ключ объекта, без хоста и без схемы', () => {
    expect(MEDIA_ROUTE_PREFIX).toBe('/media');
    expect(derivativePublicPath(KEY)).toBe(`/media/${KEY}`);
  });

  it('префикс внесён в реестр зарезервированных маршрутов', () => {
    // Реестр в packages/shared объявлен ЕДИНСТВЕННЫМ машинным источником
    // занятых путей, а публичный префикс файлов в него не входил (находка
    // ревизии от 2026-08-22). Без записи подборка со slug `media` заняла бы
    // путь, по которому на этапе 3 появится отдача файлов. Тест связывает
    // константу с реестром: разъехаться им нельзя.
    const env = { PAYLOAD_ADMIN_PATH: '/admin' };
    expect(isReservedPath(MEDIA_ROUTE_PREFIX, env)).toBe(true);
    expect(isReservedPath(derivativePublicPath(KEY), env)).toBe(true);
  });

  it('абсолютный адрес собирается единственным хелпером над SITE_URL', () => {
    // Отдельного домена изображений нет (Ч-03): второй источник хоста означал
    // бы, что contentUrl в JSON-LD и image sitemap могут разойтись с canonical.
    expect(derivativeAbsoluteUrl(KEY, { SITE_URL: 'https://primer.test' })).toBe(
      `https://primer.test/media/${KEY}`,
    );
  });

  it('без SITE_URL абсолютный адрес не собирается, а валит с внятной ошибкой', () => {
    expect(() => derivativeAbsoluteUrl(KEY, {})).toThrow(/SITE_URL/);
  });

  it('заголовки: immutable-кеш и content-type по расширению ключа', () => {
    expect(IMMUTABLE_CACHE_CONTROL).toBe('public, max-age=31536000, immutable');
    expect(derivativeCacheHeaders(KEY)).toEqual({
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Type': 'image/webp',
    });
    expect(derivativeCacheHeaders(`${DERIVATIVE_KEY_PREFIX}/a1/x-320.avif`)['Content-Type']).toBe(
      'image/avif',
    );
    expect(derivativeCacheHeaders(`${DERIVATIVE_KEY_PREFIX}/a1/x-320.jpg`)['Content-Type']).toBe(
      'image/jpeg',
    );
  });

  it('расширение вне набора вывода пайплайна отклоняется', () => {
    // Набор форматов закрыт (AVIF/WebP/JPEG): неизвестное расширение означает,
    // что в публичное пространство попал не тот файл.
    expect(() => derivativeCacheHeaders(`${DERIVATIVE_KEY_PREFIX}/a1/x-320.svg`)).toThrow(
      /расширени/i,
    );
  });
});

describe('форма ключа объекта', () => {
  it('пропускает относительный ключ из допустимых сегментов', () => {
    expect(assertStorageKey(KEY)).toBe(KEY);
    expect(assertStorageKey(`${ORIGINAL_KEY_PREFIX}/0123456789abcdef0123456789abcdef.jpg`)).toBe(
      `${ORIGINAL_KEY_PREFIX}/0123456789abcdef0123456789abcdef.jpg`,
    );
  });

  it('отклоняет выход за пределы пространства и абсолютные формы', () => {
    for (const bad of [
      '',
      '/cards/a1/x-320.webp',
      'cards/../../etc/passwd',
      'cards/..',
      'cards\\a1\\x-320.webp',
      'https://primer.test/cards/a1/x-320.webp',
      '//primer.test/x.webp',
      'cards//a1/x-320.webp',
      'cards/a1/x 320.webp',
      'cards/a1/X-320.WEBP',
      'cards/a1/x-320.webp?v=2',
    ]) {
      expect(() => assertStorageKey(bad), bad).toThrow();
    }
  });

  it('публичный путь строится только из проверенного ключа', () => {
    expect(() => derivativePublicPath('../secret/original.jpg')).toThrow();
    expect(() => derivativePublicPath(`/${KEY}`)).toThrow();
  });
});
