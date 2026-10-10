#!/usr/bin/env node
/**
 * Обёртка над `payload migrate:create`: создаёт миграцию и чинит её импорт.
 *
 * Зачем обёртка. Шаблон Payload 3.88 пишет первой строкой
 * `import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'`
 * — типы импортируются как значения. Под загрузчиком со strip-types (Node 23+
 * без tsx) такой файл падает на старте с `does not provide an export named
 * 'MigrateDownArgs'`, и `payload migrate` не выполняет НИ ОДНОЙ миграции. Здесь
 * строка переписывается на `type`-импорт во всех файлах папки, где она есть.
 *
 * Режим `--check` (для CI): миграция создаётся с `--skip-empty`, и если схема из
 * конфига разошлась с последним снимком в `src/migrations`, появившийся файл
 * удаляется, а скрипт падает. Так поле без миграции не доезжает до `main`, а
 * значит и до прода, где Payload схему не пушит.
 *
 * Запуск:
 *   pnpm --filter @otkritka/cms run migrate:create <имя>
 *   pnpm --filter @otkritka/cms run migrate:check
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cmsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(cmsRoot, 'src', 'migrations');
// `payload/package.json` в exports пакета не объявлен — идём через симлинк
// node_modules самого apps/cms, где pnpm и кладёт зависимость.
const payloadBin = path.join(fs.realpathSync(path.join(cmsRoot, 'node_modules', 'payload')), 'bin.js');

const GENERATED_IMPORT =
  /^import \{ MigrateUpArgs, MigrateDownArgs, sql \} from '@payloadcms\/db-postgres'$/m;
const FIXED_IMPORT =
  "import { sql, type MigrateDownArgs, type MigrateUpArgs } from '@payloadcms/db-postgres'";

const args = process.argv.slice(2);
const check = args.includes('--check');
const name = args.find((arg) => !arg.startsWith('--'));

if (!check && !name) {
  console.error('Укажи имя миграции: pnpm --filter @otkritka/cms run migrate:create <имя>');
  process.exit(2);
}

const listFiles = () => (fs.existsSync(migrationsDir) ? fs.readdirSync(migrationsDir) : []);
const before = new Set(listFiles());

// Снимок index.ts в памяти, а не `git checkout`: файл может быть ещё не
// закоммичен или держать незакоммиченную запись свежей миграции — git вернул бы
// не то или упал бы молча.
const indexPath = path.join(migrationsDir, 'index.ts');
const indexBefore = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : null;

/** Убирает всё, что создал генератор, и возвращает index.ts к снимку. */
const rollback = (created) => {
  for (const file of created) {
    fs.rmSync(path.join(migrationsDir, file), { force: true });
  }
  if (indexBefore === null) {
    fs.rmSync(indexPath, { force: true });
  } else {
    fs.writeFileSync(indexPath, indexBefore);
  }
};

const result = spawnSync(
  process.execPath,
  [payloadBin, 'migrate:create', check ? 'schema-drift-check' : name, '--skip-empty'],
  // stdin закрыт намеренно: вопрос Payload «создать пустую миграцию?» без TTY
  // получает отказ, а не вешает процесс.
  { cwd: cmsRoot, stdio: ['ignore', 'inherit', 'inherit'] },
);

const created = listFiles().filter((file) => !before.has(file));

if (result.status !== 0) {
  // Генератор пишет .json раньше .ts: осиротевший снимок стал бы «последним»
  // для следующего migrate:create и спрятал бы расхождение схемы.
  rollback(created);
  process.exit(result.status ?? 1);
}

if (check) {
  if (created.length > 0) {
    rollback(created);
    console.error(
      'Схема из конфига Payload разошлась с последней миграцией в apps/cms/src/migrations.\n' +
        'Создай миграцию: pnpm --filter @otkritka/cms run migrate:create <имя> — и закоммить её.\n' +
        'Без неё новое поле доедет до прода кодом, но не колонкой, и сайт упадёт.',
    );
    process.exit(1);
  }
  console.log('Схема совпадает с последней миграцией.');
  process.exit(0);
}

for (const file of listFiles().filter((f) => f.endsWith('.ts'))) {
  const full = path.join(migrationsDir, file);
  const source = fs.readFileSync(full, 'utf8');
  if (GENERATED_IMPORT.test(source)) {
    fs.writeFileSync(full, source.replace(GENERATED_IMPORT, FIXED_IMPORT));
  }
}

if (created.length === 0) {
  console.log('Изменений схемы нет — миграция не создана.');
} else {
  console.log(`Создано: ${created.join(', ')}`);
}
