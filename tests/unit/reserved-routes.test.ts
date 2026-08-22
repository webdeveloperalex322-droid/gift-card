import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertPathNotReserved,
  checkReservedPath,
  isReservedPath,
  PAGINATION_SEGMENT,
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
      '/robots.txt',
      '/sitemap.xml',
      '/admin',
    ]) {
      expect(byPath.get(occupied), occupied).toBe('occupied');
    }
  });

  it('не выводит форму директив Disallow: реестр хранит только пути', () => {
    for (const route of reservedRoutes(DEFAULT_ADMIN_ENV)) {
      expect(Object.keys(route).sort()).toEqual(['kind', 'path', 'reason', 'source']);
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

describe('чего реестр НЕ закрывает: коллизия карточки и группирующего узла', () => {
  it('группирующий узел — данные, а не маршрут: реестр его не знает', () => {
    // Таксономия Ч-04-5: подборки живут под `/otkrytki/prazdniki/...`, карточка —
    // `/otkrytki/<slug>`. Карточка со slug `prazdniki` даёт ровно тот же путь,
    // что группирующий узел, и реестр это пропускает — узлы приходят из базы.
    expect(isReservedPath('/otkrytki/prazdniki', DEFAULT_ADMIN_ENV)).toBe(false);
    expect(isReservedPath('/otkrytki/podborki', DEFAULT_ADMIN_ENV)).toBe(false);
    // Закрывается не здесь, а проверкой уникальности итогового пути по всем
    // коллекциям в хуках Payload (Э1-05 — сборка пути подборки, Э1-09 — хук
    // неизменяемости и уникальности slug). Тест фиксирует границу ответственности.
  });
});
