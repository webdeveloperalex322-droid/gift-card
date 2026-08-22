#!/usr/bin/env node
/**
 * Создаёт базу из `DATABASE_URL`, если её ещё нет (задача Э1-02).
 *
 * Зачем отдельный шаг: `CREATE DATABASE` нельзя выполнить из уже открытого
 * подключения к самой создаваемой базе, поэтому адаптер Payload этого не делает
 * и падает с `database "…" does not exist`. Скрипт подключается к служебной базе
 * `postgres` тем же пользователем и создаёт целевую.
 *
 * Скрипт идемпотентен и НЕ трогает существующую базу: ни схему, ни данные.
 * Пароль и хост берутся только из `DATABASE_URL` — ни одного значения доступа в
 * коде нет.
 *
 * Запуск: `pnpm --filter @otkritka/cms run ensure-db`
 */

import { Client } from 'pg';

import { loadEnvFiles, requireEnv } from '../src/env.mjs';

/** Служебная база, к которой подключаемся, чтобы создать целевую. */
const MAINTENANCE_DATABASE = 'postgres';

loadEnvFiles();

const databaseUrl = requireEnv('DATABASE_URL');

const target = new URL(databaseUrl);
const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ''));

if (databaseName === '') {
  throw new Error(
    'DATABASE_URL не содержит имени базы: ожидается ' +
      'postgres://<user>:<password>@<host>:<port>/<database>.',
  );
}

const maintenanceUrl = new URL(databaseUrl);
maintenanceUrl.pathname = `/${MAINTENANCE_DATABASE}`;

const client = new Client({ connectionString: maintenanceUrl.toString() });

await client.connect();

try {
  const { rows } = await client.query('select 1 from pg_database where datname = $1', [
    databaseName,
  ]);

  if (rows.length > 0) {
    console.log(`База ${databaseName} уже существует — ничего не делаю.`);
  } else {
    // Имя базы нельзя передать параметром: CREATE DATABASE не принимает
    // placeholder'ов. Поэтому идентификатор экранируется вручную.
    const quoted = `"${databaseName.replaceAll('"', '""')}"`;
    await client.query(`CREATE DATABASE ${quoted}`);
    console.log(`База ${databaseName} создана.`);
  }
} finally {
  await client.end();
}
