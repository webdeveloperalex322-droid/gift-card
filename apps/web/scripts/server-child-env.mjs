#!/usr/bin/env node
/**
 * Окружение для дочернего процесса СОБРАННОГО сервера apps/web — единственное
 * место, где живёт правило разрешения модулей.
 *
 * ## Что за правило и почему без него сервер падает
 *
 * Замерено на этой машине (и повторено дважды: на скрипте `start` и на смоуке
 * правила слеша): собранный сервер падает первым же обращением к базе —
 *
 *   Error: Cannot find module 'drizzle-kit/api'
 *
 * Механизм: адаптер Postgres у Payload подтягивает `drizzle-kit/api`
 * ДИНАМИЧЕСКИМ импортом при накате схемы (`PAYLOAD_DB_PUSH`, дефолт —
 * «накатывать», пока в проекте нет миграций). Пакет лежит в виртуальном
 * хранилище pnpm (`<корень>/node_modules/.pnpm/node_modules`), а этот каталог не
 * входит в цепочку разрешения от `apps/web/dist/server/chunks/`: рядом с `dist/`
 * нет `node_modules`, а вверх по дереву лежат только прямые зависимости.
 * Раньше дыру закрывал `NODE_PATH`, который pnpm прокидывал сам; после смены
 * активной версии Node он перестал приходить.
 *
 * ## Почему это отдельный модуль, а не строка в каждом скрипте
 *
 * Сервер поднимают ЧЕТЫРЕ входа: скрипт `start` (его же использует стенд
 * SEO-приёмки) и три смоука. Пока правило жило в одном из них, остальные падали
 * по одной причине, но с разными симптомами: у смоука правила слеша это выглядело
 * как «/ отдаёт 500» — то есть как сломанная главная, а не как разрешение
 * модулей. Здесь оно одно, и новый вход получает его импортом.
 *
 * Значений по умолчанию модуль не добавляет: `SITE_URL`, `HOST`, `PORT`,
 * `PAYLOAD_DB_PUSH` и остальное окружение проходят сквозь него как есть. Дефолт
 * хоста означал бы canonical, собранный не на том хосте (CLAUDE.md, «Правила
 * URL»).
 */

import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

/**
 * Корень монорепозитория по маркеру `pnpm-workspace.yaml` — то же правило, что в
 * `src/server-env.ts`: привязки к глубине вложенности нет ни в исходниках, ни в
 * сборке.
 *
 * @param {string} from каталог, от которого идёт поиск вверх
 * @returns {string | null}
 */
export function findWorkspaceRoot(from) {
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

/**
 * Значение `NODE_PATH` для дочернего процесса: виртуальное хранилище pnpm плюс
 * то, что уже было в окружении.
 *
 * `null` — дополнять нечего: либо хранилища нет (не pnpm-овская раскладка, тогда
 * цепочка разрешения и без него полная), либо корень монорепозитория не найден.
 *
 * @param {string} from каталог, от которого ищется корень монорепозитория
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function serverNodePath(from, env = process.env) {
  const root = findWorkspaceRoot(from);
  const virtualStore = root === null ? null : join(root, 'node_modules', '.pnpm', 'node_modules');
  const existing = (env.NODE_PATH ?? '').split(delimiter).filter((entry) => entry !== '');

  if (virtualStore === null || !existsSync(virtualStore)) {
    return existing.length === 0 ? null : existing.join(delimiter);
  }
  return [virtualStore, ...existing.filter((entry) => entry !== virtualStore)].join(delimiter);
}

/**
 * Окружение для дочернего процесса собранного сервера.
 *
 * @param {string} from каталог, от которого ищется корень монорепозитория
 * @param {Record<string, string>} [extra] переменные конкретного входа: `HOST`,
 *   `PORT`, `SITE_URL`. Они переопределяют текущее окружение — так задумано:
 *   стенд обязан управлять адресом сервера, который сам же и поднял.
 * @returns {NodeJS.ProcessEnv}
 */
export function serverChildEnv(from, extra = {}) {
  const nodePath = serverNodePath(from, process.env);
  return {
    ...process.env,
    ...extra,
    ...(nodePath === null ? {} : { NODE_PATH: nodePath }),
  };
}
