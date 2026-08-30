/**
 * Окружение серверной части apps/web.
 *
 * Единственный `.env` монорепозитория лежит в КОРНЕ (шаблон — `.env.example`), а
 * Vite (и через него Astro) по умолчанию читает `.env` из каталога проекта, то
 * есть `apps/web/.env`. Поэтому загрузка делается явно и одинаково для всех
 * входов: `astro dev`, `astro build` (пререндер) и собранный сервер
 * `dist/server/entry.mjs`.
 *
 * Почему `process.env`, а не `import.meta.env`: значения `import.meta.env`
 * подставляются на СБОРКЕ, то есть хост из `SITE_URL` оказался бы запечён в
 * артефакт. Хост обязан читаться в рантайме — иначе один и тот же билд нельзя
 * поднять на стенде и в production, и один из них молча собрал бы canonical на
 * чужом хосте. Тот же приём и по той же причине применяет `apps/cms`
 * (`apps/cms/src/env.mjs`).
 *
 * Дублирование поиска корня с `apps/cms/src/env.mjs` намеренное и отмечено в
 * отчёте: перенос этой функции в `packages/shared` — правка чужой зоны, её
 * делает владелец пакета отдельной задачей. Значений по умолчанию здесь нет ни
 * для одного параметра: их валидацию выполняют хелперы `@otkritka/shared`
 * (`resolveSiteOrigin`, `parseAdminPath`), и пустое значение обязано валить
 * рендер, а не подставлять плейсхолдер.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { currentEnv, type SharedEnv } from '@otkritka/shared';

const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

let envFileLoaded = false;

/**
 * Корень монорепозитория: поиск вверх по дереву по `pnpm-workspace.yaml`.
 * Привязки к глубине вложенности нет — и в исходниках (`apps/web/src`), и в
 * сборке (`apps/web/dist/server`) маркер находится по одному и тому же правилу.
 */
function findWorkspaceRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, WORKSPACE_MARKER))) {
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
 * Однократно подмешивает корневой `.env` в `process.env`.
 *
 * `process.loadEnvFile` (Node >= 22) НЕ перезаписывает уже заданные переменные:
 * настоящее окружение (CI, docker, systemd) приоритетнее файла. Отсутствие файла
 * ошибкой не является — в production переменные приходят из окружения, а не из
 * файла; ошибкой является ПУСТОЕ значение, и её бросают уже хелперы, которым
 * это значение нужно.
 */
function loadRootEnvFile(): void {
  if (envFileLoaded) {
    return;
  }
  envFileLoaded = true;

  const root = findWorkspaceRoot();
  if (root === null) {
    return;
  }
  const envFile = join(root, '.env');
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
}

/** Срез окружения для шаблонов и middleware. Побочно подгружает корневой `.env`. */
export function serverEnv(): SharedEnv {
  loadRootEnvFile();
  return currentEnv();
}

/**
 * Корень монорепозитория. Нужен параметрам окружения, значение которых может
 * быть ОТНОСИТЕЛЬНЫМ путём: `IMAGE_STORAGE_DERIVATIVES_ROOT` — корень
 * производных, из которого отдаётся `/media/...` (задача Э2-04b). То же правило
 * и то же обоснование, что в `apps/cms` (`src/env.mjs`): рабочий каталог
 * процесса у web и cms разный, а дерево файлов одно, поэтому относительный путь
 * разрешается от корня репозитория, а не от `process.cwd()`.
 *
 * @throws Error если маркер рабочего пространства не найден. Молча вернуть
 *   `process.cwd()` нельзя: тогда корень отдачи зависел бы от того, откуда
 *   запущен процесс, и половина изображений «пропадала» бы без сообщения.
 */
export function workspaceRoot(): string {
  const root = findWorkspaceRoot();
  if (root === null) {
    throw new Error(
      `Корень монорепозитория не найден: вверх от ${dirname(fileURLToPath(import.meta.url))} нет ` +
        `файла ${WORKSPACE_MARKER}. От этого корня разрешаются относительные пути из .env ` +
        '(например IMAGE_STORAGE_DERIVATIVES_ROOT). Подстановка рабочего каталога процесса ' +
        'вместо корня дала бы разные пути у apps/web и apps/cms — файлы писались бы в одно ' +
        'дерево, а отдавались из другого.',
    );
  }
  return root;
}
