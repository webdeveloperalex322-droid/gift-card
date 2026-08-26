/**
 * Входной обработчик HTTP: порядок шагов и тело ответов (задачи Э3-01, Э3-11).
 *
 * Проверяется то, что на живом сервере видно только косвенно, — ПОРЯДОК. Режим
 * обслуживания обязан отвечать раньше политики пути, статики и приложения Astro:
 * иначе во время работ сайт отдавал бы 301 на канонические формы адресов и 200 на
 * файлы, то есть был бы открыт наполовину. Порядок — свойство кода, а не ответа,
 * и на поднятом сервере его пришлось бы выводить из совпадения статусов.
 *
 * Второе проверяемое свойство — тело 404 приходит ИЗ ФАЙЛА `dist/client/404.html`.
 * Это половина требования «страница 404 у сайта одна»: вторую половину (что тот
 * же файл читает приложение Astro через `prerenderedErrorPageFetch` адаптера)
 * проверить юнитом нельзя, она проверена на собранном сервере.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { createFrontDoor } from '../../apps/web/src/server/front-door.js';
import {
  MAINTENANCE_ENV_KEY,
  MAINTENANCE_HTML,
  maintenanceMode,
} from '../../apps/web/src/server/maintenance.js';

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function fakeResponse(): { readonly captured: Captured; readonly res: ServerResponse } {
  const captured: Captured = { body: '', headers: {}, status: 0 };
  const res = {
    headersSent: false,
    end(chunk?: string | Uint8Array): void {
      // Тело приходит либо строкой (503, резервный 404), либо буфером (файл
      // 404.html читается как Buffer). Обе формы приводятся к строке явно:
      // сравнивать буфер со строкой тест не сможет.
      if (chunk !== undefined) {
        captured.body = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      }
    },
    writeHead(status: number, headers?: Record<string, string>): unknown {
      captured.status = status;
      Object.assign(captured.headers, headers ?? {});
      (res as { headersSent: boolean }).headersSent = true;
      return res;
    },
  };
  return { captured, res: res as unknown as ServerResponse };
}

function fakeRequest(url: string): IncomingMessage {
  return { headers: {}, method: 'GET', url } as unknown as IncomingMessage;
}

/** Тело страницы 404 в поддельной сборке — узнаваемое, чтобы не спутать с резервом. */
const NOT_FOUND_FILE_BODY = '<!doctype html><html lang="ru"><body>файл 404 из сборки</body></html>';

let clientRoot = '';
/** Сюда обработчик пишет, что запрос дошёл до приложения Astro. */
let reachedAstro: string[] = [];
const errors: string[] = [];

function frontDoor(env: Record<string, string | undefined>): ReturnType<typeof createFrontDoor> {
  return createFrontDoor({
    adminPath: '/admin',
    astroHandler: (req) => {
      reachedAstro.push(req.url ?? '');
    },
    clientRoot,
    logError: (message) => errors.push(message),
    maintenance: () => maintenanceMode(env),
    mediaRoot: () => {
      throw new Error('Корень производных в этом тесте не нужен: до него доходить не должно.');
    },
  });
}

beforeAll(async () => {
  clientRoot = await mkdtemp(join(tmpdir(), 'otkritka-front-door-'));
  await writeFile(join(clientRoot, '404.html'), NOT_FOUND_FILE_BODY, 'utf8');
});

describe('режим обслуживания отвечает раньше всего', () => {
  const cases: readonly string[] = [
    '/',
    '/otkrytki',
    // Неканоническая форма: во время работ она получает 503, а НЕ 301. Редирект —
    // это утверждение о канонической форме адреса, и делать его из сервиса,
    // объявившего себя недоступным, незачем.
    '/otkrytki/',
    // Файл производной: пространство `/media` тоже закрыто, иначе сайт был бы
    // открыт наполовину — страницы 503, картинки 200.
    '/media/cards/a1b2c3d4/otkrytka-640.webp',
    // Путь, который вне режима дал бы 400, и путь админки (404).
    '/%2F',
    '/admin/collections/cards',
  ];

  for (const target of cases) {
    it(`503 с Retry-After на «${target}»`, async () => {
      reachedAstro = [];
      const { captured, res } = fakeResponse();
      await frontDoor({ [MAINTENANCE_ENV_KEY]: 'on' })(fakeRequest(target), res);

      expect(captured.status).toBe(503);
      expect(captured.headers['Retry-After']).toBe('300');
      expect(captured.headers['Content-Type']).toBe('text/html; charset=utf-8');
      // Ответ не кешируется: иначе прокси и браузер держали бы 503 после того,
      // как работы закончились.
      expect(captured.headers['Cache-Control']).toBe('no-store');
      expect(captured.body).toBe(MAINTENANCE_HTML);
      // Приложение Astro не звалось вовсе — значит и БД не читалась.
      expect(reachedAstro).toEqual([]);
    });
  }
});

describe('вне режима обслуживания порядок прежний', () => {
  it('неканоническая форма адреса получает одиночный 301', async () => {
    const { captured, res } = fakeResponse();
    await frontDoor({})(fakeRequest('/otkrytki/'), res);

    expect(captured.status).toBe(301);
    expect(captured.headers['Location']).toBe('/otkrytki');
    expect(captured.headers['Content-Length']).toBe('0');
  });

  it('канонический адрес доходит до приложения Astro', async () => {
    reachedAstro = [];
    const { res } = fakeResponse();
    await frontDoor({})(fakeRequest('/otkrytki'), res);

    expect(reachedAstro).toEqual(['/otkrytki']);
  });

  it('тело 404 приходит из dist/client/404.html, а не из резерва', async () => {
    // Ровно это и означает «страница 404 у сайта одна»: файл в сборке читает и
    // наш слой, и приложение Astro. Резервная строка в `front-door.ts` остаётся
    // достижимой только при сборке без страницы 404.
    const { captured, res } = fakeResponse();
    await frontDoor({})(fakeRequest('/admin/collections/cards'), res);

    expect(captured.status).toBe(404);
    expect(captured.body).toBe(NOT_FOUND_FILE_BODY);
    expect(captured.headers['Content-Type']).toBe('text/html; charset=utf-8');
  });
});
