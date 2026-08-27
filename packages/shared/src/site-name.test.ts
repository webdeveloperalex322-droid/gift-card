/**
 * Имя сайта: одно значение для видимой подписи и для `WebSite.name`.
 *
 * Тест лежит рядом с кодом; остальные правила модуля правил настроек проверяет
 * `tests/unit/site-settings-rules.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { resolveSiteName } from './site-settings-rules.js';

const VISIBLE = 'Поздравительные открытки';

describe('resolveSiteName', () => {
  it('при пустом глобале берёт видимое название и говорит об этом источником', () => {
    expect(resolveSiteName(null, VISIBLE)).toEqual({ source: 'visible-heading', value: VISIBLE });
    expect(resolveSiteName(undefined, VISIBLE)).toEqual({
      source: 'visible-heading',
      value: VISIBLE,
    });
    expect(resolveSiteName({ name: '   ' }, VISIBLE)).toEqual({
      source: 'visible-heading',
      value: VISIBLE,
    });
  });

  it('заполненное имя из глобала становится именем сайта', () => {
    expect(resolveSiteName({ name: '  Открыткино  ' }, VISIBLE)).toEqual({
      source: 'organization',
      value: 'Открыткино',
    });
  });

  it('не зависит от логотипа: имя есть и когда блок Organization не выводится', () => {
    // Ч-17 закрывает БЛОК Organization без логотипа, но имя сайта человек к
    // этому моменту уже задал, и прятать его от `WebSite.name` не за что.
    expect(resolveSiteName({ logo: null, name: 'Открыткино' }, VISIBLE).source).toBe(
      'organization',
    );
  });

  it('пустое видимое название — ошибка, а не пустое имя в разметке', () => {
    expect(() => resolveSiteName({ name: null }, '  ')).toThrow(/видимое название/i);
  });
});
