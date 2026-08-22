/**
 * Контракт публичной отдачи производных: разбор пути `/media/<ключ>` (задача
 * Э2-04b).
 *
 * Сборка пути и заголовки уже покрыты тестами в `apps/cms/src/images/storage.test.ts`
 * — после переезда контракта в `@otkritka/images/media` они проверяют его через
 * реэкспорт, поэтому здесь не повторяются. Новое здесь одно: ОБРАТНАЯ операция,
 * которой пользуется входной сервер `apps/web`. Она обязана быть парной сборке:
 * ключ, из которого построен путь, обязан из этого пути и получиться, а всё
 * остальное — не адрес производной.
 */
import { describe, expect, it } from 'vitest';

import {
  derivativeKeyFromPublicPath,
  derivativePublicPath,
  isStorageKey,
  MEDIA_ROUTE_PREFIX,
} from '@otkritka/images/media';

const KEY = 'cards/a1b2c3d4/otkrytka-mame-na-8-marta-s-tyulpanami-640.webp';

describe('ключ производной из пути запроса', () => {
  it('операция парная сборке пути: ключ → путь → тот же ключ', () => {
    expect(derivativeKeyFromPublicPath(derivativePublicPath(KEY))).toBe(KEY);
  });

  it('все форматы вывода распознаются, включая .jpg (решение Ч-30)', () => {
    for (const extension of ['avif', 'webp', 'jpg']) {
      const key = `cards/a1b2c3d4/otkrytka-640.${extension}`;
      expect(derivativeKeyFromPublicPath(`${MEDIA_ROUTE_PREFIX}/${key}`)).toBe(key);
    }
  });

  it('путь вне пространства производных ключом не является', () => {
    // Ни один из этих путей не должен превратиться в чтение файла: /media без
    // ключа — это каталог (листинга нет), а чужой префикс — чужой маршрут.
    expect(derivativeKeyFromPublicPath('/media')).toBeNull();
    expect(derivativeKeyFromPublicPath('/media/')).toBeNull();
    expect(derivativeKeyFromPublicPath('/mediafile.webp')).toBeNull();
    expect(derivativeKeyFromPublicPath('/otkrytki/8-marta')).toBeNull();
    expect(derivativeKeyFromPublicPath('/')).toBeNull();
  });

  it('выход за корень отклоняется во всех формах, а не исправляется', () => {
    // Ключ приходит из данных записи, а путь запроса — извне; ни одна из форм
    // не должна дать файл над корнем производных. Оригиналы лежат в отдельном
    // дереве (условие C4), поэтому попадание туда означало бы публичный
    // оригинал — прямой запрет ТЗ §6.1.
    const outside = [
      '/media/../uploads/originals/deadbeef.jpg',
      '/media/cards/../../uploads/originals/deadbeef.jpg',
      '/media/..%2Fuploads%2Foriginals%2Fdeadbeef.jpg',
      '/media//cards/a1b2c3d4/otkrytka-640.webp',
      '/media/cards//otkrytka-640.webp',
      '/media/C:/Windows/win.ini',
      '/media//evil.example/x.webp',
      '/media/cards\\a1b2c3d4\\otkrytka-640.webp',
      '/media/cards/a1b2c3d4/otkrytka-640.webp?x=1',
      '/media/cards/A1B2C3D4/Otkrytka-640.WEBP',
    ];
    for (const pathname of outside) {
      expect(derivativeKeyFromPublicPath(pathname)).toBeNull();
    }
  });

  it('каталог без имени файла ключом не является', () => {
    expect(derivativeKeyFromPublicPath('/media/cards')).toBeNull();
    expect(derivativeKeyFromPublicPath('/media/cards/a1b2c3d4')).toBeNull();
    expect(derivativeKeyFromPublicPath('/media/cards/a1b2c3d4/')).toBeNull();
  });

  it('предикат формы ключа исключений не бросает', () => {
    expect(isStorageKey(KEY)).toBe(true);
    expect(isStorageKey('../x.webp')).toBe(false);
    expect(isStorageKey('')).toBe(false);
  });
});
