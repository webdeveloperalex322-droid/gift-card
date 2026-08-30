/**
 * Применение таблицы редиректов на запросе (задача Э4-02).
 *
 * Норма: ТЗ §7.5 и §5.6, `CLAUDE.md` — «HTTP-статусы» (перенос — одиночный 301;
 * удалено без замены — 404/410; удалено с заменой — 301 на релевантный URL),
 * «Правила URL» («изменение существующего URL без одиночного 301 — критическая
 * ошибка. Цепочки редиректов запрещены»), п. 23 (массовый редирект удалённых
 * страниц на главную запрещён).
 *
 * ## Почему цепочка проверяется ЗДЕСЬ, если её запрещает CMS
 *
 * Коллекция `redirects` схлопывает цепочки при записи и отклоняет петли
 * (`apps/cms/src/collections/redirects-plan.ts`, задача Э1-06). Это правило
 * ЗАПИСИ, и на него нельзя опираться в рантайме: в базу можно попасть мимо
 * Payload (миграция, ручной SQL, восстановление дампа), а цена ошибки — два
 * перехода вместо одного на каждом запросе к перенесённому адресу. Поэтому
 * разрешатель не доверяет данным и сам приводит цепочку к одному переходу.
 *
 * Тест ЧИСТЫЙ: таблица подставляется картой, базы здесь нет.
 */
import { describe, expect, it } from 'vitest';

import {
  type RedirectRule,
  resolveRedirect,
} from '../../apps/web/src/routing/redirects.js';

const ENV = { PAYLOAD_ADMIN_PATH: '/admin' };

/** Таблица редиректов картой: ключ — путь `from`. */
function tableOf(rules: readonly RedirectRule[]): (path: string) => Promise<RedirectRule | null> {
  const byFrom = new Map(rules.map((rule) => [rule.from, rule]));
  return (path: string) => Promise.resolve(byFrom.get(path) ?? null);
}

function moved(from: string, to: string): RedirectRule {
  return { code: '301', from, to };
}

function gone(from: string): RedirectRule {
  return { code: '410', from, to: null };
}

async function decide(
  pathname: string,
  rules: readonly RedirectRule[],
  search = '',
): Promise<Awaited<ReturnType<typeof resolveRedirect>>> {
  return resolveRedirect({ env: ENV, lookup: tableOf(rules), pathname, search });
}

describe('перенос: одиночный 301', () => {
  it('правило со страницы даёт один переход на конечный адрес', async () => {
    const decision = await decide('/otkrytki/staraya', [
      moved('/otkrytki/staraya', '/otkrytki/novaya'),
    ]);

    expect(decision).toMatchObject({
      action: 'redirect',
      hops: 1,
      location: '/otkrytki/novaya',
      status: 301,
    });
  });

  it('без правила страница отдаётся как есть', async () => {
    expect(await decide('/otkrytki/zhivaya', [moved('/otkrytki/drugaya', '/otkrytki/novaya')]))
      .toEqual({ action: 'none' });
  });

  it('строка запроса переносится на новый адрес', async () => {
    // utm-метка и параметр представления переживают переезд: они не создают
    // адресов (canonical у цели чистый), а терять источник перехода незачем.
    const decision = await decide(
      '/otkrytki/staraya',
      [moved('/otkrytki/staraya', '/otkrytki/novaya')],
      '?utm_source=mail',
    );

    expect(decision).toMatchObject({ location: '/otkrytki/novaya?utm_source=mail' });
  });
});

describe('перенос со структуры прежнего сайта', () => {
  // Ради этого класса адресов и существует перехватывающий маршрут: у
  // `/index.php` и `/staraya.html` маршрута Astro нет, а ссылки на них остались
  // снаружи. Проверка добавлена по вердикту `reviewer` от 2026-08-28: пропуск
  // «любой путь с расширением» отменял такое правило целиком и молча.
  const legacy: readonly (readonly [string, string])[] = [
    ['/index.php', '/'],
    ['/staraya.html', '/otkrytki/novaya'],
    ['/katalog/otkrytka.htm', '/otkrytki/novaya'],
    ['/2019/08/pozdravlenie.aspx', '/podborki/prazdniki/8-marta'],
  ];

  for (const [from, to] of legacy) {
    it(`правило с «${from}» применяется, а не молчит`, async () => {
      const decision = await decide(from, [moved(from, to)]);

      expect(decision).toMatchObject({
        action: 'redirect',
        hops: 1,
        location: to,
        status: 301,
      });
    });
  }

  it('без правила такой адрес по-прежнему отдаётся маршрутом (то есть 404)', async () => {
    expect(await decide('/staraya.html', [moved('/drugaya.html', '/otkrytki/novaya')])).toEqual({
      action: 'none',
    });
  });

  it('цель без расширения: 301 ведёт на нормальный адрес страницы', async () => {
    const decision = await decide('/staraya.html', [
      moved('/staraya.html', '/otkrytki/novaya/'),
    ]);

    expect(decision).toMatchObject({ location: '/otkrytki/novaya' });
  });
});

describe('цепочка в данных схлопывается на чтении', () => {
  it('A→B при существующем B→C даёт ОДИН переход сразу на C', async () => {
    const decision = await decide('/otkrytki/a', [
      moved('/otkrytki/a', '/otkrytki/b'),
      moved('/otkrytki/b', '/otkrytki/c'),
    ]);

    expect(decision).toMatchObject({
      action: 'redirect',
      collapsed: true,
      hops: 2,
      location: '/otkrytki/c',
    });
  });

  it('цепочка, ведущая на удалённый адрес, отдаёт 410, а не 301 на пустоту', async () => {
    const decision = await decide('/otkrytki/a', [
      moved('/otkrytki/a', '/otkrytki/b'),
      gone('/otkrytki/b'),
    ]);

    expect(decision).toMatchObject({ action: 'gone', status: 410 });
  });

  it('петля не даёт Location вовсе: любой ответ 301 закольцевал бы браузер', async () => {
    const decision = await decide('/otkrytki/a', [
      moved('/otkrytki/a', '/otkrytki/b'),
      moved('/otkrytki/b', '/otkrytki/a'),
    ]);

    expect(decision).toMatchObject({ action: 'broken' });
    expect(decision).not.toHaveProperty('location');
  });

  it('редирект на самого себя — тоже петля', async () => {
    const decision = await decide('/otkrytki/a', [moved('/otkrytki/a', '/otkrytki/a')]);

    expect(decision.action).toBe('broken');
  });

  it('слишком длинная цепочка отказывает, а не ходит по базе без предела', async () => {
    const rules = Array.from({ length: 40 }, (_, index) =>
      moved(`/otkrytki/n${String(index)}`, `/otkrytki/n${String(index + 1)}`),
    );

    expect((await decide('/otkrytki/n0', rules)).action).toBe('broken');
  });
});

describe('удаление', () => {
  it('удалено без замены — 410', async () => {
    expect(await decide('/otkrytki/udalennaya', [gone('/otkrytki/udalennaya')])).toMatchObject({
      action: 'gone',
      status: 410,
    });
  });

  it('удалено с заменой — 301 на релевантный адрес, а не на главную', async () => {
    const decision = await decide('/otkrytki/udalennaya', [
      moved('/otkrytki/udalennaya', '/podborki/prazdniki/8-marta'),
    ]);

    expect(decision).toMatchObject({
      action: 'redirect',
      location: '/podborki/prazdniki/8-marta',
    });
  });
});

describe('испорченные данные не превращаются в правдоподобный ответ', () => {
  it('301 без цели — отказ, а не редирект в никуда', async () => {
    const decision = await decide('/otkrytki/a', [{ code: '301', from: '/otkrytki/a', to: null }]);

    expect(decision.action).toBe('broken');
  });

  it('абсолютный адрес в цели — отказ: хост собирается только из SITE_URL', async () => {
    const decision = await decide('/otkrytki/a', [
      { code: '301', from: '/otkrytki/a', to: 'https://chuzhoy.test/x' },
    ]);

    expect(decision.action).toBe('broken');
  });

  it('протокольно-относительная цель — тоже отказ: это адрес ЧУЖОГО хоста', async () => {
    const decision = await decide('/otkrytki/a', [
      { code: '301', from: '/otkrytki/a', to: '//chuzhoy.test/x' },
    ]);

    expect(decision.action).toBe('broken');
  });

  it('непонятный код — отказ', async () => {
    const decision = await decide('/otkrytki/a', [
      { code: '302' as RedirectRule['code'], from: '/otkrytki/a', to: '/otkrytki/b' },
    ]);

    expect(decision.action).toBe('broken');
  });

  it('цель с параметрами — отказ РЕШЕНИЕМ, а не исключением', async () => {
    // Разрешатель обещает не бросать: исключение здесь middleware диагностирует
    // как «таблица не прочитана», то есть отправляет разбираться в базу вместо
    // одной негодной строки.
    const decision = await decide('/otkrytki/a', [
      { code: '301', from: '/otkrytki/a', to: '/otkrytki/b?utm_source=mail' },
    ]);

    expect(decision.action).toBe('broken');
    if (decision.action !== 'broken') return;
    expect(decision.reason).toContain('/otkrytki/b?utm_source=mail');
  });

  it('цель с фрагментом — тот же отказ', async () => {
    const decision = await decide('/otkrytki/a', [
      { code: '301', from: '/otkrytki/a', to: '/otkrytki/b#nizhe' },
    ]);

    expect(decision.action).toBe('broken');
  });

  it('запрошенный путь не является путём — отказ, а не исключение', async () => {
    const decision = await decide('/otkrytki/a?x=1', [moved('/otkrytki/a', '/otkrytki/b')]);

    expect(decision.action).toBe('broken');
  });
});

describe('чего таблица редиректов не касается', () => {
  it('производные изображений: правило к ним не применяется и в базу за ними не ходят', async () => {
    // Пропуск сужен до пространства `/media` (правка по вердикту reviewer от
    // 2026-08-28). Раньше пропускался ЛЮБОЙ путь с расширением, и правило с
    // `from = /staraya.html` не срабатывало никогда.
    for (const pathname of [
      '/media/otkrytka-mame-8-marta-abc123-640.webp',
      '/media/cards/r2/otkrytka-1280.avif',
      // Мусор под /media — тоже не адрес страницы: этот путь останавливает слой
      // отдачи файлов, а не таблица переносов.
      '/media/takogo-klyucha-net',
    ]) {
      let asked = 0;
      const decision = await resolveRedirect({
        env: ENV,
        lookup: (path) => {
          asked += 1;
          return Promise.resolve(moved(path, '/otkrytki/novaya'));
        },
        pathname,
      });

      expect(decision, pathname).toEqual({ action: 'none' });
      expect(asked, pathname).toBe(0);
    }
  });

  it('файловые маршруты самого сайта не перекрываются: правило видно в логе', async () => {
    // `/robots.txt` и `/sitemap.xml` — маршруты, которые сайт обслуживает сам.
    // Их защищает реестр зарезервированных маршрутов, а не пропуск по
    // расширению: правило с такого пути обязано быть ЗАМЕЧЕНО, а не молча
    // проигнорировано.
    for (const path of ['/robots.txt', '/sitemap.xml', '/sitemap-cards-1.xml']) {
      const decision = await decide(path, [moved(path, '/otkrytki/novaya')]);

      expect(decision.action, path).toBe('ignored');
    }
  });

  it('маршрут, который сайт обслуживает сам, редиректом не перекрывается', async () => {
    // Правило с `/` или `/search` увело бы запрос с живой страницы, и причина не
    // была бы видна ни в шаблоне, ни в записи. Записи CMS такой путь занять не
    // могут (реестр зарезервированных маршрутов), поэтому правило означает
    // ошибку администратора — её видно в логе, а сайт продолжает работать.
    for (const path of ['/', '/search', '/o-proekte', '/otkrytki']) {
      const decision = await decide(path, [moved(path, '/podborki')]);

      expect(decision.action, path).toBe('ignored');
    }
  });

  it('цепочка останавливается на маршруте, который сайт обслуживает сам', async () => {
    // Находка `url-guard` от 2026-08-28: проверка реестра стояла только у
    // НАЧАЛА цепочки. Правило с «/search» (данные мимо Payload) уводило бы
    // запрос дальше — с живой служебной страницы, без предупреждения.
    const decision = await decide('/otkrytki/staraya', [
      moved('/otkrytki/staraya', '/search'),
      moved('/search', '/podborki'),
    ]);

    expect(decision).toMatchObject({
      action: 'redirect',
      hops: 1,
      location: '/search',
      status: 301,
    });
  });

  it('перенос на каталог остаётся законным: цель — живой адрес, а не запрет', async () => {
    // Обратная половина того же правила: `/otkrytki` и `/` тоже зарезервированы,
    // и 301 НА них — обычный перенос, ради которого таблица и существует.
    for (const target of ['/', '/otkrytki', '/podborki']) {
      const decision = await decide('/staraya.html', [moved('/staraya.html', target)]);

      expect(decision, target).toMatchObject({ action: 'redirect', location: target });
    }
  });

  it('обычная страница под контейнером зарезервированной не считается', async () => {
    const decision = await decide('/otkrytki/staraya', [
      moved('/otkrytki/staraya', '/otkrytki/novaya'),
    ]);

    expect(decision.action).toBe('redirect');
  });
});

describe('форма пути', () => {
  it('путь ищется в канонической форме: хвостовой слеш второго правила не требует', async () => {
    const decision = await decide('/otkrytki/staraya/', [
      moved('/otkrytki/staraya', '/otkrytki/novaya'),
    ]);

    expect(decision).toMatchObject({ action: 'redirect', location: '/otkrytki/novaya' });
  });

  it('цель приводится к канонической форме: 301 не ведёт на адрес, который сам редиректит', async () => {
    const decision = await decide('/otkrytki/staraya', [
      moved('/otkrytki/staraya', '/otkrytki/novaya/'),
    ]);

    expect(decision).toMatchObject({ location: '/otkrytki/novaya' });
  });
});
