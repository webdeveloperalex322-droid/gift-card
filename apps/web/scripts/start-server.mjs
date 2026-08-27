#!/usr/bin/env node
/**
 * Запуск СОБРАННОГО сервера apps/web — контракт скрипта `start`.
 *
 * ## Зачем обёртка вместо прямого `node ./dist/server/entry.mjs`
 *
 * Осталась ровно одна причина, и она про КОД ВЫХОДА. Стенд SEO-приёмки и смоуки
 * различают «сервер упал» и «сервер остановлен сигналом» по коду выхода `start`;
 * обёртка пробрасывает сигналы дочернему процессу и превращает его исход в свой.
 * Заодно она проверяет наличие артефакта и объясняет, чем его собрать, — иначе
 * запуск без сборки даёт `ERR_MODULE_NOT_FOUND` на пути внутри `dist/`, который
 * ни о чём не говорит.
 *
 * ## Чего здесь БОЛЬШЕ НЕТ
 *
 * Прежде обёртка существовала ещё и ради `NODE_PATH`: собранный сервер падал
 * первым обращением к базе с `Cannot find module 'drizzle-kit/api'`, и дыру
 * закрывала подстановка виртуального хранилища pnpm. Это лечило симптом —
 * настоящей причиной была ФАНТОМНАЯ зависимость (`drizzle-kit` не объявлен в
 * манифесте пакета, который его грузит). Зависимость объявлена в
 * `apps/web/package.json`, `NODE_PATH` убран; разбор и замер — в шапке
 * `./server-child-env.mjs`.
 *
 * ## Почему дочерний процесс, а не запуск в этом же
 *
 * Чтобы окружение конкретного входа (`HOST`, `PORT`, `SITE_URL`) собиралось в
 * одном месте на все четыре входа (`serverChildEnv`) и чтобы сигнал доходил до
 * сервера, а не до обёртки.
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

import { serverChildEnv } from './server-child-env.mjs';

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
