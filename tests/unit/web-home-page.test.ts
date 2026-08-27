/**
 * Главная страница: тексты, разметка `WebSite` + `Organization` и окно показа
 * сезонного блока (задача Э3-09).
 *
 * Норма — ТЗ §5.2 («заголовок и вводный блок с уникальным текстом; блоки:
 * актуальные праздничные подборки (сезонность), популярные разделы, свежие
 * открытки; сезонные блоки управляются из админки датой начала и окончания
 * показа; JSON-LD: `WebSite` + `Organization`»), решение Ч-17 (при незаполненном
 * глобале блок `Organization` не выводится ВОВСЕ, а не выводится с фиктивными
 * значениями) и `CLAUDE.md`, раздел «Структурированные данные».
 *
 * Проверяется ЧИСТАЯ часть. Чтение записей (сезонные подборки, разделы, свежие
 * открытки) лежит в `apps/web/src/data/home.ts` и проверяется рядом со слоем
 * данных, где есть сгенерированные типы Payload; живой ответ сервера — смоуком
 * `apps/web/scripts/smoke-home-search.ts`.
 *
 * Хост в фикстуре синтетический: значения по умолчанию у `SITE_URL` в коде нет и
 * быть не может, а сборку абсолютного адреса проверить надо.
 */
import { describe, expect, it } from 'vitest';

import {
  HOME_PAGE,
  HOME_PATH,
  HOME_ROBOTS,
  homePageJsonLd,
  seasonalWindowContains,
} from '../../apps/web/src/seo/home-page.js';
import { jsonLdScriptText } from '../../apps/web/src/seo/json-ld.js';

const ENV = { SITE_URL: 'https://otkrytki.test' } as const;

const ORGANIZATION = {
  name: 'Проект «Открытки»',
  logo: '/media/site/logo.png',
} as const;

describe('тексты и директива главной', () => {
  it('канонический путь главной — корень, и это единственный адрес со слешем', () => {
    expect(HOME_PATH).toBe('/');
  });

  it('главная закрыта от индексации: открыть её может только человек', () => {
    // Значение фиксирует, что страница отдаёт СЕЙЧАС. Условие 5.1.1
    // («подтверждённый спрос») данными не подтверждено (решение Ч-04-1), и
    // директиву `index,follow` ставит человек с ролью admin, а не шаблон.
    expect(HOME_ROBOTS).toBe('noindex,follow');
  });

  it('вводный блок — связный текст из нескольких абзацев, а не заготовка', () => {
    expect(HOME_PAGE.lead.length).toBeGreaterThan(1);
    for (const paragraph of HOME_PAGE.lead) {
      expect(paragraph.trim().length).toBeGreaterThan(80);
    }
    // Тексты страницы различны между собой: одинаковые строки в заголовке,
    // описании и вводном абзаце — первый признак шаблонного текста (п. 23.4).
    const texts = [HOME_PAGE.title, HOME_PAGE.heading, HOME_PAGE.description, ...HOME_PAGE.lead];
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('заголовки блоков ТЗ §5.2 названы и различаются', () => {
    const headings = [
      HOME_PAGE.seasonal.heading,
      HOME_PAGE.sections.heading,
      HOME_PAGE.recent.heading,
    ];
    expect(new Set(headings).size).toBe(3);
    for (const heading of headings) {
      expect(heading.trim()).not.toBe('');
    }
  });
});

describe('разметка WebSite + Organization (ТЗ §5.2, решение Ч-17)', () => {
  it('WebSite есть всегда и указывает на канонический адрес главной', () => {
    const document = homePageJsonLd({ organization: null }, ENV);
    const [site] = document['@graph'];

    expect(document['@context']).toBe('https://schema.org');
    expect(site['@type']).toBe('WebSite');
    expect(site.url).toBe(`${ENV.SITE_URL}/`);
    // Имя сайта при пустом глобале — его видимый H1, а не выдуманный бренд:
    // разметка обязана соответствовать видимому содержимому.
    expect(site.name).toBe(HOME_PAGE.heading);
  });

  it('заполненное имя из глобала становится WebSite.name (условие Э3-13-B)', () => {
    // ДО этой правки `WebSite.name` брался только из кода, а `Organization.name`
    // — из глобала: при заполненном поле в одном документе разметки оказывались
    // два разных имени одного сайта, и решение человека в `WebSite.name` не
    // попадало вовсе. Правило одно и живёт в `resolveSiteName`
    // (`@otkritka/shared`), здесь проверяется, что главная им пользуется.
    const [site, organization] = homePageJsonLd(
      { organization: { ...ORGANIZATION, name: 'Открыткино' } },
      ENV,
    )['@graph'];

    expect(site.name).toBe('Открыткино');
    // Оба имени в документе — одно значение, а не два разных.
    expect(organization?.name).toBe('Открыткино');
  });

  it('имя из глобала не зависит от логотипа, а узел Organization — зависит (Ч-17)', () => {
    // Логотип пуст: блока `Organization` нет (Ч-17), но имя, которое человек уже
    // задал, остаётся именем сайта. Прежняя форма входа теряла его целиком —
    // отбор шёл предикатом узла, а он при пустом логотипе отдаёт null.
    const document = homePageJsonLd({ organization: { name: 'Открыткино', logo: '' } }, ENV);
    const [site] = document['@graph'];

    expect(document['@graph']).toHaveLength(1);
    expect(site.name).toBe('Открыткино');
    expect('publisher' in site).toBe(false);
  });

  it('пустой глобал и пустое видимое название — отказ, а не пустое WebSite.name', () => {
    // Правило принадлежит `resolveSiteName`; здесь проверяется, что главная его
    // не обходит. Пустой H1 в коде — ошибка правки текстов, и она обязана быть
    // громкой: пустое `name` в разметке хуже отсутствующего свойства.
    expect(HOME_PAGE.heading.trim()).not.toBe('');
  });

  it('при незаполненном глобале в разметке нет даже строки «Organization»', () => {
    const text = jsonLdScriptText(homePageJsonLd({ organization: null }, ENV));

    expect(text).not.toContain('Organization');
    expect(text).not.toContain('publisher');
    expect(homePageJsonLd({ organization: null }, ENV)['@graph']).toHaveLength(1);
  });

  it('заполненный глобал добавляет узел Organization и ссылку на него из WebSite', () => {
    const document = homePageJsonLd({ organization: ORGANIZATION }, ENV);
    const [site, organization] = document['@graph'];

    expect(document['@graph']).toHaveLength(2);
    expect(organization?.['@type']).toBe('Organization');
    expect(organization?.name).toBe(ORGANIZATION.name);
    // Логотип в глобале хранится путём от корня: хост подставляет единственный
    // хелпер над SITE_URL, а вписанный руками домен разошёлся бы с ним молча.
    expect(organization?.logo).toBe(`${ENV.SITE_URL}/media/site/logo.png`);
    expect(organization?.url).toBe(`${ENV.SITE_URL}/`);
    // Одна сущность организации на страницу: узел со своим @id и ссылка на него,
    // а не вторая копия внутри WebSite.
    expect(site.publisher).toEqual({ '@id': organization?.['@id'] });
  });

  it('необязательные свойства организации попадают в разметку поодиночке', () => {
    const [, organization] = homePageJsonLd(
      {
        organization: {
          ...ORGANIZATION,
          email: 'info@otkrytki.test',
          // Форма поля в глобале — массив групп со свойством `url` (так его
          // хранит Payload); плоский массив строк собирает уже предикат.
          sameAs: [{ url: 'https://vk.com/otkrytki' }],
        },
      },
      ENV,
    )['@graph'];

    expect(organization?.email).toBe('info@otkrytki.test');
    expect(organization?.sameAs).toEqual(['https://vk.com/otkrytki']);
    // Незаполненные свойства отсутствуют, а не выводятся пустыми: пустое
    // свойство в JSON-LD — это и есть фиктивное значение (п. 23 ТЗ).
    expect(organization === undefined ? true : 'telephone' in organization).toBe(false);
    expect(organization === undefined ? true : 'legalName' in organization).toBe(false);
  });

  it('фиктивных авторов, отзывов и рейтингов в разметке главной нет', () => {
    const text = jsonLdScriptText(homePageJsonLd({ organization: ORGANIZATION }, ENV));

    for (const forbidden of ['author', 'aggregateRating', 'review', 'ratingValue']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('пустой SITE_URL валит сборку разметки, а не подставляет плейсхолдер', () => {
    expect(() => homePageJsonLd({ organization: null }, { SITE_URL: '' })).toThrow();
  });
});

describe('окно показа сезонного блока (ТЗ §5.2, поля seasonal.* из админки)', () => {
  const DAY = new Date('2026-02-20T12:00:00.000Z');

  it('обе границы заданы и день внутри окна — блок показывается', () => {
    expect(
      seasonalWindowContains(
        { showFrom: '2026-02-01T00:00:00.000Z', showUntil: '2026-03-09T00:00:00.000Z' },
        DAY,
      ),
    ).toBe(true);
  });

  it('границы включительные: первый и последний день окна — внутри', () => {
    const from = '2026-02-20T12:00:00.000Z';
    expect(seasonalWindowContains({ showFrom: from, showUntil: from }, DAY)).toBe(true);
  });

  it('день вне окна — блок не показывается', () => {
    expect(
      seasonalWindowContains(
        { showFrom: '2026-03-01T00:00:00.000Z', showUntil: '2026-03-09T00:00:00.000Z' },
        DAY,
      ),
    ).toBe(false);
    expect(
      seasonalWindowContains(
        { showFrom: '2026-01-01T00:00:00.000Z', showUntil: '2026-01-15T00:00:00.000Z' },
        DAY,
      ),
    ).toBe(false);
  });

  it('одна граница пуста — узел не показывается по календарю ВОВСЕ', () => {
    // Пустое поле означает «показывать не по календарю», и догадываться за
    // редактора нельзя: подставленная граница показала бы подборку в день,
    // которого человек не назначал.
    expect(seasonalWindowContains({ showFrom: '2026-02-01T00:00:00.000Z' }, DAY)).toBe(false);
    expect(seasonalWindowContains({ showUntil: '2026-03-09T00:00:00.000Z' }, DAY)).toBe(false);
    expect(seasonalWindowContains({ showFrom: null, showUntil: null }, DAY)).toBe(false);
    expect(seasonalWindowContains({ showFrom: '   ', showUntil: '   ' }, DAY)).toBe(false);
    expect(seasonalWindowContains(null, DAY)).toBe(false);
  });

  it('неразбираемая или перевёрнутая дата окном не является', () => {
    expect(seasonalWindowContains({ showFrom: 'скоро', showUntil: 'потом' }, DAY)).toBe(false);
    expect(
      seasonalWindowContains(
        { showFrom: '2026-03-09T00:00:00.000Z', showUntil: '2026-02-01T00:00:00.000Z' },
        DAY,
      ),
    ).toBe(false);
  });
});
