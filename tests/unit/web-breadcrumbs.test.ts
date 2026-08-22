/**
 * Хлебные крошки: цепочка от главной и разметка `BreadcrumbList` (задача Э3-03).
 *
 * Норма — ТЗ §7.6 («на всех страницах глубже главной; отражают иерархию;
 * текущая страница — без ссылки; разметка `BreadcrumbList`»), §5.4 («крошки от
 * главной по основной подборке»), `CLAUDE.md` (раздел «Рендеринг»: крошки
 * присутствуют в HTML-ответе сервера; навигация только `<a href>`) и раздел
 * «Структурированные данные» («разметка соответствует видимому содержимому»).
 *
 * Проверяется ЧИСТАЯ часть — сборка цепочки и сборка JSON-LD из неё. Компонент
 * `apps/web/src/components/Breadcrumbs.astro` поверх этих функций только
 * печатает разметку: он берёт `<a href>` и `name` из ОДНОГО значения, поэтому
 * расхождение «видимые крошки против JSON-LD» невозможно по построению, а не по
 * обещанию. Именно это свойство здесь и закодировано: тест сравнивает
 * `itemListElement` с цепочкой один к одному.
 *
 * Адаптеры «запись CMS → звено цепочки» и обход родителей живут в слое данных
 * (`apps/web/src/data/breadcrumbs.ts`) и проверяются рядом с ним: им нужны
 * СГЕНЕРИРОВАННЫЕ типы Payload, а модуль с импортом `.ts` из чужого пакета в
 * composite-проект `apps/web/tsconfig.node.json` войти не может (то же
 * ограничение и то же решение, что у `apps/web/src/data/data-access.test.ts`).
 *
 * Хост в фикстурах синтетический — так и требует `CLAUDE.md`: значения по
 * умолчанию у хоста нет, а сборку абсолютного URL проверить надо.
 */
import { describe, expect, it } from 'vitest';

import {
  breadcrumbListJsonLd,
  buildBreadcrumbTrail,
  HOME_CRUMB,
  jsonLdScriptText,
} from '../../apps/web/src/seo/breadcrumbs.js';

/** Синтетический хост фикстуры. Дефолта у `SITE_URL` в коде нет и быть не может. */
const ENV = { SITE_URL: 'https://kroshki.test' } as const;

/** Крошки праздничной посадочной под группирующим узлом: /podborki/prazdniki/8-marta. */
const HOLIDAY_TRAIL = {
  ancestors: [{ label: 'Праздники', path: '/podborki/prazdniki' }],
  current: { label: '8 марта', path: '/podborki/prazdniki/8-marta' },
} as const;

describe('цепочка крошек', () => {
  it('начинается главной и заканчивается текущей страницей без ссылки', () => {
    const trail = buildBreadcrumbTrail(HOLIDAY_TRAIL);

    expect(trail.map((item) => [item.label, item.path, item.linked])).toEqual([
      ['Главная', '/', true],
      ['Праздники', '/podborki/prazdniki', true],
      ['8 марта', '/podborki/prazdniki/8-marta', false],
    ]);
  });

  it('без ссылки ровно одно звено — последнее (ТЗ §7.6)', () => {
    const trail = buildBreadcrumbTrail({
      ancestors: [
        { label: 'Праздники', path: '/podborki/prazdniki' },
        { label: '8 марта', path: '/podborki/prazdniki/8-marta' },
      ],
      current: { label: 'Маме', path: '/podborki/prazdniki/8-marta/mame' },
    });

    expect(trail.filter((item) => !item.linked).map((item) => item.position)).toEqual([
      trail.length,
    ]);
  });

  it('позиции идут подряд с единицы — без пропусков и без нуля', () => {
    const trail = buildBreadcrumbTrail(HOLIDAY_TRAIL);

    expect(trail.map((item) => item.position)).toEqual([1, 2, 3]);
  });

  it('главная — первое звено и она же единственное звено с путём «/»', () => {
    const trail = buildBreadcrumbTrail(HOLIDAY_TRAIL);

    expect(trail.at(0)).toEqual({ ...HOME_CRUMB, linked: true, position: 1 });
    expect(trail.filter((item) => item.path === '/')).toHaveLength(1);
  });

  it('узел верхнего уровня даёт две крошки: главная и он сам', () => {
    const trail = buildBreadcrumbTrail({
      ancestors: [],
      current: { label: 'Праздники', path: '/podborki/prazdniki' },
    });

    expect(trail.map((item) => item.path)).toEqual(['/', '/podborki/prazdniki']);
  });

  it('цепочка карточки идёт по основной подборке, а не по контейнеру /otkrytki', () => {
    // ТЗ §5.4: «Хлебные крошки от главной по основной подборке». Пространства
    // имён разведены (карточка — /otkrytki/<slug>, подборка — /podborki/...),
    // поэтому предпоследнее звено НЕ является префиксом пути карточки: иерархия
    // крошек отражает достижимость страницы, а не вложенность URL.
    const trail = buildBreadcrumbTrail({
      ancestors: [
        { label: 'Праздники', path: '/podborki/prazdniki' },
        { label: '8 марта', path: '/podborki/prazdniki/8-marta' },
        { label: 'Маме', path: '/podborki/prazdniki/8-marta/mame' },
      ],
      current: { label: 'Открытка маме на 8 марта с тюльпанами', path: '/otkrytki/mame-tyulpany' },
    });

    expect(trail.map((item) => item.path)).toEqual([
      '/',
      '/podborki/prazdniki',
      '/podborki/prazdniki/8-marta',
      '/podborki/prazdniki/8-marta/mame',
      '/otkrytki/mame-tyulpany',
    ]);
  });

  it('приводит пути к канонической форме — без завершающего слеша (решение Ч-21)', () => {
    const trail = buildBreadcrumbTrail({
      ancestors: [{ label: 'Праздники', path: '/podborki//prazdniki/' }],
      current: { label: '8 марта', path: '/podborki/prazdniki/8-marta/' },
    });

    expect(trail.map((item) => item.path)).toEqual([
      '/',
      '/podborki/prazdniki',
      '/podborki/prazdniki/8-marta',
    ]);
  });

  it('обрезает пробелы в тексте звена', () => {
    const trail = buildBreadcrumbTrail({
      ancestors: [{ label: '  Праздники \n', path: '/podborki/prazdniki' }],
      current: { label: ' 8 марта ', path: '/podborki/prazdniki/8-marta' },
    });

    expect(trail.map((item) => item.label)).toEqual(['Главная', 'Праздники', '8 марта']);
  });
});

describe('обрыв цепочки на недоступном звене', () => {
  // Состояние достижимо: CMS не требует, чтобы родитель был опубликован раньше
  // ребёнка (матрица вложенности в `apps/cms/src/collections/collection-path.ts`
  // проверяет вид узла, а не статус). Значит опубликованный узел может висеть
  // под черновиком, и страницы этого черновика публично нет — она отдаёт 404.

  it('пропускает недоступное звено и НЕ подставляет вместо него выдуманное', () => {
    const trail = buildBreadcrumbTrail({
      ancestors: [null, { label: '8 марта', path: '/podborki/prazdniki/8-marta' }],
      current: { label: 'Маме', path: '/podborki/prazdniki/8-marta/mame' },
    });

    expect(trail.map((item) => item.path)).toEqual([
      '/',
      '/podborki/prazdniki/8-marta',
      '/podborki/prazdniki/8-marta/mame',
    ]);
  });

  it('при недоступной основной подборке карточки остаются корень и текущая', () => {
    const trail = buildBreadcrumbTrail({
      ancestors: [null],
      current: { label: 'Открытка маме на 8 марта', path: '/otkrytki/mame-tyulpany' },
    });

    expect(trail.map((item) => [item.label, item.path, item.linked])).toEqual([
      ['Главная', '/', true],
      ['Открытка маме на 8 марта', '/otkrytki/mame-tyulpany', false],
    ]);
  });

  it('позиции после обрыва остаются подряд — в разметке не появляется дыра', () => {
    const trail = buildBreadcrumbTrail({
      ancestors: [null, { label: '8 марта', path: '/podborki/prazdniki/8-marta' }],
      current: { label: 'Маме', path: '/podborki/prazdniki/8-marta/mame' },
    });

    expect(trail.map((item) => item.position)).toEqual([1, 2, 3]);
  });
});

describe('отказы сборки цепочки', () => {
  it('главная своих крошек не получает (ТЗ §7.6 — «глубже главной»)', () => {
    expect(() =>
      buildBreadcrumbTrail({ ancestors: [], current: { label: 'Главная', path: '/' } }),
    ).toThrow(/главн/iu);
  });

  it('звено без текста отклоняется, а не выводится пустым', () => {
    expect(() =>
      buildBreadcrumbTrail({
        ancestors: [{ label: '   ', path: '/podborki/prazdniki' }],
        current: { label: '8 марта', path: '/podborki/prazdniki/8-marta' },
      }),
    ).toThrow(/текст/iu);
  });

  it('предок с путём текущей страницы отклоняется: это ссылка на саму себя', () => {
    expect(() =>
      buildBreadcrumbTrail({
        ancestors: [{ label: '8 марта', path: '/podborki/prazdniki/8-marta/' }],
        current: { label: '8 марта', path: '/podborki/prazdniki/8-marta' },
      }),
    ).toThrow(/повтор/iu);
  });

  it('два предка с одним путём отклоняются', () => {
    expect(() =>
      buildBreadcrumbTrail({
        ancestors: [
          { label: 'Праздники', path: '/podborki/prazdniki' },
          { label: 'Праздники ещё раз', path: '/podborki/prazdniki' },
        ],
        current: { label: '8 марта', path: '/podborki/prazdniki/8-marta' },
      }),
    ).toThrow(/повтор/iu);
  });

  it('абсолютный адрес вместо пути отклоняется: чужой хост в крошки не попадает', () => {
    expect(() =>
      buildBreadcrumbTrail({
        ancestors: [{ label: 'Чужой сайт', path: 'https://chuzhoy.test/podborki' }],
        current: { label: '8 марта', path: '/podborki/prazdniki/8-marta' },
      }),
    ).toThrow();
  });
});

describe('разметка BreadcrumbList', () => {
  it('один к одному соответствует видимым крошкам: те же имена, тот же порядок', () => {
    const trail = buildBreadcrumbTrail(HOLIDAY_TRAIL);
    const jsonLd = breadcrumbListJsonLd(trail, ENV);

    expect(jsonLd.itemListElement.map((item) => [item.position, item.name])).toEqual(
      trail.map((item) => [item.position, item.label]),
    );
  });

  it('объявляет схему и тип, а фиктивных элементов не добавляет', () => {
    const jsonLd = breadcrumbListJsonLd(buildBreadcrumbTrail(HOLIDAY_TRAIL), ENV);

    expect(jsonLd['@context']).toBe('https://schema.org');
    expect(jsonLd['@type']).toBe('BreadcrumbList');
    expect(jsonLd.itemListElement).toHaveLength(3);
    expect(new Set(jsonLd.itemListElement.map((item) => item['@type']))).toEqual(
      new Set(['ListItem']),
    );
  });

  it('`item` — абсолютные URL на нашем хосте в канонической форме', () => {
    const jsonLd = breadcrumbListJsonLd(buildBreadcrumbTrail(HOLIDAY_TRAIL), ENV);

    expect(jsonLd.itemListElement.map((item) => item.item)).toEqual([
      'https://kroshki.test/',
      'https://kroshki.test/podborki/prazdniki',
      'https://kroshki.test/podborki/prazdniki/8-marta',
    ]);
  });

  it('у текущей страницы `item` тоже задан — это её собственный canonical', () => {
    // Ссылки на странице нет (ТЗ §7.6), но адрес у страницы есть, и он тот же,
    // что в self-canonical. Пропуск последнего `item` сделал бы разметку и
    // видимые крошки НЕ односоставными, а именно это соответствие проверяется.
    const trail = buildBreadcrumbTrail(HOLIDAY_TRAIL);
    const last = breadcrumbListJsonLd(trail, ENV).itemListElement.at(-1);

    expect(last?.item).toBe('https://kroshki.test/podborki/prazdniki/8-marta');
  });

  it('обрыв цепочки не оставляет в разметке ни дыры в позициях, ни пустого `item`', () => {
    const trail = buildBreadcrumbTrail({
      ancestors: [null, { label: '8 марта', path: '/podborki/prazdniki/8-marta' }],
      current: { label: 'Маме', path: '/podborki/prazdniki/8-marta/mame' },
    });
    const jsonLd = breadcrumbListJsonLd(trail, ENV);

    expect(jsonLd.itemListElement.map((item) => item.position)).toEqual([1, 2, 3]);
    expect(jsonLd.itemListElement.every((item) => item.item.startsWith('https://kroshki.test/'))).toBe(
      true,
    );
  });

  it('пустой SITE_URL валит сборку разметки, а не подставляет плейсхолдер', () => {
    expect(() => breadcrumbListJsonLd(buildBreadcrumbTrail(HOLIDAY_TRAIL), { SITE_URL: '' })).toThrow(
      /SITE_URL/u,
    );
  });
});

describe('встраивание JSON-LD в HTML', () => {
  it('остаётся разбираемым JSON', () => {
    const jsonLd = breadcrumbListJsonLd(buildBreadcrumbTrail(HOLIDAY_TRAIL), ENV);

    expect(JSON.parse(jsonLdScriptText(jsonLd))).toEqual(jsonLd);
  });

  it('не может закрыть тег script содержимым звена', () => {
    const trail = buildBreadcrumbTrail({
      ancestors: [{ label: '</script><script>alert(1)</script>', path: '/podborki/prazdniki' }],
      current: { label: '8 марта', path: '/podborki/prazdniki/8-marta' },
    });

    const text = jsonLdScriptText(breadcrumbListJsonLd(trail, ENV));

    expect(text.toLowerCase()).not.toContain('</script');
    expect(text).not.toContain('<');
  });
});
