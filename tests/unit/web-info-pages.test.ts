/**
 * Служебные информационные страницы `/o-proekte`, `/usloviya`, `/kontakty`
 * (задача Э3-11).
 *
 * Норма: ТЗ §5.6, решения Ч-19 и Ч-23. Проверяется ЧИСТАЯ сборка страницы
 * (`apps/web/src/seo/info-pages.ts`): что попадает в голову документа, какая
 * директива робота получается при каждом состоянии данных и что печатается, пока
 * текста нет.
 *
 * Главное, что здесь проверяется, — что своей трактовки условия Ч-23 в apps/web
 * НЕТ: обе ветки конъюнкции («человек не включал выключатель» и «текста
 * недостаточно») обязаны давать `noindex`, а `index,follow` появляться ровно при
 * выполнении обеих. Две трактовки одного условия — в CMS и в шаблоне — разошлись
 * бы молча, и расхождение проявилось бы страницей-заглушкой в индексе.
 */
import {
  INFO_PAGE_KEYS,
  INFO_PAGE_MIN_TEXT_LENGTH,
  INFO_PAGE_PATHS,
  type InfoPageFacts,
  isReservedPath,
} from '@otkritka/shared';
import { describe, expect, it } from 'vitest';

import {
  INFO_PAGE_NAMES,
  INFO_PAGE_NAV,
  INFO_PAGE_STUB_NOTICE,
  infoPageBreadcrumbTrail,
  infoPageView,
} from '../../apps/web/src/seo/info-pages.js';

/** Лексический документ заданной длины — чтобы порог Ч-23 проверялся числом. */
function body(length: number): Record<string, unknown> {
  return {
    root: {
      type: 'root',
      version: 1,
      children: [
        {
          type: 'paragraph',
          version: 1,
          children: [{ type: 'text', version: 1, text: 'а'.repeat(length), format: 0 }],
        },
      ],
    },
  };
}

const FILLED: InfoPageFacts = {
  allowIndexing: true,
  body: body(INFO_PAGE_MIN_TEXT_LENGTH),
  metaDescription: 'Описание страницы «О проекте» — что это за сайт и откуда берутся открытки.',
  title: 'О проекте — сайт поздравительных открыток',
};

describe('голова документа служебной страницы', () => {
  it('заполненные поля попадают в title, H1 и description как есть', () => {
    const view = infoPageView('about', { ...FILLED, h1: 'О нашем проекте' });

    expect(view.title).toBe('О проекте — сайт поздравительных открыток');
    expect(view.heading).toBe('О нашем проекте');
    expect(view.metaDescription).toBe(FILLED.metaDescription);
    expect(view.path).toBe('/o-proekte');
  });

  it('пустой H1 совпадает с title — то же правило, что у контентных коллекций', () => {
    expect(infoPageView('about', FILLED).heading).toBe(FILLED.title);
    expect(infoPageView('about', { ...FILLED, h1: '   ' }).heading).toBe(FILLED.title);
  });

  it('пустой глобал: title и H1 — имя раздела, а не пустая строка', () => {
    // Пустой `<title>` не является ни допустимой разметкой, ни осмысленным
    // ответом, поэтому у заглушки есть непустое и уникальное имя.
    for (const key of INFO_PAGE_KEYS) {
      const view = infoPageView(key, {});
      expect(view.title).toBe(INFO_PAGE_NAMES[key]);
      expect(view.heading).toBe(INFO_PAGE_NAMES[key]);
      expect(view.path).toBe(INFO_PAGE_PATHS[key]);
    }
  });

  it('имена трёх страниц уникальны: одинаковый title — это дубль (п. 22.1)', () => {
    const titles = INFO_PAGE_KEYS.map((key) => infoPageView(key, {}).title);
    expect(new Set(titles).size).toBe(INFO_PAGE_KEYS.length);
  });

  it('пустой description означает отсутствие тега, а не пустой тег', () => {
    expect(infoPageView('about', {}).metaDescription).toBeNull();
    expect(infoPageView('about', { metaDescription: '  ' }).metaDescription).toBeNull();
  });

  it('тело страницы отдаётся как есть — разбирает его шаблон', () => {
    const document = body(10);
    expect(infoPageView('about', { body: document }).body).toBe(document);
  });
});

describe('индексируемость по решению Ч-23: конъюнкция двух условий', () => {
  it('выключатель включён И текст наполнен — index,follow', () => {
    const view = infoPageView('about', FILLED);

    expect(view.indexation.approved).toBe(true);
    expect(view.indexation.gaps).toEqual([]);
    expect(view.indexation.indexable).toBe(true);
    expect(view.robots).toBe('index,follow');
  });

  it('текст есть, выключатель ВЫКЛЮЧЕН — noindex', () => {
    // Это вторая ветка конъюнкции и ровно та, ради которой выключатель и введён:
    // заполнение полей — работа редактора, а индексация — отдельное осознанное
    // решение человека (п. 7.1 и п. 23 ТЗ).
    // Отсутствие ключа и `undefined` значением — при `exactOptionalPropertyTypes`
    // разные вещи, поэтому первый случай собирается удалением ключа.
    const withoutSwitch = { ...FILLED };
    delete (withoutSwitch as { allowIndexing?: unknown }).allowIndexing;

    const states: InfoPageFacts[] = [
      withoutSwitch,
      { ...FILLED, allowIndexing: null },
      { ...FILLED, allowIndexing: false },
    ];
    for (const facts of states) {
      const view = infoPageView('about', facts);
      expect(view.indexation.gaps).toEqual([]);
      expect(view.indexation.approved).toBe(false);
      expect(view.robots).toBe('noindex,follow');
    }
  });

  it('«похожее на да» согласием не считается', () => {
    // Значение из REST-ответа или из формы не должно решать за человека.
    const view = infoPageView('about', {
      ...FILLED,
      allowIndexing: 'true' as unknown as boolean,
    });
    expect(view.robots).toBe('noindex,follow');
  });

  it('выключатель включён, а текста мало — noindex', () => {
    const view = infoPageView('about', {
      ...FILLED,
      body: body(INFO_PAGE_MIN_TEXT_LENGTH - 1),
    });

    expect(view.indexation.approved).toBe(true);
    expect(view.indexation.gaps).toEqual(['body']);
    expect(view.robots).toBe('noindex,follow');
  });

  it('выключатель включён, текст есть, а description пуст — noindex', () => {
    // У индексируемой страницы description обязателен (п. 22.1), а подставлять
    // его шаблоном запрещено (п. 23.4): значит остаётся noindex.
    const view = infoPageView('about', { ...FILLED, metaDescription: '' });

    expect(view.indexation.gaps).toEqual(['metaDescription']);
    expect(view.robots).toBe('noindex,follow');
  });

  it('пустой глобал — noindex и заглушка, а не отказ', () => {
    for (const key of INFO_PAGE_KEYS) {
      const view = infoPageView(key, {});
      expect(view.robots).toBe('noindex,follow');
      expect(view.stub).toBe(true);
      expect(view.indexation.indexable).toBe(false);
    }
  });

  it('ни в одном состоянии директива не бывает nofollow', () => {
    // Служебная страница остаётся частью навигации даже закрытой от индекса:
    // ссылки с неё обходятся.
    const states: InfoPageFacts[] = [
      {},
      FILLED,
      { ...FILLED, allowIndexing: false },
      { ...FILLED, body: body(1) },
    ];
    for (const facts of states) {
      expect(infoPageView('terms', facts).robots).not.toBe('noindex,nofollow');
    }
  });
});

describe('заглушка незаполненной страницы', () => {
  it('текст есть — заглушки нет, даже если страница не индексируется', () => {
    const view = infoPageView('terms', { body: body(INFO_PAGE_MIN_TEXT_LENGTH) });

    expect(view.stub).toBe(false);
    expect(view.robots).toBe('noindex,follow');
  });

  it('видимый текст заглушки честный: он говорит, что текста нет', () => {
    // Заглушка не изображает наполненную страницу — иначе это был бы soft 404 с
    // 200, ровно то, за что каталог с пустой сеткой отдаёт 404.
    expect(INFO_PAGE_STUB_NOTICE).toMatch(/не заполнен/u);
    expect(INFO_PAGE_STUB_NOTICE).toMatch(/индексации/u);
  });
});

describe('навигация и крошки', () => {
  it('в подвале ровно три служебные страницы с путями из реестра', () => {
    expect(INFO_PAGE_NAV.map((link) => link.path)).toEqual(
      INFO_PAGE_KEYS.map((key) => INFO_PAGE_PATHS[key]),
    );
    expect(INFO_PAGE_NAV.map((link) => link.label)).toEqual(
      INFO_PAGE_KEYS.map((key) => INFO_PAGE_NAMES[key]),
    );
  });

  it('все три пути заняты в реестре зарезервированных маршрутов', () => {
    // Это статические маршруты Astro, и запись CMS с таким итоговым путём
    // создать нельзя. Расхождение реестра с маршрутами дало бы либо страницу без
    // маршрута, либо два владельца одного адреса.
    for (const link of INFO_PAGE_NAV) {
      expect(isReservedPath(link.path, { PAYLOAD_ADMIN_PATH: '/admin' })).toBe(true);
    }
  });

  it('пути канонические: без завершающего слеша (решение Ч-21)', () => {
    for (const link of INFO_PAGE_NAV) {
      expect(link.path.startsWith('/')).toBe(true);
      expect(link.path.endsWith('/')).toBe(false);
      expect(link.path).toMatch(/^\/[a-z0-9-]+$/u);
    }
  });

  it('крошки: главная → страница, текущее звено без ссылки (ТЗ §7.6)', () => {
    const view = infoPageView('terms', FILLED);
    const trail = infoPageBreadcrumbTrail(view);

    expect(trail).toHaveLength(2);
    expect(trail[0]).toMatchObject({ label: 'Главная', linked: true, path: '/', position: 1 });
    // Текст текущего звена — H1 страницы: одно значение, а не два совпадающих.
    expect(trail[1]).toMatchObject({
      label: view.heading,
      linked: false,
      path: '/usloviya',
      position: 2,
    });
  });
});
