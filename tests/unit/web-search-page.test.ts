/**
 * Внутренний поиск `/search`: голова документа, нормализация запроса, крошки
 * (задача Э3-10).
 *
 * Норма: ТЗ §5.5 («поиск по названию, подписи, атрибутам; страница результатов:
 * `noindex`, закрыта в robots.txt, вне sitemap»), ТЗ §6.5 («любой URL с
 * параметрами отдаёт canonical на базовый путь без параметров»), `CLAUDE.md` —
 * «Правила индексации» (внутренний поиск — всегда `noindex` и вне sitemap) и
 * реестр зарезервированных маршрутов (`/search` занят целиком).
 *
 * Здесь проверяется ЧИСТАЯ часть. Выполнение самого поиска лежит в
 * `apps/web/src/data/search.ts`, живой ответ — смоук
 * `apps/web/scripts/smoke-home-search.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  SEARCH_MAX_QUERY_LENGTH,
  SEARCH_MIN_QUERY_LENGTH,
  SEARCH_PAGE,
  SEARCH_PATH,
  SEARCH_QUERY_PARAM,
  SEARCH_ROBOTS,
  normalizeSearchQuery,
  searchBreadcrumbTrail,
  searchPageView,
} from '../../apps/web/src/seo/search-page.js';

describe('адрес и директива страницы поиска', () => {
  it('маршрут — /search без завершающего слеша, параметр запроса — q', () => {
    expect(SEARCH_PATH).toBe('/search');
    expect(SEARCH_QUERY_PARAM).toBe('q');
  });

  it('поиск закрыт от индексации ВСЕГДА — и с запросом, и без него', () => {
    expect(SEARCH_ROBOTS).toBe('noindex,follow');
    expect(searchPageView(null).robots).toBe(SEARCH_ROBOTS);
    expect(searchPageView('тюльпаны').robots).toBe(SEARCH_ROBOTS);
  });

  it('canonical не зависит от запроса: он всегда чистый /search', () => {
    // Требование ТЗ §6.5: любой URL с параметрами отдаёт canonical на базовый
    // путь. У страницы поиска это единственный её адрес.
    expect(searchPageView(null).canonicalPath).toBe(SEARCH_PATH);
    expect(searchPageView('тюльпаны').canonicalPath).toBe(SEARCH_PATH);
    expect(searchPageView('8 марта маме').canonicalPath).toBe(SEARCH_PATH);
  });

  it('title и H1 от запроса не зависят: страница одна', () => {
    const empty = searchPageView(null);
    const filled = searchPageView('тюльпаны');

    expect(filled.title).toBe(empty.title);
    expect(filled.heading).toBe(empty.heading);
    expect(empty.heading.trim()).not.toBe('');
  });
});

describe('нормализация запроса', () => {
  it('пустой запрос и пробелы — это отсутствие запроса', () => {
    expect(normalizeSearchQuery(null)).toBeNull();
    expect(normalizeSearchQuery('')).toBeNull();
    expect(normalizeSearchQuery('   ')).toBeNull();
  });

  it('слишком короткий запрос запросом не считается', () => {
    expect(normalizeSearchQuery('т')).toBeNull();
    expect(normalizeSearchQuery('т'.repeat(SEARCH_MIN_QUERY_LENGTH))).toBe(
      'т'.repeat(SEARCH_MIN_QUERY_LENGTH),
    );
  });

  it('края обрезаются, внутренние пробелы схлопываются', () => {
    expect(normalizeSearchQuery('  открытка   маме \n на 8 марта ')).toBe(
      'открытка маме на 8 марта',
    );
  });

  it('слишком длинный запрос усекается, а не отвергается', () => {
    const long = 'а'.repeat(SEARCH_MAX_QUERY_LENGTH + 50);

    expect(normalizeSearchQuery(long)).toHaveLength(SEARCH_MAX_QUERY_LENGTH);
  });
});

describe('крошки и тексты страницы', () => {
  it('крошки: главная → поиск, текущее звено ссылкой не является', () => {
    const trail = searchBreadcrumbTrail();

    expect(trail.map((item) => item.label)).toEqual(['Главная', SEARCH_PAGE.heading]);
    // Текущее звено — без ссылки (ТЗ §7.6), главная — со ссылкой.
    expect(trail.at(-1)?.linked).toBe(false);
    expect(trail.at(0)?.linked).toBe(true);
  });

  it('видимые подписи формы и пустой выдачи заполнены', () => {
    for (const text of [
      SEARCH_PAGE.heading,
      SEARCH_PAGE.title,
      SEARCH_PAGE.description,
      SEARCH_PAGE.lead,
      SEARCH_PAGE.fieldLabel,
      SEARCH_PAGE.submitLabel,
      SEARCH_PAGE.nothingFound,
      SEARCH_PAGE.cardsLabel,
      SEARCH_PAGE.collectionsLabel,
    ]) {
      expect(text.trim()).not.toBe('');
    }
  });
});
