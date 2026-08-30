/**
 * Каталоги разделов `/otkrytki` и `/podborki` и навигация сайта (задача Э3-08).
 *
 * Норма: `CLAUDE.md` — «Правила URL» (`/otkrytki` и `/podborki` — контейнеры
 * реестра зарезервированных маршрутов, пути под ними — норма), «Рендеринг»
 * (навигация только `<a href>`, всё в HTML-ответе сервера), «Правила индексации»
 * (открыть страницу в `index,follow` может только человек), ТЗ §7.6 (крошки), а
 * также следствие Ч-04-5: требование «≤ 4 перехода от главной» держится на
 * прямых ссылках из меню и с главной на группирующие узлы.
 *
 * Каталоги — МАРШРУТЫ Astro, а не записи CMS, поэтому их title, H1, описание и
 * вводный текст живут в коде и проверяются здесь. Правило «текст звена крошек
 * совпадает с H1 целевой страницы» — тоже: это единственная связь, из-за
 * расхождения которой крошка ведёт на страницу с другим заголовком.
 */
import { describe, expect, it } from 'vitest';

import { checkReservedPath, PAGINATION_SEGMENT } from '@otkritka/shared';

import {
  CATALOG_KEYS,
  CATALOGS,
  catalogBreadcrumbTrail,
  catalogPageView,
  SITE_NAV,
} from '../../apps/web/src/seo/catalog-pages.js';

describe('факты каталогов раздела', () => {
  it('пути каталогов — контейнеры реестра зарезервированных маршрутов', () => {
    for (const key of CATALOG_KEYS) {
      const availability = checkReservedPath(CATALOGS[key].path, {
        PAYLOAD_ADMIN_PATH: '/admin',
      });

      // Запись CMS с таким итоговым путём создать нельзя, а пути под ним — норма.
      // Правило живёт в `packages/shared` и здесь только проверяется: второй его
      // копии в apps/web быть не должно.
      expect(availability).toMatchObject({ available: false, rule: 'container-path' });
    }
  });

  it('каталоги живут в канонической форме: без завершающего слеша', () => {
    expect(CATALOGS.cards.path).toBe('/otkrytki');
    expect(CATALOGS.collections.path).toBe('/podborki');
  });

  it('у каждого каталога свои непустые title, H1 и описание', () => {
    const titles = CATALOG_KEYS.map((key) => CATALOGS[key].title);
    const headings = CATALOG_KEYS.map((key) => CATALOGS[key].heading);
    const descriptions = CATALOG_KEYS.map((key) => CATALOGS[key].description);

    for (const values of [titles, headings, descriptions]) {
      expect(values.every((value) => value.trim() !== '')).toBe(true);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it('вводный абзац каталога — видимый текст страницы, а не пустая строка', () => {
    for (const key of CATALOG_KEYS) {
      expect(CATALOGS[key].lead.trim().length).toBeGreaterThan(40);
    }
  });
});

describe('страница каталога', () => {
  it('первая страница: self-canonical на сам каталог, описание есть', () => {
    const view = catalogPageView('cards', 1);

    expect(view.canonicalPath).toBe('/otkrytki');
    expect(view.heading).toBe(CATALOGS.cards.heading);
    expect(view.title).toBe(CATALOGS.cards.title);
    expect(view.metaDescription).toBe(CATALOGS.cards.description);
  });

  it('каталог не открывается в index,follow кодом: это решение человека', () => {
    for (const key of CATALOG_KEYS) {
      expect(catalogPageView(key, 1).robots).toBe('noindex,follow');
    }
  });

  it('страница пагинации каталога: self-canonical указывает на САМУ СЕБЯ', () => {
    const view = catalogPageView('cards', 3);

    expect(view.canonicalPath).toBe(`/otkrytki/${PAGINATION_SEGMENT}/3`);
    expect(view.robots).toBe('noindex,follow');
  });

  it('на страницах пагинации title и H1 не повторяют первую страницу', () => {
    const first = catalogPageView('cards', 1);
    const second = catalogPageView('cards', 2);

    expect(second.title).not.toBe(first.title);
    expect(second.heading).not.toBe(first.heading);
    expect(second.title).toContain('страница 2');
  });

  it('описание на страницах пагинации не выводится вовсе, а не повторяется', () => {
    expect(catalogPageView('cards', 2).metaDescription).toBeNull();
  });
});

describe('крошки каталога', () => {
  it('текст звена совпадает с H1 каталога — иначе крошка ведёт на другой заголовок', () => {
    for (const key of CATALOG_KEYS) {
      const trail = catalogBreadcrumbTrail(key, 1);
      const current = trail.at(-1);

      expect(current?.label).toBe(CATALOGS[key].heading);
      expect(current?.path).toBe(CATALOGS[key].path);
      expect(current?.linked).toBe(false);
    }
  });

  it('цепочка начинается главной и состоит из двух звеньев: каталог лежит на первом уровне', () => {
    const trail = catalogBreadcrumbTrail('collections', 1);

    expect(trail.map((item) => item.path)).toEqual(['/', '/podborki']);
    expect(trail[0]?.linked).toBe(true);
  });

  it('на странице пагинации каталог становится ссылкой, текущая крошка — номер', () => {
    const trail = catalogBreadcrumbTrail('cards', 2);

    expect(trail.map((item) => item.path)).toEqual([
      '/',
      '/otkrytki',
      `/otkrytki/${PAGINATION_SEGMENT}/2`,
    ]);
    expect(trail[1]?.linked).toBe(true);
    expect(trail.at(-1)?.label).toBe('Страница 2');
    expect(trail.at(-1)?.linked).toBe(false);
  });
});

describe('навигация сайта', () => {
  it('в меню есть оба каталога — ссылками на канонические пути', () => {
    const paths = SITE_NAV.map((link) => link.path);

    expect(paths).toContain('/otkrytki');
    expect(paths).toContain('/podborki');
  });

  it('первым звеном меню идёт главная', () => {
    expect(SITE_NAV[0]?.path).toBe('/');
  });

  it('текст пункта меню совпадает с H1 каталога: один источник на оба места', () => {
    for (const key of CATALOG_KEYS) {
      const link = SITE_NAV.find((item) => item.path === CATALOGS[key].path);

      expect(link?.label).toBe(CATALOGS[key].heading);
    }
  });

  it('в меню нет ни одного адреса пагинации и ни одного повтора', () => {
    const paths = SITE_NAV.map((link) => link.path);

    expect(paths.some((path) => path.includes(`/${PAGINATION_SEGMENT}/`))).toBe(false);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
