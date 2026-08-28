import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertPathNotReserved,
  checkReservedPath,
  isReservedPath,
  PAGINATION_SEGMENT,
  parseAdminPath,
  PAYLOAD_ADMIN_PATH_ENV_KEY,
  reservedRoutes,
} from '@otkritka/shared';

/**
 * Задача Э1-01 (остаток): реестр зарезервированных маршрутов — единственный
 * машинный источник.
 *
 * Норма — `CLAUDE.md`, раздел «Правила URL», пункт «Зарезервированные
 * маршруты». Проверка идёт по ИТОГОВОМУ пути записи, а не по «уровню» slug, и
 * состоит ровно из трёх правил:
 *   1. сегмент `page` запрещён на любой позиции (столкновение с `/page/N`);
 *   2. вид записи реестра определяет проверку: «занят целиком» (запрещено и
 *      совпадение, и любой путь под ним) и «контейнер» (запрещено только
 *      совпадение, пути под ним — норма);
 *   3. корневые сегменты реестра резервируются дополнительно по имени сегмента
 *      на первом уровне (slug `sitemap` даёт `/sitemap`).
 * Для файловых маршрутов резервируется имя БЕЗ расширения.
 *
 * Путь админки в реестр попадает ВЫЧИСЛЕННЫМ из `PAYLOAD_ADMIN_PATH`: при
 * нестандартном значении подборка с таким slug иначе заняла бы путь админки.
 */

const DEFAULT_ADMIN_ENV = { [PAYLOAD_ADMIN_PATH_ENV_KEY]: '/admin' } as const;
const CUSTOM_ADMIN_ENV = { [PAYLOAD_ADMIN_PATH_ENV_KEY]: '/upravlenie-sajtom' } as const;

describe('реестр: структура записей', () => {
  it('каждая запись помечена видом — плоского списка строк здесь быть не может', () => {
    const routes = reservedRoutes(DEFAULT_ADMIN_ENV);
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(['container', 'occupied'], route.path).toContain(route.kind);
      expect(route.reason.length, route.path).toBeGreaterThan(0);
    }
    expect(routes.some((route) => route.kind === 'container')).toBe(true);
    expect(routes.some((route) => route.kind === 'occupied')).toBe(true);
  });

  it('пути хранятся в канонической форме без завершающего слеша (Ч-21)', () => {
    for (const route of reservedRoutes(DEFAULT_ADMIN_ENV)) {
      expect(route.path.startsWith('/'), route.path).toBe(true);
      if (route.path !== '/') {
        expect(route.path.endsWith('/'), route.path).toBe(false);
      }
    }
  });

  it('содержит стартовое наполнение из CLAUDE.md', () => {
    const byPath = new Map(reservedRoutes(DEFAULT_ADMIN_ENV).map((r) => [r.path, r.kind]));

    for (const container of ['/', '/otkrytki', '/podborki']) {
      expect(byPath.get(container), container).toBe('container');
    }
    for (const occupied of [
      '/search',
      '/account',
      '/o-proekte',
      '/usloviya',
      '/kontakty',
      '/generator/preview',
      '/pozdravleniya',
      '/media',
      '/robots.txt',
      '/sitemap.xml',
      '/admin',
    ]) {
      expect(byPath.get(occupied), occupied).toBe('occupied');
    }
  });

  it('публичный префикс производных изображений закрыт целиком', () => {
    // Реестр объявлен единственным машинным источником, а `/media` — реальный
    // публичный префикс файлов (решение Ч-03, `MEDIA_ROUTE_PREFIX` в
    // apps/cms/src/images/storage.ts). Без записи в реестре подборка со slug
    // `media` заняла бы тот же путь, что маршрут отдачи файлов (этап 3).
    expect(isReservedPath('/media', DEFAULT_ADMIN_ENV)).toBe(true);
    expect(isReservedPath('/media/cards/1a2b3c4d/otkrytka-320.webp', DEFAULT_ADMIN_ENV)).toBe(
      true,
    );
    expect(isReservedPath('/podborki/media', DEFAULT_ADMIN_ENV)).toBe(false);
  });

  it('не выводит форму директив Disallow: у записи есть путь, вид, доступ и причина', () => {
    // Состав полей закреплён нарочно. Реестр знает ФАКТЫ о маршруте — путь, вид
    // (контейнер или занят целиком), доступ для обхода и причину резерва, — и не
    // знает ни формы директивы `Disallow` (решение Ч-22: без завершающего
    // слеша), ни того, печатать ли её вообще (там же: путь админки не
    // публикуется). Поле `crawl` появилось на Э4-03 и является фактом о
    // маршруте, а не директивой: из вида записи состав закрытых путей не
    // выводится — «занят целиком» стоит и у `/search`, и у `/sitemap.xml`.
    for (const route of reservedRoutes(DEFAULT_ADMIN_ENV)) {
      expect(Object.keys(route).sort()).toEqual(['crawl', 'kind', 'path', 'reason', 'source']);
      expect(['open', 'closed']).toContain(route.crawl);
    }
  });

  it('путь админки помечен источником admin-env: его нельзя перепутать с маршрутом сайта', () => {
    // На этом различии держится решение Ч-22 «путь админки в robots.txt не
    // публикуется»: закрыты и `/search`, и админка, но назвать вслух можно
    // только первый. Различать их сравнением со значением PAYLOAD_ADMIN_PATH
    // означало бы второй разбор того же параметра.
    const admin = reservedRoutes({ PAYLOAD_ADMIN_PATH: '/vkhod-redaktora' }).find(
      (route) => route.source === 'admin-env',
    );

    expect(admin?.path).toBe('/vkhod-redaktora');
    expect(admin?.crawl).toBe('closed');
  });

  it('закрыты для обхода ровно служебные маршруты, а файлы карты сайта и /media — нет', () => {
    const crawl = new Map(
      reservedRoutes(DEFAULT_ADMIN_ENV).map((route) => [route.path, route.crawl]),
    );

    for (const closed of ['/search', '/account', '/generator/preview', '/admin']) {
      expect(crawl.get(closed), closed).toBe('closed');
    }
    // Закрыть их значило бы спрятать от краулера карту сайта, изображения и
    // страницы, которым решением Ч-23 предстоит попасть в индекс.
    for (const open of [
      '/',
      '/otkrytki',
      '/podborki',
      '/media',
      '/robots.txt',
      '/sitemap.xml',
      '/sitemap-sections.xml',
      '/o-proekte',
      '/usloviya',
      '/kontakty',
    ]) {
      expect(crawl.get(open), open).toBe('open');
    }
  });
});

describe('правило 1: сегмент page запрещён на любой позиции', () => {
  const paths = [
    '/page',
    '/page/2',
    '/otkrytki/page',
    '/otkrytki/page/2',
    '/otkrytki/prazdniki/page',
    '/otkrytki/prazdniki/8-marta/page',
    '/otkrytki/prazdniki/page/mame',
    '/podborki/page/3',
  ];

  for (const path of paths) {
    it(`отклоняет ${path}`, () => {
      const result = checkReservedPath(path, DEFAULT_ADMIN_ENV);
      expect(result.available).toBe(false);
      if (!result.available) {
        expect(result.rule).toBe('pagination-segment');
      }
    });
  }

  it(`сегмент пагинации назван константой: ${PAGINATION_SEGMENT}`, () => {
    expect(PAGINATION_SEGMENT).toBe('page');
  });

  it('похожие сегменты не задевает', () => {
    expect(isReservedPath('/otkrytki/pages', DEFAULT_ADMIN_ENV)).toBe(false);
    expect(isReservedPath('/otkrytki/page-2', DEFAULT_ADMIN_ENV)).toBe(false);
    expect(isReservedPath('/otkrytki/pagoda', DEFAULT_ADMIN_ENV)).toBe(false);
  });
});

describe('правило 2: вид записи определяет проверку', () => {
  it('занят целиком — запрещено и совпадение, и путь под ним', () => {
    for (const path of [
      '/search',
      '/search/istoriya',
      '/search/istoriya/8-marta',
      '/account',
      '/account/zakazy',
      '/generator/preview',
      '/generator/preview/8-marta',
      '/o-proekte',
      '/o-proekte/komanda',
      '/usloviya',
      '/kontakty',
      '/pozdravleniya',
      '/pozdravleniya/8-marta',
    ]) {
      const result = checkReservedPath(path, DEFAULT_ADMIN_ENV);
      expect(result.available, path).toBe(false);
      if (!result.available) {
        expect(result.rule, path).toBe('occupied-path');
      }
    }
  });

  it('контейнер — запрещено только совпадение, пути под ним норма', () => {
    for (const container of ['/', '/otkrytki', '/podborki']) {
      const result = checkReservedPath(container, DEFAULT_ADMIN_ENV);
      expect(result.available, container).toBe(false);
      if (!result.available) {
        expect(result.rule, container).toBe('container-path');
      }
    }

    for (const path of [
      '/otkrytki/8-marta',
      '/otkrytki/prazdniki',
      '/otkrytki/prazdniki/8-marta',
      '/otkrytki/prazdniki/8-marta/mame',
      '/podborki/krasivye',
    ]) {
      expect(isReservedPath(path, DEFAULT_ADMIN_ENV), path).toBe(false);
    }
  });

  it('карточка по каноническому URL не конфликтует с контейнером', () => {
    // `/otkrytki` — контейнер, поэтому `/otkrytki/<slug>` и есть место записи.
    expect(isReservedPath('/otkrytki/8-marta', DEFAULT_ADMIN_ENV)).toBe(false);
    expect(() => assertPathNotReserved('/otkrytki/8-marta', DEFAULT_ADMIN_ENV)).not.toThrow();
  });

  it('проверка идёт по итоговому пути, а не по уровню slug', () => {
    // Один и тот же slug `istoriya` допустим под контейнером и запрещён под
    // занятым целиком путём — решает итоговый путь.
    expect(isReservedPath('/otkrytki/istoriya', DEFAULT_ADMIN_ENV)).toBe(false);
    expect(isReservedPath('/search/istoriya', DEFAULT_ADMIN_ENV)).toBe(true);
  });

  it('завершающий слеш на входе результат не меняет', () => {
    expect(isReservedPath('/search/', DEFAULT_ADMIN_ENV)).toBe(true);
    expect(isReservedPath('/search/istoriya/', DEFAULT_ADMIN_ENV)).toBe(true);
    expect(isReservedPath('/otkrytki/8-marta/', DEFAULT_ADMIN_ENV)).toBe(false);
  });
});

describe('правило 3 и файловые маршруты', () => {
  it('файловый маршрут резервирует и имя без расширения', () => {
    for (const path of ['/robots.txt', '/robots', '/sitemap.xml', '/sitemap']) {
      expect(isReservedPath(path, DEFAULT_ADMIN_ENV), path).toBe(true);
    }
  });

  it('slug `sitemap` даёт `/sitemap` и отклоняется', () => {
    // Формально `/sitemap` не совпадает ни с одним файловым маршрутом, но
    // путается с `/sitemap.xml` — правило 3 закрывает именно этот случай.
    const result = checkReservedPath('/sitemap', DEFAULT_ADMIN_ENV);
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.conflict).toMatch(/sitemap/);
    }
  });

  it('производные sitemap зарезервированы вместе с формами без расширения', () => {
    for (const path of [
      '/sitemap-sections.xml',
      '/sitemap-cards.xml',
      '/sitemap-images.xml',
      '/sitemap-sections',
      '/sitemap-cards',
      '/sitemap-images',
    ]) {
      expect(isReservedPath(path, DEFAULT_ADMIN_ENV), path).toBe(true);
    }
  });

  it('корневой сегмент занятого пути резервируется отдельно', () => {
    // `/generator/preview` занят целиком, поэтому `/generator` тоже закрыт —
    // иначе подборка с slug `generator` встала бы на служебный маршрут.
    expect(isReservedPath('/generator', DEFAULT_ADMIN_ENV)).toBe(true);
    expect(isReservedPath('/generator/otkrytki', DEFAULT_ADMIN_ENV)).toBe(true);
  });

  it('резерв корневого сегмента не превращает контейнер в занятый путь', () => {
    // У `/otkrytki` корневой сегмент совпадает с самим контейнером: вид
    // контейнера обязан победить, иначе весь каталог оказался бы закрыт.
    expect(isReservedPath('/otkrytki/8-marta', DEFAULT_ADMIN_ENV)).toBe(false);
    expect(isReservedPath('/podborki/krasivye', DEFAULT_ADMIN_ENV)).toBe(false);
  });
});

describe('путь админки вычисляется из PAYLOAD_ADMIN_PATH', () => {
  it('нестандартное значение попадает в резерв', () => {
    expect(isReservedPath('/upravlenie-sajtom', CUSTOM_ADMIN_ENV)).toBe(true);
    expect(isReservedPath('/upravlenie-sajtom/collections', CUSTOM_ADMIN_ENV)).toBe(true);
  });

  it('многосегментное значение резервирует и свой корневой сегмент', () => {
    const env = { [PAYLOAD_ADMIN_PATH_ENV_KEY]: '/cms/panel' };
    expect(isReservedPath('/cms/panel', env)).toBe(true);
    expect(isReservedPath('/cms/panel/cards', env)).toBe(true);
    expect(isReservedPath('/cms', env)).toBe(true);
  });

  it('нормализует значение: ведущий и хвостовой слеш — забота кода, не автора .env', () => {
    for (const raw of ['admin/', '/admin/', '  /admin  ']) {
      expect(isReservedPath('/admin', { [PAYLOAD_ADMIN_PATH_ENV_KEY]: raw }), raw).toBe(true);
    }
  });

  it('без значения отказывает явно, а не подставляет путь по умолчанию', () => {
    // Дефолт здесь означал бы, что при нестандартном пути админки реальный путь
    // в резерв не попал и подборка может его занять.
    expect(() => reservedRoutes({})).toThrow(new RegExp(PAYLOAD_ADMIN_PATH_ENV_KEY));
    expect(() => reservedRoutes({ [PAYLOAD_ADMIN_PATH_ENV_KEY]: '  ' })).toThrow(
      new RegExp(PAYLOAD_ADMIN_PATH_ENV_KEY),
    );
    expect(() => checkReservedPath('/otkrytki/8-marta', {})).toThrow(
      new RegExp(PAYLOAD_ADMIN_PATH_ENV_KEY),
    );
  });

  it('отклоняет негодное значение вместо тихой нормализации', () => {
    for (const raw of ['/Admin', '/admin panel', '/admin/../root', '/', '/admin?x=1']) {
      expect(
        () => reservedRoutes({ [PAYLOAD_ADMIN_PATH_ENV_KEY]: raw }),
        raw,
      ).toThrow(new RegExp(PAYLOAD_ADMIN_PATH_ENV_KEY));
    }
  });

  it('совпадение пути админки с записью реестра — отказ на старте, а не режим работы', () => {
    // Находка ревизии от 2026-08-22. Раньше побеждала первая запись по пути,
    // поэтому путь админки, совпавший с контейнером, оставался «контейнером», и
    // весь его подмаршрут считался свободным: запись CMS занимала адрес внутри
    // админки. Двух правдоподобных исходов у такой конфигурации нет — контейнер
    // ОБЯЗАН принимать записи, а путь админки не может принять ни одной, —
    // поэтому реестр отказывается собираться.
    const containerAdmin = { [PAYLOAD_ADMIN_PATH_ENV_KEY]: '/otkrytki' };

    expect(() => reservedRoutes(containerAdmin)).toThrow(
      new RegExp(PAYLOAD_ADMIN_PATH_ENV_KEY),
    );
    expect(() => reservedRoutes(containerAdmin)).toThrow(/otkrytki/);

    // Главное следствие: путь под таким «контейнером» больше не выглядит
    // свободным — проверка не отвечает «можно», она отказывается работать.
    expect(() => checkReservedPath('/otkrytki/8-marta', containerAdmin)).toThrow(
      new RegExp(PAYLOAD_ADMIN_PATH_ENV_KEY),
    );
    expect(() => isReservedPath('/otkrytki/lyuboj-slug', containerAdmin)).toThrow(
      new RegExp(PAYLOAD_ADMIN_PATH_ENV_KEY),
    );
    expect(() => assertPathNotReserved('/otkrytki/8-marta', containerAdmin)).toThrow(
      new RegExp(PAYLOAD_ADMIN_PATH_ENV_KEY),
    );
  });

  it('совпадение с любым видом ЯВНОЙ записи отказывает одинаково', () => {
    for (const raw of [
      '/otkrytki',
      '/podborki',
      '/search',
      '/account',
      '/pozdravleniya',
      '/o-proekte',
      '/generator/preview',
    ]) {
      expect(
        () => reservedRoutes({ [PAYLOAD_ADMIN_PATH_ENV_KEY]: raw }),
        raw,
      ).toThrow(new RegExp(PAYLOAD_ADMIN_PATH_ENV_KEY));
    }
  });

  it('совпадение с ПРОИЗВОДНЫМ резервом отказом не является: маршрута там нет', () => {
    // `/sitemap` — производная запись (имя `/sitemap.xml` без расширения). Она
    // держит от этого имени ЗАПИСИ, а не админку: страницы по такому пути сайт
    // не отдаёт, поглощения маршрута нет. Отказывать здесь значило бы запрещать
    // рабочую конфигурацию, поэтому явная запись просто побеждает производную.
    const env = { [PAYLOAD_ADMIN_PATH_ENV_KEY]: '/sitemap' };
    const byPath = new Map(reservedRoutes(env).map((route) => [route.path, route.kind]));

    expect(byPath.get('/sitemap')).toBe('occupied');
    expect(byPath.get('/sitemap.xml')).toBe('occupied');
    expect(isReservedPath('/sitemap/otkrytki', env)).toBe(true);
  });

  it('путь админки, поглощающий служебный маршрут, тоже отказ', () => {
    // `/generator/preview` оказался бы ПОД админкой: её роутер забирает префикс
    // целиком, и маршрут превью перестал бы существовать.
    expect(() => reservedRoutes({ [PAYLOAD_ADMIN_PATH_ENV_KEY]: '/generator' })).toThrow(
      /generator\/preview/,
    );
  });

  it('путь под контейнером остаётся рабочим режимом: побеждает явная запись', () => {
    // Здесь спор реальный и решается в пользу админки: сам контейнер остаётся
    // контейнером и принимает записи, а конкретный путь админки закрыт целиком.
    const env = { [PAYLOAD_ADMIN_PATH_ENV_KEY]: '/otkrytki/upravlenie' };
    const byPath = new Map(reservedRoutes(env).map((route) => [route.path, route.kind]));

    expect(byPath.get('/otkrytki')).toBe('container');
    expect(isReservedPath('/otkrytki/upravlenie', env)).toBe(true);
    expect(isReservedPath('/otkrytki/upravlenie/collections/cards', env)).toBe(true);
    expect(isReservedPath('/otkrytki/8-marta', env)).toBe(false);
  });

  it('производный резерв корневого сегмента по-прежнему уступает явной записи', () => {
    // Два случая разведены: производная запись (корневой сегмент, имя без
    // расширения) уступает явной, а две ЯВНЫЕ записи на одном пути не
    // разрешаются приоритетом вовсе — это ошибка конфигурации выше.
    const env = { [PAYLOAD_ADMIN_PATH_ENV_KEY]: '/cms/panel' };
    const byPath = new Map(reservedRoutes(env).map((route) => [route.path, route.kind]));

    expect(byPath.get('/otkrytki')).toBe('container');
    expect(byPath.get('/podborki')).toBe('container');
    expect(byPath.get('/cms')).toBe('occupied');
    expect(isReservedPath('/otkrytki/8-marta', env)).toBe(false);
  });

  it('путь админки не записан в исходнике строкой', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../packages/shared/src/reserved-routes.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('/admin');
  });
});

describe('assertPathNotReserved: граница для хуков Payload', () => {
  it('бросает с внятным сообщением, называя правило и конфликт', () => {
    expect(() => assertPathNotReserved('/search/istoriya', DEFAULT_ADMIN_ENV)).toThrow(
      /\/search/,
    );
    expect(() => assertPathNotReserved('/otkrytki/page/2', DEFAULT_ADMIN_ENV)).toThrow(/page/);
    expect(() => assertPathNotReserved('/otkrytki/8-marta', DEFAULT_ADMIN_ENV)).not.toThrow();
  });

  it('отклоняет вход, который путём не является', () => {
    expect(() => checkReservedPath('/otkrytki?sort=new', DEFAULT_ADMIN_ENV)).toThrow(
      /параметр|фрагмент/i,
    );
  });
});

describe('parseAdminPath: ОДИН разбор PAYLOAD_ADMIN_PATH на весь монорепозиторий', () => {
  // Находка ревизии от 2026-08-22: разбор был написан дважды — здесь и в
  // apps/cms/src/env.mjs, — и правила уже разошлись (сегмент `page` отклоняла
  // только копия из env.mjs). Из одного значения выводятся и адрес админки, и
  // его резерв, поэтому разбор обязан быть один. Совпадение двух вызовов
  // проверяется тестом рядом с env.mjs (apps/cms/src/env.test.ts).
  it('нормализует слеши: это забота кода, а не автора .env', () => {
    expect(parseAdminPath('/upravlenie')).toBe('/upravlenie');
    expect(parseAdminPath('upravlenie')).toBe('/upravlenie');
    expect(parseAdminPath('  /upravlenie/  ')).toBe('/upravlenie');
    expect(parseAdminPath('//cms//panel//')).toBe('/cms/panel');
  });

  it('без значения отказывает: дефолта нет намеренно', () => {
    for (const raw of [undefined, null, '', '   ']) {
      expect(() => parseAdminPath(raw), String(raw)).toThrow(
        new RegExp(PAYLOAD_ADMIN_PATH_ENV_KEY),
      );
    }
  });

  it('отклоняет негодное значение вместо тихой нормализации', () => {
    for (const raw of [
      '/Upravlenie',
      '/upravlenie panel',
      '/upravlenie_panel',
      '/управление',
      '/upravlenie?x=1',
      '/upravlenie#hash',
      '/upravlenie/../root',
      '/',
    ]) {
      expect(() => parseAdminPath(raw), raw).toThrow(new RegExp(PAYLOAD_ADMIN_PATH_ENV_KEY));
    }
  });

  it('отклоняет сегмент пагинации на любой позиции', () => {
    expect(() => parseAdminPath(`/${PAGINATION_SEGMENT}`)).toThrow(
      new RegExp(PAGINATION_SEGMENT),
    );
    expect(() => parseAdminPath(`/cms/${PAGINATION_SEGMENT}`)).toThrow(
      new RegExp(PAGINATION_SEGMENT),
    );
  });

  it('реестр собирается тем же разбором: нормализованное значение попадает в резерв', () => {
    const env = { [PAYLOAD_ADMIN_PATH_ENV_KEY]: '  //cms//panel//  ' };
    expect(isReservedPath(parseAdminPath(env[PAYLOAD_ADMIN_PATH_ENV_KEY]), env)).toBe(true);
    expect(isReservedPath('/cms/panel/lyuboj-slug', env)).toBe(true);
  });
});

describe('чего реестр НЕ закрывает: узлы таксономии — это данные', () => {
  it('группирующий узел реестру неизвестен, и пространства имён разведены', () => {
    // Форма путей от 2026-08-22 (Ч-04-9): карточки живут под `/otkrytki`,
    // подборки — под `/podborki`, и это два РАЗНЫХ контейнера реестра. Прежняя
    // модель с общим пространством имён отменена, поэтому коллизии «карточка
    // против группирующего узла» больше нет структурно.
    expect(isReservedPath('/podborki/prazdniki', DEFAULT_ADMIN_ENV)).toBe(false);
    expect(isReservedPath('/podborki/prazdniki/8-marta', DEFAULT_ADMIN_ENV)).toBe(false);
    expect(isReservedPath('/otkrytki/8-marta-mame', DEFAULT_ADMIN_ENV)).toBe(false);

    // Сами контейнеры собственную запись не принимают — это правило реестра, а
    // не свойство таксономии.
    expect(isReservedPath('/otkrytki', DEFAULT_ADMIN_ENV)).toBe(true);
    expect(isReservedPath('/podborki', DEFAULT_ADMIN_ENV)).toBe(true);

    // Что остаётся вне реестра: коллизия ДВУХ узлов на одном пути. Её держит
    // уникальный индекс БД на сохранённом `path` подборки (Э1-05) и уникальный
    // slug карточки (Э1-09) — узлы приходят из базы, реестр их не знает.
  });
});
