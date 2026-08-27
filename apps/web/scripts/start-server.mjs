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
 * Поэтому запуск фиксируется здесь, а не в подсказке в README. Само правило
 * живёт в `./server-child-env.mjs` — его же импортируют смоуки, которые тоже
 * поднимают собранный сервер: пока правило было только здесь, смоук правила
 * слеша падал «главная отдаёт 500», то есть с симптомом вместо причины.
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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serverChildEnv, serverNodePath } from './server-child-env.mjs';

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

const nodePath = serverNodePath(appDir);
if (nodePath === null) {
  console.warn(
    '[apps/web] Виртуальное хранилище pnpm не найдено, NODE_PATH не дополняется. Если сервер ' +
      "упадёт с «Cannot find module 'drizzle-kit/api'», причина здесь: см. шапку " +
      'apps/web/scripts/server-child-env.mjs.',
  );
}

const child = spawn(process.execPath, [entry], {
  cwd: appDir,
  env: serverChildEnv(appDir),
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
