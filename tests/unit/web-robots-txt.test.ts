/**
 * `robots.txt` — состав, форма директив и то, чего в нём быть не должно
 * (задача Э4-03).
 *
 * Норма: решение Ч-22 (форма `Disallow` БЕЗ завершающего слеша; путь админки не
 * публикуется), `CLAUDE.md` — раздел «Sitemap и robots» (CSS/JS/изображения не
 * блокируются; указана абсолютная ссылка на sitemap-индекс), раздел «Правила
 * URL» (абсолютный URL собирает единственный хелпер над `SITE_URL`), решение
 * Ч-23 (служебные страницы — именованное исключение и кандидаты в индекс).
 *
 * Почему проверок так много на девять строк текста. Ошибка в этом файле не видна
 * ни в вёрстке, ни в тестах страниц: лишняя строка `Disallow` убирает раздел из
 * обхода целиком, а пропущенная — пускает в обход внутренний поиск. Обнаружить и
 * то и другое можно только по трафику, то есть через недели.
 */
import { describe, expect, it } from 'vitest';

import {
  buildRobotsTxt,
  crawlerClosedPaths,
  ROBOTS_TXT_CONTENT_TYPE,
} from '../../apps/web/src/seo/robots-txt.js';
import { SITEMAP_INDEX_PATH } from '../../apps/web/src/seo/sitemap.js';

/** Окружение теста: синтетический хост допустим и нужен — им проверяется сборка URL. */
const ENV = {
  PAYLOAD_ADMIN_PATH: '/admin',
  SITE_URL: 'https://primer.test',
} as const;

/** Нестандартный путь админки: именно на нём видно, публикуется он или нет. */
const CUSTOM_ADMIN_ENV = {
  PAYLOAD_ADMIN_PATH: '/sluzhebnyy/vkhod-redaktora',
  SITE_URL: 'https://primer.test',
} as const;

function lines(text: string): string[] {
  return text.split('\n');
}

function disallowLines(text: string): string[] {
  return lines(text).filter((line) => line.startsWith('Disallow:'));
}

describe('форма директив (решение Ч-22)', () => {
  it('закрыты ровно три пути и ровно в префиксной форме, без завершающего слеша', () => {
    // Значения выписаны дословно из решения Ч-22, а не выведены из реестра:
    // тест, повторяющий формулу кода, проверял бы формулу саму собой.
    expect(disallowLines(buildRobotsTxt(ENV))).toEqual([
      'Disallow: /search',
      'Disallow: /account',
      'Disallow: /generator/preview',
    ]);
  });

  it('ни одна директива не оканчивается слешем: форма со слешем не покрыла бы голый путь', () => {
    // `Disallow: /search/` не запрещает `/search` — а именно его краулер
    // запрашивает первым.
    for (const line of disallowLines(buildRobotsTxt(ENV))) {
      expect(line.endsWith('/')).toBe(false);
    }
  });

  it('группа одна и она общая: User-agent: * перед директивами', () => {
    const printed = lines(buildRobotsTxt(ENV));
    const agent = printed.indexOf('User-agent: *');
    const firstDisallow = printed.findIndex((line) => line.startsWith('Disallow:'));

    expect(agent).toBeGreaterThanOrEqual(0);
    expect(firstDisallow).toBeGreaterThan(agent);
  });

  it('файл заканчивается переводом строки и не содержит пустых директив', () => {
    const text = buildRobotsTxt(ENV);

    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toMatch(/^Disallow:\s*$/mu);
  });
});

describe('путь админки не публикуется (решение Ч-22)', () => {
  it('стандартный путь админки не встречается в файле ни одной строкой', () => {
    expect(buildRobotsTxt(ENV)).not.toContain('/admin');
  });

  it('нестандартный путь админки не встречается ни целиком, ни первым сегментом', () => {
    const text = buildRobotsTxt(CUSTOM_ADMIN_ENV);

    // Первый сегмент проверяется отдельно: реестр производит из пути админки
    // резерв корневого сегмента, и он тоже не должен попасть в публичный файл.
    expect(text).not.toContain('/sluzhebnyy');
    expect(text).not.toContain('vkhod-redaktora');
  });

  it('путь админки при этом ЗАКРЫТ для обхода — просто не назван', () => {
    // Свойство маршрута и решение о публикации — разные вещи. Первое живёт в
    // реестре (путь закрыт), второе принято решением Ч-22 (не печатаем).
    expect(crawlerClosedPaths(CUSTOM_ADMIN_ENV)).toContain('/sluzhebnyy/vkhod-redaktora');
  });
});

describe('что НЕ закрывается', () => {
  it.each([
    ['/media', 'CSS, JS и изображения не блокируются'],
    ['/sitemap.xml', 'на карту сайта ссылается сам robots.txt'],
    ['/sitemap-sections.xml', 'файл карты сайта'],
    ['/robots.txt', 'сам файл директив'],
    ['/o-proekte', 'кандидат в индекс по решению Ч-23'],
    ['/usloviya', 'кандидат в индекс по решению Ч-23'],
    ['/kontakty', 'кандидат в индекс по решению Ч-23'],
    ['/otkrytki', 'каталог: контейнер записей'],
    ['/podborki', 'каталог: контейнер записей'],
    ['/pozdravleniya', 'страницы нет вовсе (Ч-20): запрещать нечего'],
    ['/generator', 'производный резерв имени, а не маршрут'],
    ['/sitemap', 'производный резерв имени, а не маршрут'],
  ])('%s не закрыт — %s', (path) => {
    expect(disallowLines(buildRobotsTxt(ENV))).not.toContain(`Disallow: ${path}`);
  });
});

describe('ссылка на карту сайта', () => {
  it('абсолютная и собрана из SITE_URL', () => {
    expect(buildRobotsTxt(ENV)).toContain(`Sitemap: https://primer.test${SITEMAP_INDEX_PATH}`);
  });

  it('хост меняется вместе с SITE_URL — своего значения у файла нет', () => {
    const text = buildRobotsTxt({ ...ENV, SITE_URL: 'http://otkritka.test' });

    expect(text).toContain('Sitemap: http://otkritka.test/sitemap.xml');
    expect(text).not.toContain('primer.test');
  });

  it('пустой SITE_URL валит сборку файла, а не подставляет плейсхолдер', () => {
    expect(() => buildRobotsTxt({ ...ENV, SITE_URL: '' })).toThrow(/SITE_URL/u);
  });

  it('ссылка ровно одна: второй sitemap-индекс означал бы две карты сайта', () => {
    const printed = lines(buildRobotsTxt(ENV)).filter((line) => line.startsWith('Sitemap:'));

    expect(printed).toHaveLength(1);
  });
});

describe('состав берётся из реестра, а не из списка строк', () => {
  it('каждый напечатанный путь — закрытый маршрут реестра', () => {
    const closed = crawlerClosedPaths(ENV);

    for (const line of disallowLines(buildRobotsTxt(ENV))) {
      expect(closed).toContain(line.replace('Disallow: ', ''));
    }
  });

  it('незаданный PAYLOAD_ADMIN_PATH валит сборку: реестр без пути админки неполон', () => {
    expect(() => buildRobotsTxt({ SITE_URL: 'https://primer.test' })).toThrow(
      /PAYLOAD_ADMIN_PATH/u,
    );
  });
});

describe('тип содержимого', () => {
  it('текст, а не HTML, и с кодировкой', () => {
    expect(ROBOTS_TXT_CONTENT_TYPE).toBe('text/plain; charset=utf-8');
  });
});
