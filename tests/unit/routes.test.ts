import { describe, expect, it } from 'vitest';
import {
  canonicalizePath,
  isPageRoute,
  isProtocolRelativeUrl,
  looksLikeAbsoluteUrl,
  pathSegments,
  TRAILING_SLASH,
} from '@otkritka/shared';

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

  it('схлопывает повторные слеши в середине: два URL одной страницы недопустимы', () => {
    expect(canonicalizePath('/otkrytki//8-marta')).toBe('/otkrytki/8-marta');
    expect(canonicalizePath('/otkrytki/prazdniki//8-marta')).toBe('/otkrytki/prazdniki/8-marta');
  });

  it('ВЕДУЩИЙ двойной слеш не схлопывает: это адрес другого хоста, а не путь', () => {
    // Раньше здесь ожидалось `//otkrytki` → `/otkrytki`. Ожидание закрепляло
    // дыру: `//host/x` — абсолютный адрес другого хоста, и схлопывание делало
    // чужой хост первым сегментом пути незаметно для вызывающего кода.
    expect(() => canonicalizePath('//otkrytki')).toThrow(/хост/i);
  });

  it('идемпотентен', () => {
    for (const path of ['/', '/otkrytki/8-marta/', '/robots.txt', 'media/x-640.webp', '']) {
      const once = canonicalizePath(path);
      expect(canonicalizePath(once), path).toBe(once);
    }
  });
});

/**
 * Протокольно-относительный адрес (`//host/x`) — находка ревизии от 2026-08-22.
 *
 * Схемы в такой строке нет, поэтому прежний `looksLikeAbsoluteUrl` пропускал её
 * насквозь, а `canonicalizePath` схлопывал ведущий двойной слеш и превращал
 * ЧУЖОЙ ХОСТ в первый сегмент пути. Для браузера и краулера `//host/x` — это
 * абсолютный адрес другого хоста, то есть так можно получить canonical или
 * редирект на чужой домен, причём ошибка невидима: путь выглядит валидным.
 *
 * Правило живёт здесь, рядом с `looksLikeAbsoluteUrl`, а не в потребителе:
 * второй потребитель (`apps/web`, этап 3) про локальную проверку в `apps/cms`
 * не узнал бы.
 */
describe('isProtocolRelativeUrl: адрес другого хоста без схемы', () => {
  const foreign = [
    '//host.example.invalid/x',
    '//host.example.invalid',
    '///host.example.invalid/x',
    '////host.example.invalid',
    '//host.example.invalid/otkrytki/8-marta',
    '//user@host.example.invalid/x',
    // Обратный слеш браузеры приводят к прямому: все четыре формы дают //host.
    '\\\\host.example.invalid\\x',
    '\\/host.example.invalid/x',
    '/\\host.example.invalid/x',
    '\\/\\/host.example.invalid',
    // Ведущие пробелы и управляющие символы адрес не меняют — их обрезают.
    '  //host.example.invalid/x',
    '\t//host.example.invalid/x',
    '\n//host.example.invalid/x',
    // Tab и перевод строки удаляются ИЗ СЕРЕДИНЫ адреса, поэтому `/<tab>/host`
    // для браузера тот же `//host`.
    '/\t/host.example.invalid/x',
    '/\n/host.example.invalid/x',
  ];

  for (const value of foreign) {
    it(`распознаёт как чужой хост: ${JSON.stringify(value)}`, () => {
      expect(isProtocolRelativeUrl(value)).toBe(true);
    });
  }

  const paths = [
    '',
    '/',
    '/otkrytki',
    '/otkrytki/8-marta',
    // Двойной слеш В СЕРЕДИНЕ — это опечатка в пути, а не второй хост.
    '/a//b',
    '/otkrytki//8-marta',
    '/otkrytki/prazdniki///8-marta',
    'media/cards/r2/otkrytka-640.webp',
    '/robots.txt',
    // Схема — другой случай, его ловит looksLikeAbsoluteUrl.
    'https://host.example.invalid/x',
    'mailto:redaktor@host.example.invalid',
  ];

  for (const value of paths) {
    it(`не задевает обычный вход: ${JSON.stringify(value)}`, () => {
      expect(isProtocolRelativeUrl(value)).toBe(false);
    });
  }
});

describe('looksLikeAbsoluteUrl: любой абсолютный адрес, а не только со схемой', () => {
  it('видит схему', () => {
    for (const value of [
      'https://host.example.invalid/x',
      'HTTP://host.example.invalid',
      'ftp://host.example.invalid',
      'mailto:redaktor@host.example.invalid',
      'javascript:alert(1)',
      '  https://host.example.invalid/x  ',
    ]) {
      expect(looksLikeAbsoluteUrl(value), value).toBe(true);
    }
  });

  it('видит протокольно-относительный адрес: схемы нет, а хост чужой', () => {
    for (const value of [
      '//host.example.invalid/x',
      '//host.example.invalid',
      '///host.example.invalid/x',
      '\\\\host.example.invalid\\x',
      '\\/\\/host.example.invalid',
      ' //host.example.invalid/x',
      '/\t/host.example.invalid/x',
    ]) {
      expect(looksLikeAbsoluteUrl(value), value).toBe(true);
    }
  });

  it('путь абсолютным адресом не считает', () => {
    for (const value of [
      '',
      '/',
      '/otkrytki',
      '/otkrytki/8-marta',
      '/a//b',
      'media/cards/r2/otkrytka-640.webp',
      '/robots.txt',
      '/otkrytki/v1.5',
    ]) {
      expect(looksLikeAbsoluteUrl(value), value).toBe(false);
    }
  });
});

describe('функции пути отклоняют протокольно-относительный вход', () => {
  const foreign = [
    '//host.example.invalid/x',
    '//host.example.invalid',
    '///host.example.invalid/x',
    '\\/\\/host.example.invalid',
    '/\\host.example.invalid/x',
  ];

  for (const value of foreign) {
    it(`canonicalizePath не схлопывает ${JSON.stringify(value)} в путь`, () => {
      expect(() => canonicalizePath(value)).toThrow(/хост/i);
    });

    it(`pathSegments отклоняет ${JSON.stringify(value)}`, () => {
      expect(() => pathSegments(value)).toThrow(/хост/i);
    });

    it(`isPageRoute отклоняет ${JSON.stringify(value)}`, () => {
      expect(() => isPageRoute(value)).toThrow(/хост/i);
    });
  }

  it('двойной слеш в середине по-прежнему обрабатывается как раньше', () => {
    expect(canonicalizePath('/a//b')).toBe('/a/b');
    expect(canonicalizePath('/otkrytki//8-marta')).toBe('/otkrytki/8-marta');
    expect(canonicalizePath('/otkrytki///prazdniki//8-marta')).toBe(
      '/otkrytki/prazdniki/8-marta',
    );
    expect(pathSegments('/a//b')).toEqual(['a', 'b']);
    expect(isPageRoute('/otkrytki//8-marta')).toBe(true);
  });

  it('сообщение объясняет, что это адрес другого хоста', () => {
    expect(() => canonicalizePath('//host.example.invalid/x')).toThrow(/друг/i);
  });
});
