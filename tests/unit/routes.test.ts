import { describe, expect, it } from 'vitest';
import { canonicalizePath, isPageRoute, TRAILING_SLASH } from '@otkritka/shared';

/**
 * Задача Э1-01 (остаток): правило завершающего слеша и предикат `isPageRoute()`.
 *
 * Норма — `CLAUDE.md`, раздел «Правила URL»: сайт БЕЗ завершающего слеша
 * (решение Ч-21, 2026-08-21; заменяет прежний выбор «со слешем»). Канонический
 * вид маршрута страницы — `/otkrytki/8-marta`; обращение с завершающим слешем
 * отдаёт одиночный 301 на форму без слеша.
 *
 * Область применения правила задаёт `isPageRoute()`: URL файлов слешем не
 * заканчиваются и нормализации не подлежат. Маршруты админки Payload отдаёт
 * `apps/cms` вне нормализации Astro — предикат про них ничего не знает.
 */

describe('TRAILING_SLASH: единое правило по всему сайту', () => {
  it('фиксирует форму БЕЗ завершающего слеша (Ч-21)', () => {
    expect(TRAILING_SLASH).toBe(false);
  });
});

describe('isPageRoute: маршрут страницы против URL файла', () => {
  const pages = [
    '/',
    '/otkrytki',
    '/otkrytki/8-marta',
    '/otkrytki/prazdniki/8-marta/mame',
    '/otkrytki/prazdniki/8-marta/page/2',
    '/podborki',
    '/o-proekte',
    '/search',
  ];

  for (const path of pages) {
    it(`маршрут страницы: ${path}`, () => {
      expect(isPageRoute(path)).toBe(true);
    });
  }

  const files = [
    '/robots.txt',
    '/sitemap.xml',
    '/sitemap-cards.xml',
    '/media/cards/r2/otkrytka-640.webp',
    '/media/cards/r2/otkrytka-mame-na-8-marta-1920.avif',
    '/favicon.ico',
  ];

  for (const path of files) {
    it(`URL файла: ${path}`, () => {
      expect(isPageRoute(path)).toBe(false);
    });
  }

  it('корень — маршрут страницы, а не файл', () => {
    expect(isPageRoute('/')).toBe(true);
    expect(isPageRoute('')).toBe(true);
  });

  it('точка в середине пути (не в последнем сегменте) файла не делает', () => {
    // Расширение ищется только в последнем сегменте: путь ведёт к странице,
    // а точка стоит в родительском сегменте.
    expect(isPageRoute('/arhiv.2025/otkrytki')).toBe(true);
    expect(isPageRoute('/media.old/cards/otkrytka-640.webp')).toBe(false);
  });

  it('точка внутри последнего сегмента считается расширением — slug точку не допускает', () => {
    // `isValidSlug` точку отклоняет, поэтому маршрут страницы точки в последнем
    // сегменте иметь не может: любая точка там означает файл.
    expect(isPageRoute('/otkrytki/v1.5')).toBe(false);
  });

  it('завершающий слеш маршрут страницы не отменяет — иначе 301 не сработает', () => {
    expect(isPageRoute('/otkrytki/8-marta/')).toBe(true);
    expect(isPageRoute('/otkrytki/')).toBe(true);
  });

  it('завершающий слеш у URL файла его в страницу не превращает', () => {
    expect(isPageRoute('/robots.txt/')).toBe(false);
    expect(isPageRoute('/sitemap.xml/')).toBe(false);
  });

  it('путь без ведущего слеша нормализуется, а не отбрасывается', () => {
    // Ключи объектов из `packages/images` приходят без ведущего слеша.
    expect(isPageRoute('otkrytki/8-marta')).toBe(true);
    expect(isPageRoute('media/cards/r2/otkrytka-640.webp')).toBe(false);
  });

  it('параметры и фрагмент — не путь: явная ошибка вместо тихой догадки', () => {
    expect(() => isPageRoute('/otkrytki?sort=new')).toThrow(/параметр|фрагмент/i);
    expect(() => isPageRoute('/otkrytki#top')).toThrow(/параметр|фрагмент/i);
  });
});

describe('canonicalizePath: приведение пути к канонической форме', () => {
  it('снимает завершающий слеш у маршрута страницы', () => {
    expect(canonicalizePath('/otkrytki/8-marta/')).toBe('/otkrytki/8-marta');
    expect(canonicalizePath('/otkrytki/8-marta')).toBe('/otkrytki/8-marta');
    expect(canonicalizePath('/otkrytki///')).toBe('/otkrytki');
  });

  it('корень остаётся корнем', () => {
    expect(canonicalizePath('/')).toBe('/');
    expect(canonicalizePath('')).toBe('/');
  });

  it('URL файла не трогает, кроме приведения ведущего слеша', () => {
    expect(canonicalizePath('/robots.txt')).toBe('/robots.txt');
    expect(canonicalizePath('media/cards/r2/otkrytka-640.webp')).toBe(
      '/media/cards/r2/otkrytka-640.webp',
    );
  });

  it('схлопывает повторные слеши: два URL одной страницы недопустимы', () => {
    expect(canonicalizePath('/otkrytki//8-marta')).toBe('/otkrytki/8-marta');
    expect(canonicalizePath('//otkrytki')).toBe('/otkrytki');
  });

  it('идемпотентен', () => {
    for (const path of ['/', '/otkrytki/8-marta/', '/robots.txt', 'media/x-640.webp', '']) {
      const once = canonicalizePath(path);
      expect(canonicalizePath(once), path).toBe(once);
    }
  });
});
