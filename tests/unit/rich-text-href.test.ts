/**
 * Контракт «какой адрес публичный рендер печатает ссылкой»
 * (`packages/shared/src/rich-text-href.ts`).
 *
 * Тест сторожит ГРАНИЦУ, а не оформление: набор допустимых схем закрыт, и
 * расширять его можно только вместе с шаблоном. Поэтому здесь перечислены и
 * положительные случаи, и все виды адресов, которые рендер выводит текстом —
 * если однажды кто-то разрешит `mailto:` в CMS, не научив шаблон, упадёт этот
 * файл, а не страница в поиске.
 */
import { describe, expect, it } from 'vitest';

import {
  isPublicRichTextHref,
  publicRichTextHref,
  validatePublicRichTextHref,
} from '@otkritka/shared';

describe('publicRichTextHref: что становится ссылкой', () => {
  it('путь от корня сайта — внутренняя ссылка', () => {
    expect(publicRichTextHref('/podborki/prazdniki/8-marta')).toEqual({
      external: false,
      href: '/podborki/prazdniki/8-marta',
    });
    expect(publicRichTextHref('  /otkrytki/tyulpany  ')).toEqual({
      external: false,
      href: '/otkrytki/tyulpany',
    });
  });

  it('абсолютный http(s) — внешняя ссылка', () => {
    expect(publicRichTextHref('https://example.com/page')).toEqual({
      external: true,
      href: 'https://example.com/page',
    });
    expect(publicRichTextHref('http://example.com')).toEqual({
      external: true,
      href: 'http://example.com',
    });
  });
});

describe('publicRichTextHref: что ссылкой не становится', () => {
  it('схемы вне набора отклоняются — включая mailto и tel', () => {
    expect(publicRichTextHref('mailto:info@example.com')).toBeNull();
    expect(publicRichTextHref('tel:+70000000000')).toBeNull();
    expect(publicRichTextHref('javascript:alert(1)')).toBeNull();
    expect(publicRichTextHref('data:text/html,<b>x</b>')).toBeNull();
    expect(publicRichTextHref('ftp://example.com/file')).toBeNull();
  });

  it('протокольно-относительная форма — это чужой хост без схемы', () => {
    expect(publicRichTextHref('//example.com/page')).toBeNull();
    expect(publicRichTextHref('\\\\example.com/page')).toBeNull();
  });

  it('относительный адрес без ведущего слеша не адрес страницы сайта', () => {
    expect(publicRichTextHref('podborki/prazdniki')).toBeNull();
    expect(publicRichTextHref('#anchor')).toBeNull();
    expect(publicRichTextHref('')).toBeNull();
    expect(publicRichTextHref('   ')).toBeNull();
  });

  it('нестроковое значение — не адрес', () => {
    expect(publicRichTextHref(null)).toBeNull();
    expect(publicRichTextHref(undefined)).toBeNull();
    expect(publicRichTextHref(42)).toBeNull();
    expect(isPublicRichTextHref({ href: '/x' })).toBe(false);
  });
});

describe('validatePublicRichTextHref: отказ поля редактора', () => {
  it('пусто пропускается: обязательность задаёт само поле', () => {
    expect(validatePublicRichTextHref(undefined)).toBe(true);
    expect(validatePublicRichTextHref(null)).toBe(true);
    expect(validatePublicRichTextHref('  ')).toBe(true);
  });

  it('допустимый адрес проходит', () => {
    expect(validatePublicRichTextHref('/usloviya')).toBe(true);
    expect(validatePublicRichTextHref('https://example.com')).toBe(true);
  });

  it('отказ называет и адрес, и причину, и допустимые формы', () => {
    const message = validatePublicRichTextHref('mailto:info@example.com');
    expect(typeof message).toBe('string');
    expect(String(message)).toContain('mailto:info@example.com');
    expect(String(message)).toContain('путём от корня сайта');
    expect(String(message)).toContain('http или https');
  });
});
