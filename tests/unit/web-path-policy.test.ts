/**
 * Правило завершающего слеша в apps/web (задача Э3-01).
 *
 * Проверяется ЧИСТАЯ функция решения, а не middleware: middleware — тонкая
 * обёртка над ней (`apps/web/src/middleware.ts`), и ровно поэтому решение можно
 * проверить без поднятого сервера. Норма — `CLAUDE.md`, раздел «Правила URL»:
 * решение Ч-21 (форма БЕЗ завершающего слеша), одиночный 301, цепочки
 * редиректов запрещены.
 *
 * Ключевые инварианты, которые здесь закодированы:
 *   - у любого редиректа статус ровно 301, и повторный прогон результата даёт
 *     «рендерить» — то есть цепочки нет по построению, а не по обещанию;
 *   - URL файлов не нормализуются (предикат `isPageRoute` из `@otkritka/shared`,
 *     локальной копии правила в apps/web нет);
 *   - путь админки берётся из `PAYLOAD_ADMIN_PATH`; тест с нестандартным
 *     значением доказывает, что `/admin` не захардкожен;
 *   - хост в абсолютный URL попадает только из `SITE_URL`, и пустое значение
 *     валит сборку внятной ошибкой (хост фикстуры — синтетический).
 */
import { describe, expect, it } from 'vitest';

import { canonicalUrlFor } from '../../apps/web/src/routing/canonical.js';
import {
  adminRoutePrefix,
  decideRequestPath,
  PERMANENT_REDIRECT_STATUS,
  type PathDecision,
} from '../../apps/web/src/routing/path-policy.js';

/** Путь админки по умолчанию в фикстурах: значение из .env.example. */
const ADMIN = '/admin';

function decide(pathname: string, adminPath = ADMIN, search = ''): PathDecision {
  return decideRequestPath({ adminPath, pathname, search });
}

/** Location редиректа; падает, если решение оказалось другим. */
function redirectLocation(decision: PathDecision): string {
  if (decision.action !== 'redirect') {
    throw new Error(`ожидался редирект, получено «${decision.action}»`);
  }
  expect(decision.status).toBe(PERMANENT_REDIRECT_STATUS);
  return decision.location;
}

describe('правило завершающего слеша: маршруты страниц', () => {
  it('карточка со слешем — одиночный 301 на форму без слеша', () => {
    const decision = decide('/otkrytki/8-marta/');

    expect(decision.action).toBe('redirect');
    expect(redirectLocation(decision)).toBe('/otkrytki/8-marta');
    // Цепочки нет: результат редиректа сам уже канонический.
    expect(decide('/otkrytki/8-marta').action).toBe('render');
  });

  it('пагинация подборки со слешем — одиночный 301', () => {
    const decision = decide('/podborki/prazdniki/8-marta/page/2/');

    expect(redirectLocation(decision)).toBe('/podborki/prazdniki/8-marta/page/2');
    expect(decide('/podborki/prazdniki/8-marta/page/2').action).toBe('render');
  });

  it('статус редиректа ровно 301 — ни 302, ни 308', () => {
    const decision = decide('/podborki/adresaty/mame/');

    if (decision.action !== 'redirect') {
      throw new Error('ожидался редирект');
    }
    expect(decision.status).toBe(301);
  });

  it('корень — единственное исключение, остаётся собой', () => {
    expect(decide('/').action).toBe('render');
  });

  it('канонический путь любой глубины редиректа не даёт', () => {
    for (const path of [
      '/otkrytki',
      '/podborki',
      '/podborki/prazdniki/8-marta',
      '/podborki/prazdniki/8-marta/mame',
      '/podborki/prazdniki/8-marta/mame/page/3',
    ]) {
      expect(decide(path), path).toEqual({ action: 'render' });
    }
  });

  it('строка запроса переносится в Location без изменений', () => {
    const decision = decide('/search/', ADMIN, '?q=tyulpany');

    expect(redirectLocation(decision)).toBe('/search?q=tyulpany');
  });
});

describe('повторные слеши: один 301 сразу в каноническую форму', () => {
  it('завершающий двойной слеш не порождает цепочку', () => {
    const decision = decide('/otkrytki//');

    expect(redirectLocation(decision)).toBe('/otkrytki');
    expect(decide('/otkrytki').action).toBe('render');
  });

  it('несколько слешей подряд в конце дают тот же единственный редирект', () => {
    expect(redirectLocation(decide('/otkrytki////'))).toBe('/otkrytki');
  });

  it('повторный слеш в середине: один 301 по правилу Astro, дальше 404 без второго шага', () => {
    // Цель редиректа совпадает с целью самого Astro (он повторные слеши в
    // середине не схлопывает), поэтому второго 301 не возникает.
    const decision = decide('/podborki//prazdniki///8-marta/');
    const location = redirectLocation(decision);

    expect(location).toBe('/podborki//prazdniki///8-marta');
    expect(decide(location).action).toBe('not-found');
  });

  it('пустой сегмент внутри пути — 404, а не редирект', () => {
    const decision = decide('/otkrytki//8-marta');

    expect(decision.action).toBe('not-found');
    if (decision.action !== 'not-found') {
      throw new Error('ожидалось not-found');
    }
    expect(decision.reason).toMatch(/цепочк/i);
  });

  it('ведущий двойной слеш не превращается в Location на чужой хост', () => {
    const location = redirectLocation(decide('//evil.example/otkrytki/'));

    expect(location.startsWith('//')).toBe(false);
    expect(location).toBe('/evil.example/otkrytki');
  });
});

describe('URL файлов не нормализуются', () => {
  it('robots.txt, sitemap.xml и производные изображений отдаются как есть', () => {
    for (const path of [
      '/robots.txt',
      '/sitemap.xml',
      '/sitemap-cards.xml',
      '/media/cards/a1b2c3/otkrytka-mame-na-8-marta-640.webp',
    ]) {
      expect(decide(path), path).toEqual({ action: 'render' });
    }
  });

  it('точка в родительском сегменте файлом путь не делает', () => {
    expect(redirectLocation(decide('/media/a.b/otkrytki/'))).toBe('/media/a.b/otkrytki');
  });

  it('файловый URL со слешем наше правило не трогает — им занимается Astro', () => {
    expect(decide('/robots.txt/')).toEqual({ action: 'render' });
  });
});

describe('инвариант: цель редиректа никогда не редиректит снова', () => {
  const CORPUS = [
    '/',
    '//',
    '///',
    '/otkrytki',
    '/otkrytki/',
    '/otkrytki//',
    '/otkrytki////',
    '/otkrytki//8-marta',
    '/otkrytki//8-marta/',
    '/podborki/prazdniki/8-marta/',
    '/podborki/prazdniki/8-marta/mame/page/2/',
    '/podborki//prazdniki///8-marta/',
    '//evil.example/otkrytki/',
    '/robots.txt',
    '/robots.txt/',
    '/sitemap.xml',
    '/media/cards/a1b2c3/otkrytka-640.webp',
    '/administrator/',
    '/search/',
  ];

  it('на всём корпусе путей глубина редиректа не превышает одного шага', () => {
    for (const path of CORPUS) {
      const first = decide(path);
      if (first.action !== 'redirect') {
        continue;
      }
      const second = decide(first.location);
      expect(second.action, `${path} -> ${first.location}`).not.toBe('redirect');
    }
  });

  it('Location редиректа никогда не начинается с двойного слеша', () => {
    for (const path of CORPUS) {
      const decision = decide(path);
      if (decision.action !== 'redirect') {
        continue;
      }
      expect(decision.location.startsWith('//'), path).toBe(false);
      expect(decision.location.startsWith('/'), path).toBe(true);
    }
  });
});

describe('маршруты админки Astro не обслуживает и не нормализует', () => {
  it('сам путь админки и всё под ним — вне зоны Astro', () => {
    for (const path of [ADMIN, `${ADMIN}/`, `${ADMIN}/collections/cards`, `${ADMIN}/collections/cards/`]) {
      const decision = decide(path);
      expect(decision.action, path).toBe('not-served');
    }
  });

  it('решение по админке несёт причину, а не пустой отказ', () => {
    const decision = decide(`${ADMIN}/`);

    if (decision.action !== 'not-served') {
      throw new Error('ожидалось not-served');
    }
    expect(decision.reason).toMatch(/PAYLOAD_ADMIN_PATH/);
  });

  it('нестандартное значение PAYLOAD_ADMIN_PATH: /admin не захардкожен', () => {
    const custom = '/upravlenie';

    expect(decide(`${custom}/`, custom).action).toBe('not-served');
    expect(decide(`${custom}/collections/cards/`, custom).action).toBe('not-served');

    // При нестандартном пути админки «/admin» — обычный маршрут страницы:
    // нормализуется по общему правилу, а не выводится из-под нормализации.
    expect(redirectLocation(decide('/admin/', custom))).toBe('/admin');
  });

  it('путь, лишь начинающийся так же, админкой не считается', () => {
    expect(redirectLocation(decide('/administrator/', ADMIN))).toBe('/administrator');
  });
});

describe('путь админки читается из окружения, дефолта нет', () => {
  it('значение из окружения нормализуется', () => {
    expect(adminRoutePrefix({ PAYLOAD_ADMIN_PATH: '/upravlenie/' })).toBe('/upravlenie');
  });

  it('пустое значение валит запуск, а не подставляет /admin', () => {
    expect(() => adminRoutePrefix({ PAYLOAD_ADMIN_PATH: '' })).toThrowError(
      /PAYLOAD_ADMIN_PATH/,
    );
    expect(() => adminRoutePrefix({})).toThrowError(/PAYLOAD_ADMIN_PATH/);
  });
});

describe('абсолютный self-canonical собирается только из SITE_URL', () => {
  it('путь приводится к канонической форме и склеивается с хостом', () => {
    const env = { SITE_URL: 'https://synthetic.invalid' };

    expect(canonicalUrlFor('/otkrytki/8-marta/', env)).toBe(
      'https://synthetic.invalid/otkrytki/8-marta',
    );
    expect(canonicalUrlFor('/', env)).toBe('https://synthetic.invalid/');
  });

  it('хвостовой слеш у значения SITE_URL не даёт второго URL той же страницы', () => {
    expect(canonicalUrlFor('/otkrytki', { SITE_URL: 'https://synthetic.invalid/' })).toBe(
      'https://synthetic.invalid/otkrytki',
    );
  });

  it('пустой SITE_URL валит сборку внятной ошибкой, а не подставляет хост', () => {
    expect(() => canonicalUrlFor('/otkrytki', { SITE_URL: '' })).toThrowError(/SITE_URL/);
    expect(() => canonicalUrlFor('/otkrytki', {})).toThrowError(/SITE_URL/);
  });
});
