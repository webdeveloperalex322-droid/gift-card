/**
 * Второй сервер приёмки — тот же собранный артефакт, поднятый с включённым
 * режимом обслуживания (`MAINTENANCE_MODE=on`).
 *
 * ## Почему отдельный процесс, а не переключение на живом сервере
 *
 * Режим обслуживания — параметр ОКРУЖЕНИЯ (`apps/web/src/server/maintenance.ts`).
 * Он читается из `process.env` того процесса, который отвечает, поэтому включить
 * его у уже запущенного сервера снаружи нечем — и это правильное устройство:
 * выключатель, который можно дёрнуть запросом, однажды дёрнут запросом. Значит
 * проверить ответ 503 можно только на своём процессе.
 *
 * ## Почему процесс поднимает spec, а не `webServer` конфига
 *
 * Playwright умеет несколько записей `webServer`, но обе поднимались бы
 * ПАРАЛЛЕЛЬНО, а каждая из них по контракту `serve-built-web.mjs` начинает со
 * СБОРКИ (`astro build`) — две сборки одновременно писали бы в один `dist`. Это
 * не теоретическая гонка: артефакт один, каталог один. Поэтому режим
 * обслуживания поднимается ПОСЛЕ основного сервера, из `beforeAll`, и переиспользует
 * уже собранный артефакт: к моменту запуска тестов основной `webServer` гарантированно
 * закончил сборку — Playwright не начинает тесты, пока сервер не ответил.
 *
 * ## Почему `taskkill /T`, а не `child.kill()`
 *
 * Дерево процессов: `node scripts/start-server.mjs` → `node dist/server/entry.mjs`.
 * Обёртка пробрасывает SIGINT/SIGTERM дочернему процессу, но на Windows Node не
 * доставляет сигналы: `kill` там превращается в `TerminateProcess`, обработчик в
 * обёртке не выполняется, и ВНУК остаётся жить, держа порт. Следующий прогон
 * приёмки получил бы «порт занят» — то есть падение по причине, к сайту не
 * относящейся. Поэтому останов идёт по дереву: `taskkill /T /F` на Windows,
 * группа процессов на остальных платформах.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const startScript = fileURLToPath(
  new URL('../../../apps/web/scripts/start-server.mjs', import.meta.url),
);

/** Значение `Retry-After`, которое задаётся серверу и проверяется в ответе. */
export const MAINTENANCE_RETRY_AFTER_SECONDS = 120;

export interface MaintenanceServer {
  /** Схема + хост + порт этого сервера. Ни `baseURL`, ни canonical он не задаёт. */
  readonly origin: string;
  /** Останов вместе со всем деревом процессов. Идемпотентен. */
  stop(): Promise<void>;
}

/**
 * Порт второго сервера.
 *
 * По умолчанию — порт основного стенда плюс один. Значение переопределяется
 * `SEO_MAINTENANCE_PORT`: когда приёмку гоняют несколько агентов на одной машине,
 * занятым может оказаться и он.
 */
export function maintenancePort(mainPort: number, env = process.env): number {
  const raw = (env['SEO_MAINTENANCE_PORT'] ?? '').trim();
  if (raw === '') {
    return mainPort + 1;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `SEO-приёмка: SEO_MAINTENANCE_PORT=«${raw}» не является номером порта (1..65535).`,
    );
  }
  return port;
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * Поднимает сервер с включённым режимом обслуживания и ждёт первого ответа 503.
 *
 * @throws Error если процесс завершился сам (нет собранного артефакта, занят
 *   порт, непонятное значение выключателя) либо не ответил 503 за отведённое
 *   время. Ожидание именно 503, а не «любого ответа»: сервер, поднявшийся БЕЗ
 *   режима, отвечает 200, и молча проверять на нём режим обслуживания нельзя.
 */
export async function startMaintenanceServer(port: number): Promise<MaintenanceServer> {
  const origin = `http://127.0.0.1:${String(port)}`;
  const output: string[] = [];

  const child = spawn(process.execPath, [startScript], {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      MAINTENANCE_MODE: 'on',
      MAINTENANCE_RETRY_AFTER: String(MAINTENANCE_RETRY_AFTER_SECONDS),
      PORT: String(port),
      // Собранный артефакт уже есть, а хост этому серверу нужен только чтобы
      // приложение поднялось: страница 503 адресов не печатает вовсе.
      SITE_URL: origin,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));

  // Состояние выхода живёт в объекте, а чтение идёт через функцию: у `let`,
  // которому присваивает обработчик события, вывод типов после первой проверки
  // сузил бы тип до «никогда» и сообщение об ошибке перестало бы собираться.
  const state: { exit?: string } = {};
  child.on('exit', (code, signal) => {
    state.exit = signal === null ? `код ${String(code)}` : `сигнал ${signal}`;
  });
  const exitReason = (): string | undefined => state.exit;

  const deadline = Date.now() + 60_000;
  for (;;) {
    const finished = exitReason();
    if (finished !== undefined) {
      throw new Error(
        `SEO-приёмка: сервер режима обслуживания на ${origin} завершился, не начав отвечать ` +
          `(${finished}). Вывод процесса:\n${output.join('')}`,
      );
    }
    try {
      const response = await fetch(origin, { redirect: 'manual' });
      if (response.status === 503) {
        return {
          origin,
          stop: async (): Promise<void> => {
            if (exitReason() === undefined) {
              killTree(child);
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          },
        };
      }
      killTree(child);
      throw new Error(
        `SEO-приёмка: сервер на ${origin} поднят с MAINTENANCE_MODE=on, но отдал ` +
          `${String(response.status)} вместо 503. Выключатель существует и не работает — это ` +
          'дефект apps/web, а не теста.',
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('SEO-приёмка:')) {
        throw error;
      }
      if (Date.now() > deadline) {
        killTree(child);
        throw new Error(
          `SEO-приёмка: сервер режима обслуживания на ${origin} не ответил за 60 с. ` +
            `Вывод процесса:\n${output.join('')}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
