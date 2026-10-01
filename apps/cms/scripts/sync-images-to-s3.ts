/**
 * Перенос изображений с локальной ФС в бакет S3 и проверка бакета.
 *
 *   pnpm --filter @otkritka/cms run images:s3:check     — доступ и приватность бакета
 *   pnpm --filter @otkritka/cms run images:s3:dry-run   — что будет загружено
 *   pnpm --filter @otkritka/cms run images:s3:apply     — загрузка
 *
 * Ключ объекта равен относительному пути файла в корне хранилища один в один
 * (условие Ч-03 «тот же путь, другой origin»), поэтому записи CMS не меняются
 * вовсе: ключи в базе уже указывают на правильные объекты. Файл, путь которого
 * не является ключом своего пространства (`cards/...` в корне производных,
 * `originals/...` в корне оригиналов), не загружается и попадает в отчёт.
 *
 * Повторный запуск безопасен: объект, уже лежащий в бакете с тем же размером,
 * пропускается. Локальные файлы скрипт не удаляет — это отдельное решение после
 * переключения `IMAGE_STORAGE_DRIVER=s3` и проверки сайта.
 *
 * Параметры подключения — из `.env` (`S3_*`), корни — `IMAGE_STORAGE_*_ROOT`.
 * Значение `IMAGE_STORAGE_DRIVER` скрипту не важно: он нужен как раз до
 * переключения.
 */
import { randomBytes } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { isDerivativeKey, isOriginalKey } from '@otkritka/images/media';
import {
  createS3ImageBuckets,
  derivativePutOptions,
  resolveS3StorageConfig,
  type ObjectStore,
  type PutObjectOptions,
  type S3StorageConfig,
} from '@otkritka/images/s3';

import { loadEnvFiles } from '../src/env.mjs';
import { resolveImageStorageRoots } from '../src/images/storage-env';

const CONCURRENCY = 16;

type Mode = 'check' | 'dry-run' | 'apply';

function parseMode(argv: readonly string[]): Mode {
  if (argv.includes('--check')) return 'check';
  if (argv.includes('--apply')) return 'apply';
  return 'dry-run';
}

async function* walk(root: string, dir = root): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(root, full);
    } else if (entry.isFile()) {
      yield path.relative(root, full).split(path.sep).join('/');
    }
  }
}

interface Space {
  readonly name: string;
  readonly root: string;
  readonly store: ObjectStore;
  readonly isKey: (key: string) => boolean;
  readonly headers: (key: string) => PutObjectOptions;
}

interface SpaceReport {
  total: number;
  uploaded: number;
  skipped: number;
  rejected: string[];
  failed: string[];
}

async function runPool<T>(items: readonly T[], worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

async function syncSpace(space: Space, apply: boolean): Promise<SpaceReport> {
  const report: SpaceReport = { failed: [], rejected: [], skipped: 0, total: 0, uploaded: 0 };
  const keys: string[] = [];
  for await (const key of walk(space.root)) {
    if (space.isKey(key)) {
      keys.push(key);
    } else {
      report.rejected.push(key);
    }
  }
  report.total = keys.length;

  let done = 0;
  await runPool(keys, async (key) => {
    try {
      const local = await stat(path.join(space.root, key));
      const remote = await space.store.head(key);
      if (remote !== null && remote.size === local.size) {
        report.skipped += 1;
      } else if (apply) {
        await space.store.put(key, await readFile(path.join(space.root, key)), space.headers(key));
        report.uploaded += 1;
      } else {
        report.uploaded += 1;
      }
    } catch (error) {
      report.failed.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
    done += 1;
    if (done % 500 === 0) {
      console.log(`  ${space.name}: ${String(done)}/${String(keys.length)}`);
    }
  });
  return report;
}

/** Адрес объекта без подписи — так его увидел бы посторонний. */
function anonymousUrl(config: S3StorageConfig, bucket: string, key: string): string {
  if (config.forcePathStyle) {
    return `${config.endpoint}/${bucket}/${key}`;
  }
  const endpoint = new URL(config.endpoint);
  return `${endpoint.protocol}//${bucket}.${endpoint.host}/${key}`;
}

/**
 * Проверка бакета(ов): запись, чтение, удаление и ПРИВАТНОСТЬ.
 *
 * Проба пишется под случайным ключом ВНЕ пространств `cards/` и `originals/`
 * (`s3-probe/<случайный>.txt`) и только если такого объекта ещё нет: проверка
 * не должна уметь перезаписать или удалить настоящее изображение.
 */
async function check(config: S3StorageConfig, stores: { originals: ObjectStore; derivatives: ObjectStore }): Promise<boolean> {
  let ok = true;

  console.log(`Эндпоинт: ${config.endpoint}, регион: ${config.region}, path-style: ${String(config.forcePathStyle)}`);
  console.log(`Бакет оригиналов: ${config.bucketOriginals}, бакет производных: ${config.bucketDerivatives}`);

  const targets =
    config.bucketOriginals === config.bucketDerivatives
      ? [stores.originals]
      : [stores.originals, stores.derivatives];

  for (const store of targets) {
    const probeKey = `s3-probe/${randomBytes(16).toString('hex')}.txt`;
    const probe = Buffer.from(`otkritka s3 probe ${new Date().toISOString()}`);
    console.log(`Бакет «${store.bucket}»:`);

    if ((await store.head(probeKey)) !== null) {
      console.error(`  ОШИБКА: случайный ключ пробы «${probeKey}» уже занят — проба не пишется.`);
      ok = false;
      continue;
    }

    await store.put(probeKey, probe);
    const back = await store.read(probeKey);
    if (back === null || !back.equals(probe)) {
      console.error('  ОШИБКА: записанный пробный объект не читается обратно.');
      ok = false;
    } else {
      console.log('  запись и чтение с ключом: OK');
    }

    // Приватность: объект и листинг без подписи отдаваться не должны. Для бакета
    // оригиналов это ТЗ §6.1, для бакета производных — второй адрес тех же
    // файлов вне /media (дубль URL изображения).
    for (const [label, url] of [
      ['объект без подписи', anonymousUrl(config, store.bucket, probeKey)],
      ['листинг без подписи', anonymousUrl(config, store.bucket, '')],
    ] as const) {
      const response = await fetch(url);
      if (response.ok) {
        console.error(
          `  ОШИБКА: ${label} доступен публично (${String(response.status)}). Бакет обязан быть ПРИВАТНЫМ: ` +
            'оригиналы не должны открываться по угадываемому URL (ТЗ §6.1), а производные — иметь второй адрес вне /media.',
        );
        ok = false;
      } else {
        console.log(`  приватность (${label}): OK, ответ ${String(response.status)}`);
      }
    }

    await store.delete(probeKey);
    if ((await store.head(probeKey)) !== null) {
      console.error('  ОШИБКА: пробный объект не удалился.');
      ok = false;
    } else {
      console.log('  удаление: OK');
    }
  }
  return ok;
}

async function main(): Promise<void> {
  loadEnvFiles();
  const mode = parseMode(process.argv.slice(2));
  const config = resolveS3StorageConfig(process.env);
  const buckets = createS3ImageBuckets(config);

  if (mode === 'check') {
    process.exitCode = (await check(config, buckets)) ? 0 : 1;
    return;
  }

  const roots = resolveImageStorageRoots(process.env);
  const spaces: Space[] = [
    {
      headers: () => ({}),
      isKey: isOriginalKey,
      name: 'оригиналы',
      root: roots.originalsRoot,
      store: buckets.originals,
    },
    {
      headers: derivativePutOptions,
      isKey: isDerivativeKey,
      name: 'производные',
      root: roots.derivativesRoot,
      store: buckets.derivatives,
    },
  ];

  console.log(mode === 'apply' ? 'Режим: ЗАГРУЗКА' : 'Режим: пробный прогон (--apply для загрузки)');
  let failed = false;
  for (const space of spaces) {
    console.log(`${space.name}: ${space.root} → ${space.store.bucket}`);
    const report = await syncSpace(space, mode === 'apply');
    console.log(
      `  файлов: ${String(report.total)}, ${mode === 'apply' ? 'загружено' : 'к загрузке'}: ${String(report.uploaded)}, ` +
        `уже в бакете: ${String(report.skipped)}, не ключи пространства: ${String(report.rejected.length)}, ошибок: ${String(report.failed.length)}`,
    );
    for (const key of report.rejected.slice(0, 20)) console.log(`  пропущен (не ключ): ${key}`);
    for (const line of report.failed.slice(0, 20)) console.error(`  ОШИБКА: ${line}`);
    failed ||= report.failed.length > 0;
  }
  process.exitCode = failed ? 1 : 0;
}

await main();
