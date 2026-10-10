/**
 * Инварианты папки миграций схемы (`src/migrations`).
 *
 * Миграции — единственный путь новой колонки в прод-базу: в production Payload
 * схему не пушит, и 2026-10-04 поле без колонки уронило весь сайт. Поэтому
 * здесь ловится то, что ломает `payload migrate` целиком, а не одну миграцию:
 *   - импорт типов `MigrateUpArgs`/`MigrateDownArgs` как значений. Его пишет
 *     шаблон Payload, и под загрузчиком со strip-types файл падает на старте
 *     (`does not provide an export named 'MigrateDownArgs'`) — не применяется
 *     ни одна миграция. Обёртка `migrate:create` строку чинит; тест ловит файл,
 *     созданный в обход неё;
 *   - `index.ts`, разошедшийся с файлами: миграция, которой нет в списке, на
 *     проде не выполнится.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

const migrationNames = fs
  .readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.ts') && file !== 'index.ts')
  .map((file) => file.replace(/\.ts$/, ''))
  .sort();

describe('src/migrations', () => {
  it('содержит хотя бы стартовую миграцию', () => {
    expect(migrationNames.length).toBeGreaterThan(0);
  });

  it.each(migrationNames)('%s импортирует типы миграции только как type', (name) => {
    const source = fs.readFileSync(path.join(migrationsDir, `${name}.ts`), 'utf8');
    const imports = source.match(/^import \{[^}]*\} from '@payloadcms\/db-postgres'/gm) ?? [];
    for (const line of imports) {
      expect(line).not.toMatch(/[{,]\s*Migrate(Up|Down)Args\b/);
    }
  });

  it.each(migrationNames)('%s имеет снимок схемы рядом', (name) => {
    expect(fs.existsSync(path.join(migrationsDir, `${name}.json`))).toBe(true);
  });

  it('index.ts перечисляет ровно файлы миграций', () => {
    const index = fs.readFileSync(path.join(migrationsDir, 'index.ts'), 'utf8');
    const listed = [...index.matchAll(/name: '([^']+)'/g)].map((match) => match[1]).sort();
    expect(listed).toEqual(migrationNames);
  });
});
