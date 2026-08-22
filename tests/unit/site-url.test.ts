import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildAbsoluteUrl, resolveSiteOrigin, SITE_URL_ENV_KEY } from '@otkritka/shared';

/**
 * Задача Э1-01 (остаток): единственный на монорепозиторий хелпер сборки
 * абсолютного URL.
 *
 * Норма — `CLAUDE.md`, раздел «Правила URL»: любой абсолютный URL (canonical,
 * sitemap, robots, JSON-LD, `contentUrl` изображений) собирается ТОЛЬКО из
 * `SITE_URL` через этот хелпер. Хост не хардкодится: ни дефолта, ни фолбэка,
 * включая локальный и тестовый. Пустое значение обязано валить сборку с внятной
 * ошибкой, а не подставлять плейсхолдер: иначе canonical и sitemap молча
 * соберутся не на том хосте, и после индексации это необратимо.
 *
 * Хост в фикстуре — СИНТЕТИЧЕСКИЙ и намеренный: им проверяется сама сборка URL,
 * а зона `.invalid` (RFC 2606) гарантирует, что это не чей-то реальный домен и
 * не значение из `.env`. Реальное значение (решение Ч-02) в коде и в тестах не
 * появляется — оно приходит из окружения.
 */

const FIXTURE_ORIGIN = 'https://cards.example.invalid';
const envWith = (value: string): Record<string, string> => ({ [SITE_URL_ENV_KEY]: value });

describe('resolveSiteOrigin: чтение и нормализация SITE_URL', () => {
  it('возвращает схему и хост без завершающего слеша', () => {
    expect(resolveSiteOrigin(envWith(FIXTURE_ORIGIN))).toBe(FIXTURE_ORIGIN);
  });

  it('нормализует хвостовой слеш у значения — это обязанность хелпера, а не автора .env', () => {
    expect(resolveSiteOrigin(envWith(`${FIXTURE_ORIGIN}/`))).toBe(FIXTURE_ORIGIN);
    expect(resolveSiteOrigin(envWith(`${FIXTURE_ORIGIN}///`))).toBe(FIXTURE_ORIGIN);
    expect(resolveSiteOrigin(envWith(`  ${FIXTURE_ORIGIN}/  `))).toBe(FIXTURE_ORIGIN);
  });

  it('сохраняет порт: он часть авторитета, а не путь', () => {
    expect(resolveSiteOrigin(envWith('http://cards.example.invalid:4321/'))).toBe(
      'http://cards.example.invalid:4321',
    );
  });

  it('приводит хост к нижнему регистру, оставляя ровно один хост', () => {
    expect(resolveSiteOrigin(envWith('https://Cards.Example.INVALID'))).toBe(FIXTURE_ORIGIN);
  });

  it('валит сборку на пустом значении и называет параметр', () => {
    for (const value of ['', '   ']) {
      expect(() => resolveSiteOrigin(envWith(value))).toThrow(new RegExp(SITE_URL_ENV_KEY));
    }
    expect(() => resolveSiteOrigin({})).toThrow(new RegExp(SITE_URL_ENV_KEY));
  });

  it('в сообщении об ошибке нет подставленного хоста — только требование задать его', () => {
    let message = '';
    try {
      resolveSiteOrigin({});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe('');
    expect(message).toMatch(/по умолчанию|дефолт/i);
    expect(message.toLowerCase()).not.toContain('localhost');
    expect(message).not.toMatch(/127\.0\.0\.1/);
  });

  const invalid: ReadonlyArray<readonly [string, string]> = [
    ['путь в значении — хост обязан быть один и без базового пути', `${FIXTURE_ORIGIN}/otkrytki`],
    ['параметры запроса', `${FIXTURE_ORIGIN}/?utm=1`],
    ['фрагмент', `${FIXTURE_ORIGIN}/#top`],
    ['логин и пароль в авторитете', 'https://user:pass@cards.example.invalid'],
    ['не http(s)', 'ftp://cards.example.invalid'],
    ['без схемы', 'cards.example.invalid'],
    ['две схемы', 'https://https://cards.example.invalid'],
    ['пробел внутри', 'https://cards example.invalid'],
    ['только схема', 'https://'],
  ];

  for (const [label, value] of invalid) {
    it(`отклоняет некорректное значение: ${label}`, () => {
      expect(() => resolveSiteOrigin(envWith(value))).toThrow(new RegExp(SITE_URL_ENV_KEY));
    });
  }
});

describe('buildAbsoluteUrl: сборка абсолютного URL', () => {
  it('даёт абсолютный URL с единственным хостом из SITE_URL', () => {
    const url = buildAbsoluteUrl('/otkrytki/8-marta', envWith(FIXTURE_ORIGIN));
    expect(url).toBe(`${FIXTURE_ORIGIN}/otkrytki/8-marta`);
    expect(url.startsWith('https://')).toBe(true);
    // Хост встречается ровно один раз: склейка не должна порождать
    // `https://host/https://host/...`.
    expect(url.split('cards.example.invalid')).toHaveLength(2);
  });

  it('склеивает путь страницы по правилу слеша: канонический вид без завершающего слеша', () => {
    expect(buildAbsoluteUrl('/otkrytki/8-marta/', envWith(FIXTURE_ORIGIN))).toBe(
      `${FIXTURE_ORIGIN}/otkrytki/8-marta`,
    );
    expect(buildAbsoluteUrl('/otkrytki/prazdniki/8-marta/mame/', envWith(FIXTURE_ORIGIN))).toBe(
      `${FIXTURE_ORIGIN}/otkrytki/prazdniki/8-marta/mame`,
    );
  });

  it('URL файла оставляет как есть — правило слеша к файлам не применяется', () => {
    expect(
      buildAbsoluteUrl('/media/cards/r2/otkrytka-640.webp', envWith(FIXTURE_ORIGIN)),
    ).toBe(`${FIXTURE_ORIGIN}/media/cards/r2/otkrytka-640.webp`);
    expect(buildAbsoluteUrl('/sitemap.xml', envWith(FIXTURE_ORIGIN))).toBe(
      `${FIXTURE_ORIGIN}/sitemap.xml`,
    );
    expect(buildAbsoluteUrl('/robots.txt', envWith(FIXTURE_ORIGIN))).toBe(
      `${FIXTURE_ORIGIN}/robots.txt`,
    );
  });

  it('принимает ключ объекта без ведущего слеша: так их отдаёт packages/images', () => {
    expect(
      buildAbsoluteUrl('media/cards/r2/otkrytka-640.webp', envWith(FIXTURE_ORIGIN)),
    ).toBe(`${FIXTURE_ORIGIN}/media/cards/r2/otkrytka-640.webp`);
  });

  it('главная страница даёт origin со слешем — это её canonical', () => {
    expect(buildAbsoluteUrl('/', envWith(FIXTURE_ORIGIN))).toBe(`${FIXTURE_ORIGIN}/`);
    expect(buildAbsoluteUrl('', envWith(FIXTURE_ORIGIN))).toBe(`${FIXTURE_ORIGIN}/`);
  });

  it('схлопывает повторные слеши: одна страница — один URL', () => {
    expect(buildAbsoluteUrl('//otkrytki//8-marta', envWith(FIXTURE_ORIGIN))).toBe(
      `${FIXTURE_ORIGIN}/otkrytki/8-marta`,
    );
  });

  it('отказывает на пустом SITE_URL, а не собирает URL на плейсхолдере', () => {
    expect(() => buildAbsoluteUrl('/otkrytki/8-marta', {})).toThrow(
      new RegExp(SITE_URL_ENV_KEY),
    );
    expect(() => buildAbsoluteUrl('/otkrytki/8-marta', envWith(''))).toThrow(
      new RegExp(SITE_URL_ENV_KEY),
    );
  });

  it('отклоняет параметры и фрагмент в пути: канонический URL их не содержит', () => {
    expect(() => buildAbsoluteUrl('/otkrytki?sort=new', envWith(FIXTURE_ORIGIN))).toThrow(
      /параметр|фрагмент/i,
    );
    expect(() => buildAbsoluteUrl('/otkrytki#top', envWith(FIXTURE_ORIGIN))).toThrow(
      /параметр|фрагмент/i,
    );
  });

  it('отклоняет абсолютный URL на входе: второй хост в путь не попадает', () => {
    expect(() =>
      buildAbsoluteUrl('https://other.example.invalid/otkrytki', envWith(FIXTURE_ORIGIN)),
    ).toThrow(/путь/i);
  });

  it('протокол-относительный вход не подменяет хост', () => {
    // `//other.example.invalid/x` в браузере означает другой хост. Здесь это
    // просто путь с повторным слешем, и хост остаётся один — из SITE_URL.
    expect(buildAbsoluteUrl('//other.example.invalid/x', envWith(FIXTURE_ORIGIN))).toBe(
      `${FIXTURE_ORIGIN}/other.example.invalid/x`,
    );
  });

  it('идемпотентен по хосту: повторная сборка того же пути даёт тот же URL', () => {
    const first = buildAbsoluteUrl('/otkrytki/8-marta', envWith(FIXTURE_ORIGIN));
    const second = buildAbsoluteUrl('/otkrytki/8-marta', envWith(`${FIXTURE_ORIGIN}/`));
    expect(second).toBe(first);
  });
});

describe('запрет хардкода хоста в packages/shared', () => {
  it('в исходниках нет ни локального, ни тестового хоста как значения по умолчанию', () => {
    const srcDir = fileURLToPath(new URL('../../packages/shared/src/', import.meta.url));
    const files = readdirSync(srcDir).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = readFileSync(join(srcDir, file), 'utf8');
      expect(source.toLowerCase(), file).not.toContain('localhost');
      expect(source, file).not.toMatch(/127\.0\.0\.1/);
      expect(source.toLowerCase(), file).not.toContain('otkritka.test');
    }
  });
});
