/**
 * Требование (`CLAUDE.md`, таблица «HTTP-статусы»): «Сервис недоступен → 503 +
 * Retry-After».
 *
 * Почему это требование SEO, а не эксплуатации: 503 с `Retry-After` — единственный
 * ответ, при котором поисковая система понимает «страница жива, приходите позже»
 * и НЕ выбрасывает адрес из индекса. Любой другой ответ во время работ
 * (200 с текстом «ведём работы», 302 на заглушку, 404) означает для краулера, что
 * материала больше нет, и стоит это переиндексации всего сайта.
 *
 * Проверяется на СВОЁМ сервере, поднятом с `MAINTENANCE_MODE=on` (разбор — в
 * шапке `support/maintenance-server.ts`), три утверждения:
 *
 *   1. **503 на всех классах адресов** — страница-маршрут, страница-запись,
 *      несуществующий адрес, файл производной изображения, служебный файл
 *      (`/robots.txt`, `/sitemap.xml`), путь админки, адрес с параметрами.
 *      Половина открывшегося сайта (страницы 503, картинки 200) хуже честной
 *      недоступности: краулер, получивший 200 на файлы, считает сайт живым;
 *   2. **`Retry-After` есть и это число секунд**. Без него 503 для краулера —
 *      неопределённость, а с ним — назначенное время возврата;
 *   3. **никакого 301 на неканонической форме адреса**. Редирект — это
 *      утверждение о канонической форме адреса, и сервис, объявивший себя
 *      недоступным, таких утверждений не делает. Отдельная причина проверять
 *      именно это: правило слеша реализовано ВЫШЕ по стеку, чем режим
 *      обслуживания, и порядок шагов легко переставить местами рефакторингом
 *      входного обработчика — снаружи ошибка выглядела бы как безобидный 301.
 *
 * Тело страницы 503 не зависит от базы (константа в
 * `apps/web/src/server/maintenance.ts`) — проверяется, что в ответе есть H1 и
 * директива `noindex`: страница без директивы нарушает правило «директива на
 * каждой странице», а 503 с индексируемым телом — заявка на индексацию заглушки.
 */

import { expect, test } from '@playwright/test';

import { headingTexts, metaContents } from './support/html.js';
import { fetchRaw } from './support/http.js';
import {
  MAINTENANCE_RETRY_AFTER_SECONDS,
  type MaintenanceServer,
  maintenancePort,
  startMaintenanceServer,
} from './support/maintenance-server.js';
import { resolveAcceptanceTarget } from './support/target.js';

const target = resolveAcceptanceTarget();
const adminPath = (process.env['PAYLOAD_ADMIN_PATH'] ?? '').trim();

if (adminPath === '') {
  throw new Error(
    'SEO-приёмка: PAYLOAD_ADMIN_PATH не задан. Режим обслуживания обязан закрывать и путь ' +
      'админки, а путь берётся из окружения: зашитая строка проверяла бы чужой адрес.',
  );
}

/** Классы адресов. Ответ 503 обязан прийти на КАЖДЫЙ. */
const ADDRESS_CLASSES: readonly { readonly path: string; readonly note: string }[] = [
  { path: '/', note: 'корень сайта' },
  { path: '/otkrytki', note: 'каталог открыток' },
  { path: '/podborki/prazdniki/8-marta', note: 'адрес записи CMS' },
  { path: '/search', note: 'служебная страница' },
  { path: '/o-proekte', note: 'информационная страница' },
  { path: '/takogo-adresa-net-e3-14', note: 'несуществующий адрес (иначе был бы 404)' },
  { path: '/media/net-takogo-fayla.jpg', note: 'файл производной изображения' },
  { path: '/robots.txt', note: 'служебный файл' },
  { path: '/sitemap.xml', note: 'sitemap-индекс' },
  { path: adminPath, note: 'путь админки' },
  { path: '/?utm_source=newsletter', note: 'адрес с параметрами' },
];

/**
 * Неканонические формы: в рабочем режиме каждая отдаёт одиночный 301
 * (`trailing-slash-single-301.spec.ts`). Во время обслуживания — 503.
 */
const NON_CANONICAL_FORMS: readonly { readonly path: string; readonly note: string }[] = [
  { path: '/otkrytki/', note: 'завершающий слеш' },
  { path: '/otkrytki//', note: 'повторный слеш' },
  { path: '/podborki/prazdniki/8-marta/', note: 'завершающий слеш у адреса записи' },
];

let server: MaintenanceServer | null = null;

test.describe('режим обслуживания (MAINTENANCE_MODE=on)', () => {
  // Подъём второго сервера идёт в бюджет первого теста набора, поэтому бюджет
  // поднят: он покрывает старт процесса, а не ожидание ответа.
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test.beforeAll(async () => {
    server = await startMaintenanceServer(maintenancePort(target.serverPort));
  });

  test.afterAll(async () => {
    await server?.stop();
    server = null;
  });

  for (const address of ADDRESS_CLASSES) {
    test(`503 с Retry-After: ${address.path} (${address.note})`, async ({ request }) => {
      const origin = server?.origin ?? '';
      expect(origin, 'Сервер режима обслуживания не поднят.').not.toBe('');

      const response = await fetchRaw(request, `${origin}${address.path}`);

      expect(
        response.status,
        `Во время обслуживания адрес обязан отдавать 503. Получено ${String(response.status)}: ` +
          'любой другой ответ говорит краулеру, что материала больше нет, — и это стоит ' +
          'переиндексации всего сайта.',
      ).toBe(503);

      expect(
        response.headers['retry-after'] ?? '',
        'Заголовок Retry-After обязателен при 503: без него ответ для краулера — ' +
          'неопределённость, а с ним — назначенное время возврата.',
      ).toBe(String(MAINTENANCE_RETRY_AFTER_SECONDS));
    });
  }

  for (const form of NON_CANONICAL_FORMS) {
    test(`во время обслуживания нет редиректа: ${form.path} (${form.note})`, async ({
      request,
    }) => {
      const origin = server?.origin ?? '';
      const response = await fetchRaw(request, `${origin}${form.path}`);

      expect(
        response.status,
        'Неканоническая форма адреса во время обслуживания обязана отдавать 503, а не 301. ' +
          'Редирект — утверждение о канонической форме адреса; сервис, объявивший себя ' +
          'недоступным, таких утверждений не делает. Проверка стоит здесь потому, что правило ' +
          'слеша живёт ВЫШЕ режима обслуживания во входном обработчике, и переставить шаги ' +
          'местами можно случайно.',
      ).toBe(503);

      expect(response.location, 'В ответе 503 не должно быть Location.').toBeNull();
    });
  }

  test('тело страницы 503: свой H1 и директива noindex', async ({ request }) => {
    const origin = server?.origin ?? '';
    const body = (await fetchRaw(request, `${origin}/`)).body;

    expect(
      headingTexts(body, 1),
      'У страницы 503 обязан быть ровно один H1: она отвечает и тогда, когда база недоступна, ' +
        'поэтому её тело — константа, а не рендер.',
    ).toHaveLength(1);

    expect(
      metaContents(body, 'robots'),
      'У страницы 503 обязана быть директива noindex,nofollow: директива относится к ЭТОМУ ' +
        'ответу, и краулер, разобравший тело, не должен увидеть страницу без директивы.',
    ).toEqual(['noindex,nofollow']);
  });
});
