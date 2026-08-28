/**
 * Решение по цели запроса в apps/web: правило завершающего слеша, отказ от
 * вторых адресов одного материала и отсутствие цепочек редиректов.
 *
 * Проверяется ЧИСТАЯ функция, а не сервер: и входной сервер
 * (`apps/web/src/server/front-door.ts`), и middleware Astro
 * (`apps/web/src/middleware.ts`) — тонкие обёртки над ней. Норма — `CLAUDE.md`,
 * раздел «Правила URL»: решение Ч-21 (форма БЕЗ завершающего слеша), одиночный
 * 301, цепочки редиректов запрещены, один материал — один путь.
 *
 * Ключевые инварианты, закодированные здесь:
 *   - у любого редиректа статус ровно 301, и повторный прогон его цели даёт не
 *     редирект — то есть цепочки нет по построению, а не по обещанию;
 *   - `location` никогда не начинается с `//` (иначе это открытый редирект);
 *   - процентное кодирование не создаёт ни второго адреса, ни смены числа
 *     сегментов: `%2F`, `%5C`, `%2e` и битое кодирование отклоняются;
 *   - `.html` и `/index.html` адресами страниц не являются;
 *   - URL файлов не нормализуются (предикат `isPageRoute` из `@otkritka/shared`,
 *     локальной копии правила в apps/web нет);
 *   - путь админки берётся из `PAYLOAD_ADMIN_PATH`; тест с нестандартным
 *     значением доказывает, что `/admin` не захардкожен;
 *   - хост в абсолютный URL попадает только из `SITE_URL`, и пустое значение
 *     валит сборку внятной ошибкой (хост фикстуры — синтетический).
 *
 * Отдельно проверяется отображение «канонический путь → файл в `dist/client`»:
 * оно парное к `build.format: 'file'` и определяет, что именно отдаёт статика.
 */
import { describe, expect, it } from 'vitest';

import { canonicalUrlFor } from '../../apps/web/src/routing/canonical.js';
import {
  adminRoutePrefix,
  clientFileForPath,
  decideRequestTarget,
  immutableCacheControlFor,
  PERMANENT_REDIRECT_STATUS,
  type TargetDecision,
} from '../../apps/web/src/routing/path-policy.js';

/** Путь админки по умолчанию в фикстурах: значение из .env.example. */
const ADMIN = '/admin';

function decide(target: string, adminPath = ADMIN): TargetDecision {
  return decideRequestTarget({ adminPath, target });
}

/** Location редиректа; падает, если решение оказалось другим. */
function redirectLocation(decision: TargetDecision): string {
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
    // Цепочки нет: цель редиректа сама уже канонична.
    expect(decide('/otkrytki/8-marta').action).toBe('serve');
  });

  it('пагинация подборки со слешем — одиночный 301', () => {
    const decision = decide('/podborki/prazdniki/8-marta/page/2/');

    expect(redirectLocation(decision)).toBe('/podborki/prazdniki/8-marta/page/2');
    expect(decide('/podborki/prazdniki/8-marta/page/2').action).toBe('serve');
  });

  it('статус редиректа ровно 301 — ни 302, ни 308', () => {
    const decision = decide('/podborki/adresaty/mame/');

    if (decision.action !== 'redirect') {
      throw new Error('ожидался редирект');
    }
    expect(decision.status).toBe(301);
  });

  it('корень — единственное исключение, остаётся собой', () => {
    expect(decide('/')).toEqual({ action: 'serve', pathname: '/', search: '' });
  });

  it('канонический путь любой глубины редиректа не даёт', () => {
    for (const path of [
      '/otkrytki',
      '/podborki',
      '/podborki/prazdniki/8-marta',
      '/podborki/prazdniki/8-marta/mame',
      '/podborki/prazdniki/8-marta/mame/page/3',
    ]) {
      expect(decide(path), path).toEqual({ action: 'serve', pathname: path, search: '' });
    }
  });

  it('строка запроса переносится в Location без изменений', () => {
    expect(redirectLocation(decide('/search/?q=tyulpany'))).toBe('/search?q=tyulpany');
  });

  it('строка запроса на каноническом пути сохраняется в решении, а не теряется', () => {
    expect(decide('/otkrytki?page=2')).toEqual({
      action: 'serve',
      pathname: '/otkrytki',
      search: '?page=2',
    });
  });
});

describe('повторные и ведущие слеши', () => {
  it('завершающий двойной слеш не порождает цепочку', () => {
    expect(redirectLocation(decide('/otkrytki//'))).toBe('/otkrytki');
    expect(decide('/otkrytki').action).toBe('serve');
  });

  it('несколько слешей подряд в конце дают тот же единственный редирект', () => {
    expect(redirectLocation(decide('/otkrytki////'))).toBe('/otkrytki');
  });

  it('путь только из слешей сводится к корню одним переходом', () => {
    // Прежняя сборка отвечала здесь ТРЕМЯ переходами: статический обработчик
    // адаптера снимал ровно один слеш за ответ, а промежуточные Location были
    // протокольно-относительными («//», «///»).
    for (const target of ['//', '///', '////']) {
      expect(redirectLocation(decide(target)), target).toBe('/');
      expect(decide('/').action).toBe('serve');
    }
  });

  it('пустой сегмент внутри пути — 404 и без завершающего слеша, и с ним', () => {
    // Порядок шагов: проверка пустого сегмента ДО снятия хвостового слеша.
    // Иначе «/podborki//prazdniki/» получал бы 301 на адрес, который сам же
    // отвечает 404 — переход в никуда.
    for (const target of ['/otkrytki//8-marta', '/podborki//prazdniki/', '/podborki//prazdniki']) {
      const decision = decide(target);
      expect(decision.action, target).toBe('not-found');
    }
  });

  it('ведущий двойной слеш не превращается в Location на чужой хост', () => {
    // Схлопывание дало бы 301 на выдуманный «/evil.example/otkrytki». Отказ не
    // порождает Location вовсе — инвариант «Location не начинается с //»
    // держится по построению, а не проверкой строки.
    const decision = decide('//evil.example/otkrytki/');

    expect(decision.action).toBe('not-found');
  });
});

describe('процентное кодирование не создаёт ни второго адреса, ни смены сегментов', () => {
  it('%2F и %5C отклоняются как 400, а не превращаются в разделитель пути', () => {
    // Ровно этот путь уходил в бесконечный цикл 301 на прежней сборке:
    // /%2F -> Location /%2F/ -> Location /%2F -> ...
    for (const target of ['/%2F', '/%2f', '/%2F/', '/otkrytki/%2F/8-marta', '/%5C', '/%5cevil']) {
      const decision = decide(target);
      expect(decision.action, target).toBe('bad-request');
    }
  });

  it('битое процентное кодирование отклоняется, а не роняет обработчик', () => {
    for (const target of ['/%', '/%zz', '/otkrytki/%E0%A4%A']) {
      expect(decide(target).action, target).toBe('bad-request');
    }
  });

  it('dot-сегменты отклоняются, а не сворачиваются', () => {
    // Свёртка на сервере дала бы второй адрес той же страницы, а «..» — ещё и
    // попытку выйти за корень статики.
    for (const target of ['/%2e', '/%2E', '/.', '/..', '/otkrytki/../otkrytki', '/otkrytki/./']) {
      expect(decide(target).action, target).toBe('bad-request');
    }
  });

  it('управляющие символы в сегменте отклоняются', () => {
    for (const target of ['/%00', '/%09otkrytki', '/%0A']) {
      expect(decide(target).action, target).toBe('bad-request');
    }
  });

  it('процентный псевдоним канонического адреса — 404, а не редирект', () => {
    // Редирект здесь означал бы, что у материала сколько угодно входных
    // адресов, каждый со своим 301. Канонические адреса сайта кодирования не
    // содержат вовсе.
    for (const target of ['/robots%2Etxt', '/otkrytki%2D8-marta', '/%6Ftkrytki']) {
      expect(decide(target).action, target).toBe('not-found');
    }
  });

  it('фрагмент и абсолютная форма цели отклоняются', () => {
    for (const target of ['/otkrytki#kotiki', 'http://evil.example/otkrytki', '*', 'otkrytki']) {
      expect(decide(target).action, target).toBe('bad-request');
    }
  });
});

describe('у страницы нет второго адреса с расширением .html', () => {
  // ЧТО ИЗМЕНИЛОСЬ 2026-08-28 (находки `reviewer` и `url-guard`). Ответ на
  // `.html` остался 404 и статикой такой путь не обслуживается — но решение
  // теперь `not-found-unless-moved`: 404 приходит ПОСЛЕ таблицы переносов.
  // Причина: со структуры прежнего сайта переносят прежде всего адреса на
  // `.html`, и отказ до таблицы отменял бы такое правило целиком, молча.
  // Второго адреса с 200 это не создаёт: ни входной сервер, ни middleware этот
  // путь статикой не отдают, а маршрута под него у приложения нет.

  it('/index.html — не адрес главной', () => {
    // Замерено на прежней сборке: /index.html отдавал 200 с содержимым главной,
    // то есть второй адрес одного материала.
    expect(decide('/index.html').action).toBe('not-found-unless-moved');
  });

  it('файл заранее отрендеренной страницы адресом не является', () => {
    for (const target of ['/o-proekte.html', '/OTKRYTKI.HTML', '/podborki/prazdniki/8-marta.html']) {
      expect(decide(target).action, target).toBe('not-found-unless-moved');
    }
  });

  it('страницы 404 и 500 недоступны как файлы', () => {
    expect(decide('/404.html').action).toBe('not-found-unless-moved');
    expect(decide('/500.html').action).toBe('not-found-unless-moved');
  });

  it('в таблице переносов ищется путь БЕЗ хвостовых слешей и без параметров', () => {
    const decision = decide('/staraya.html/?utm_source=mail');

    expect(decision.action).toBe('not-found-unless-moved');
    if (decision.action !== 'not-found-unless-moved') return;
    expect(decision.pathname).toBe('/staraya.html');
    expect(decision.search).toBe('?utm_source=mail');
  });
});

describe('у страницы 404 нет собственного адреса', () => {
  // Замерено контролёром `url-guard` на собранном сервере: `/404` отдавал 200 с
  // H1 «Страница не найдена», а `/404/` — 301 на этот же 200. Файл
  // `dist/client/404.html` лежит в статике намеренно (тело 404 у сайта одно), но
  // отображение «URL → файл» делало из него адрес с soft 404 под статусом 200.

  it('/404 отдаёт 404, а не 200', () => {
    const decision = decide('/404');

    expect(decision.action).toBe('not-found');
    // Причина проверяется, чтобы отказ приходил ИМЕННО от этого правила, а не от
    // случайно совпавшего соседнего (например от разбора кодирования).
    expect(decision.action === 'not-found' ? decision.reason : '').toContain(
      'маршрут страницы 404',
    );
  });

  it('/404/ отдаёт 404 напрямую, без нормализующего 301 на адрес с 404', () => {
    // Отдельная проверка: 301 на путь, который сам отвечает 404, — это ровно тот
    // «одиночный редирект в никуда», который запрещён и на пагинации.
    for (const target of ['/404/', '/404//', '/404///']) {
      expect(decide(target).action, target).toBe('not-found');
    }
  });

  it('запрет узкий: он не задевает ни путей ПОД /404, ни похожих слугов', () => {
    // Слуг из одних цифр CMS отклоняет (решение Ч-27), но политика пути про это
    // не знает и знать не должна: её дело — форма адреса. Расширять запрет с
    // одного пути на префикс значило бы отказывать записям, которых он не
    // касается.
    expect(decide('/404/istoriya').action).toBe('serve');
    expect(decide('/4040').action).toBe('serve');
    expect(decide('/podborki/404').action).toBe('serve');
  });

  it('файл 404.html как адрес по-прежнему отклонён — правило не подменило прежнее', () => {
    // Отказ тот же; изменился только момент ответа — после таблицы переносов
    // (см. describe про `.html` выше).
    expect(decide('/404.html').action).toBe('not-found-unless-moved');
  });
});

describe('URL файлов не нормализуются', () => {
  it('robots.txt, sitemap.xml и производные изображений отдаются как есть', () => {
    for (const path of [
      '/robots.txt',
      '/sitemap.xml',
      '/sitemap-cards.xml',
      '/media/cards/a1b2c3/otkrytka-mame-na-8-marta-640.webp',
      '/_astro/index.abc123.css',
    ]) {
      expect(decide(path), path).toEqual({ action: 'serve', pathname: path, search: '' });
    }
  });

  it('точка в родительском сегменте файлом путь не делает', () => {
    expect(redirectLocation(decide('/media/a.b/otkrytki/'))).toBe('/media/a.b/otkrytki');
  });

  it('URL файла с завершающим слешем — 404, а не 301 на файл', () => {
    // Правило слеша описывает маршруты СТРАНИЦ. Редирект на URL файла означал
    // бы, что постоянный адрес файла перестал быть постоянным.
    const decision = decide('/robots.txt/');

    expect(decision.action).toBe('not-found');
  });
});

describe('инвариант: цель редиректа никогда не редиректит снова', () => {
  const CORPUS = [
    '/',
    '//',
    '///',
    '////',
    '/%2F',
    '/%2F/',
    '/%2e',
    '/index.html',
    '/x.html',
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
    '/search/?q=x',
  ];

  it('на всём корпусе целей глубина перехода не превышает одного шага', () => {
    for (const target of CORPUS) {
      const first = decide(target);
      if (first.action !== 'redirect') {
        continue;
      }
      const second = decide(first.location);
      expect(second.action, `${target} -> ${first.location}`).not.toBe('redirect');
    }
  });

  it('Location редиректа никогда не начинается с двойного слеша', () => {
    for (const target of CORPUS) {
      const decision = decide(target);
      if (decision.action !== 'redirect') {
        continue;
      }
      expect(decision.location.startsWith('//'), target).toBe(false);
      expect(decision.location.startsWith('/'), target).toBe(true);
    }
  });

  it('на корпусе нет ни одного решения вне известного множества', () => {
    // Замкнутость множества ответов — это и есть отсутствие цикла: любой путь
    // за один шаг приходит в состояние, которое переходов больше не порождает.
    const allowed = [
      'serve',
      'redirect',
      'not-found',
      'not-found-unless-moved',
      'bad-request',
      'not-served',
    ];
    for (const target of CORPUS) {
      expect(allowed, target).toContain(decide(target).action);
    }
  });
});

describe('маршруты админки Astro не обслуживает и не нормализует', () => {
  it('сам путь админки и всё под ним — вне зоны Astro', () => {
    for (const path of [
      ADMIN,
      `${ADMIN}/`,
      `${ADMIN}/collections/cards`,
      `${ADMIN}/collections/cards/`,
    ]) {
      expect(decide(path).action, path).toBe('not-served');
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
    expect(() => adminRoutePrefix({ PAYLOAD_ADMIN_PATH: '' })).toThrowError(/PAYLOAD_ADMIN_PATH/);
    expect(() => adminRoutePrefix({})).toThrowError(/PAYLOAD_ADMIN_PATH/);
  });
});

describe('отображение канонического пути в файл dist/client', () => {
  it('корень отдаётся index.html, страница — <путь>.html (build.format: file)', () => {
    expect(clientFileForPath('/')).toBe('index.html');
    expect(clientFileForPath('/o-proekte')).toBe('o-proekte.html');
    expect(clientFileForPath('/podborki/prazdniki/8-marta')).toBe(
      'podborki/prazdniki/8-marta.html',
    );
  });

  it('URL файла отображается сам в себя, без добавления расширения', () => {
    expect(clientFileForPath('/robots.txt')).toBe('robots.txt');
    expect(clientFileForPath('/_astro/index.abc123.css')).toBe('_astro/index.abc123.css');
  });

  it('ни одно отображение не начинается со слеша и не содержит dot-сегментов', () => {
    // Относительность имени — часть защиты статики: абсолютный путь или «..»
    // вывели бы отдачу за корень dist/client.
    for (const path of ['/', '/otkrytki', '/robots.txt', '/media/cards/a1/x-640.webp']) {
      const file = clientFileForPath(path);
      expect(file.startsWith('/'), path).toBe(false);
      expect(file.split('/'), path).not.toContain('..');
    }
  });

  it('неизменяемый Cache-Control ставится только артефактам сборки', () => {
    expect(immutableCacheControlFor('/_astro/index.abc123.css')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(immutableCacheControlFor('/robots.txt')).toBeUndefined();
    expect(immutableCacheControlFor('/otkrytki')).toBeUndefined();
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
