#!/usr/bin/env node
/**
 * Запуск СОБРАННОГО сервера apps/web — контракт скрипта `start`.
 *
 * ## Зачем обёртка вместо прямого `node ./dist/server/entry.mjs`
 *
 * Замерено на этой машине после смены активной версии Node: собранный сервер
 * падал первым же обращением к базе —
 *
 *   Cannot find module 'drizzle-kit/api'
 *
 * причём `pnpm --filter @otkritka/web run start` работал раньше и перестал.
 * Механизм: адаптер Postgres у Payload подтягивает `drizzle-kit/api`
 * ДИНАМИЧЕСКИМ импортом при накате схемы (`PAYLOAD_DB_PUSH`, дефолт —
 * «накатывать», пока в проекте нет миграций). Пакет лежит в виртуальном
 * хранилище pnpm (`<корень>/node_modules/.pnpm/node_modules`), а этот каталог не
 * входит в цепочку разрешения от `apps/web/dist/server/chunks/`: рядом с
 * `dist/` нет `node_modules`, а вверх по дереву лежит `apps/web/node_modules`
 * (только прямые зависимости) и корневой `node_modules` (только то, что записано
 * в корневой манифест). Раньше дыру закрывал `NODE_PATH`, который pnpm
 * прокидывал сам; после смены версии Node он перестал приходить, и падение
 * выглядело как «сломался билд», хотя сломалось разрешение модулей.
 *
 * Поэтому запуск фиксируется здесь, а не в подсказке в README: обёртка сама
 * находит виртуальное хранилище и добавляет его в `NODE_PATH` дочернего
 * процесса. Если хранилища нет (установка не pnpm-овская, hoisted-раскладка),
 * ничего не добавляется — и это не ошибка: значит цепочка разрешения и без него
 * полная.
 *
 * ## Почему дочерний процесс, а не правка `process.env` на месте
 *
 * `NODE_PATH` читается ОДИН раз при инициализации путей модулей, до исполнения
 * пользовательского кода. Присвоение внутри уже запущенного процесса ни на что
 * не влияет — пришлось бы звать внутренний `Module._initPaths()`, то есть
 * держать в проекте зависимость от непубличного API. Дочерний процесс с
 * подготовленным окружением честнее и переживёт смену версии Node.
 *
 * Обёртка НЕ добавляет ни одного значения по умолчанию: `SITE_URL`, `HOST`,
 * `PORT`, `PAYLOAD_DB_PUSH` и остальное окружение проходят сквозь неё как есть.
 * Дефолт хоста здесь означал бы canonical, собранный не на том хосте (CLAUDE.md,
 * «Правила URL»).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(appDir, 'dist', 'server', 'entry.mjs');

if (!existsSync(entry)) {
  console.error(
    `[apps/web] Нет точки входа ${entry}.\n` +
      '[apps/web] Сервер поднимается только из собранного артефакта:\n' +
      '[apps/web]   pnpm --filter @otkritka/web run build',
  );
  process.exit(1);
}

/**
 * Корень монорепозитория ищется по маркеру `pnpm-workspace.yaml` — тем же
 * правилом, что в `src/server-env.ts`: привязки к глубине вложенности нет ни в
 * исходниках, ни в сборке. Копия правила здесь потому, что обёртка обязана
 * работать ДО загрузки любого нашего модуля.
 */
function findWorkspaceRoot(from) {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

const workspaceRoot = findWorkspaceRoot(appDir);
const virtualStore =
  workspaceRoot === null ? null : join(workspaceRoot, 'node_modules', '.pnpm', 'node_modules');

const nodePath = [
  ...(virtualStore !== null && existsSync(virtualStore) ? [virtualStore] : []),
  ...(process.env.NODE_PATH ?? '').split(delimiter).filter((entryPath) => entryPath !== ''),
];

if (nodePath.length === 0) {
  console.warn(
    '[apps/web] Виртуальное хранилище pnpm не найдено, NODE_PATH не дополняется. Если сервер ' +
      'упадёт с «Cannot find module \'drizzle-kit/api\'», причина здесь: см. шапку ' +
      'apps/web/scripts/start-server.mjs.',
  );
}

const child = spawn(process.execPath, [entry], {
  cwd: appDir,
  env: { ...process.env, ...(nodePath.length === 0 ? {} : { NODE_PATH: nodePath.join(delimiter) }) },
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on('exit', (code, signal) => {
  // Код выхода дочернего процесса — это код выхода `start`: стенд приёмки и
  // смоук различают «сервер упал» и «сервер остановлен сигналом» по нему.
  process.exit(signal === null ? (code ?? 1) : 1);
});
