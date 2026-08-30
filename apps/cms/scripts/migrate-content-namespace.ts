/**
 * Перенос подборок из `/podborki` в единый namespace `/otkrytki`.
 *
 * По умолчанию команда только строит план:
 *   payload run ./scripts/migrate-content-namespace.ts
 * Изменение данных требует явного флага:
 *   payload run ./scripts/migrate-content-namespace.ts -- --apply
 *
 * Скрипт не пишет `status`, `robots` и redirects. Опубликованный старый URL
 * останавливает весь запуск: для него человек обязан выбрать одиночный 301.
 */
import type { Payload } from 'payload';

import { contentDocumentPath } from '../src/seo/paths';

const LEGACY_PREFIX = '/podborki';

interface MigrationDocument {
  readonly id: number | string;
  readonly parent?: unknown;
  readonly path?: unknown;
  readonly pathClaimKey?: unknown;
  readonly publishedAt?: unknown;
  readonly ownerCollection?: unknown;
  readonly ownerKey?: unknown;
  readonly slug?: unknown;
  readonly status?: unknown;
  readonly title?: unknown;
}

export type MigrationMode = 'apply' | 'dry-run';

export function migrationMode(args: readonly string[]): MigrationMode {
  if (args.length === 0 || (args.length === 1 && args[0] === '--dry-run')) {
    return 'dry-run';
  }
  if (args.length === 1 && args[0] === '--apply') {
    return 'apply';
  }
  if (args.includes('--apply') && args.includes('--dry-run')) {
    throw new Error('Выберите только один режим: --dry-run или --apply.');
  }
  throw new Error(`Неизвестные аргументы migration: ${args.join(' ') || '—'}.`);
}

function isLegacyPath(path: unknown): path is string {
  return typeof path === 'string' && (path === LEGACY_PREFIX || path.startsWith(`${LEGACY_PREFIX}/`));
}

export function assertNoPublishedLegacyCollections(
  collections: readonly MigrationDocument[],
): void {
  const blocked = collections.flatMap((doc) => {
    const current = typeof doc.path === 'string' ? doc.path : null;
    const future = projectedPath('collections', doc);
    const wasPublished =
      doc.publishedAt !== undefined && doc.publishedAt !== null && doc.publishedAt !== '';
    return wasPublished && current !== null && future !== null && current !== future
      ? [{ current, doc, future }]
      : [];
  });
  if (blocked.length === 0) {
    return;
  }

  throw new Error(
    'Миграция остановлена: опубликованные URL /podborki требуют выбранного человеком ' +
      'одиночного 301. Записи: ' +
      blocked
        .map(({ current, doc, future }) =>
          `${String(doc.id)} «${typeof doc.title === 'string' ? doc.title : 'без названия'}» ` +
          `${current} → ${future}`,
        )
        .join('; '),
  );
}

export function topLevelLegacyCollectionIds(
  collections: readonly MigrationDocument[],
): readonly (number | string)[] {
  return collections
    .filter(
      (doc) =>
        (doc.status === 'draft' || doc.status === 'review') &&
        (doc.parent === null || doc.parent === undefined) &&
        isLegacyPath(doc.path),
    )
    .map((doc) => doc.id);
}

async function readAll(
  payload: Payload,
  collection: 'cards' | 'collections' | 'content-path-claims',
): Promise<MigrationDocument[]> {
  const docs: MigrationDocument[] = [];
  let page = 1;
  let hasNextPage = true;
  while (hasNextPage) {
    const result = await payload.find({
      collection,
      depth: 0,
      limit: 500,
      overrideAccess: true,
      page,
      sort: 'id',
    });
    docs.push(...result.docs.map((doc) => ({ ...doc })));
    hasNextPage = result.hasNextPage;
    page += 1;
  }
  return docs;
}

function projectedPath(collection: 'cards' | 'collections', doc: MigrationDocument): string | null {
  const current = contentDocumentPath(collection, { ...doc });
  if (collection === 'collections' && current !== null && isLegacyPath(current)) {
    return `/otkrytki${current.slice(LEGACY_PREFIX.length)}`;
  }
  return current;
}

function assertNoProjectedCollisions(
  cards: readonly MigrationDocument[],
  collections: readonly MigrationDocument[],
): void {
  const owners = new Map<string, string>();
  for (const [kind, docs] of [
    ['cards', cards],
    ['collections', collections],
  ] as const) {
    for (const doc of docs) {
      const path = projectedPath(kind, doc);
      if (path === null) {
        continue;
      }
      const owner = `${kind}:id:${String(doc.id)}`;
      const previous = owners.get(path);
      if (previous !== undefined) {
        throw new Error(
          `Миграция остановлена: итоговый путь «${path}» одновременно принадлежит ` +
            `${previous} и ${owner}. Сначала выберите другой slug.`,
        );
      }
      owners.set(path, owner);
    }
  }
}

function stableOwnerKey(
  collection: 'cards' | 'collections',
  doc: MigrationDocument,
): string | null {
  return typeof doc.pathClaimKey === 'string' && doc.pathClaimKey.trim() !== ''
    ? `${collection}:${doc.pathClaimKey}`
    : null;
}

export function assertProjectedClaimsAvailable(
  cards: readonly MigrationDocument[],
  collections: readonly MigrationDocument[],
  claims: readonly MigrationDocument[],
): void {
  const claimsByPath = new Map<string, MigrationDocument>();
  for (const claim of claims) {
    if (typeof claim.path === 'string') {
      claimsByPath.set(claim.path, claim);
    }
  }

  for (const [collection, docs] of [
    ['cards', cards],
    ['collections', collections],
  ] as const) {
    for (const doc of docs) {
      const path = projectedPath(collection, doc);
      if (path === null) {
        continue;
      }
      const claim = claimsByPath.get(path);
      if (claim === undefined) {
        continue;
      }
      const expectedOwner = stableOwnerKey(collection, doc);
      if (claim.ownerCollection === collection && claim.ownerKey === expectedOwner) {
        continue;
      }
      const actualOwner =
        typeof claim.ownerKey === 'string' && claim.ownerKey !== ''
          ? claim.ownerKey
          : `${String(claim.ownerCollection)}:без-stable-owner-key`;
      throw new Error(
        `Миграция остановлена: итоговый путь «${path}» навсегда занят claim ` +
          `«${actualOwner}», а запись ${collection}:${String(doc.id)} ожидает ` +
          `«${expectedOwner ?? 'отсутствующий stable owner key'}».`,
      );
    }
  }
}

async function touch(payload: Payload, collection: 'cards' | 'collections', id: number | string) {
  if (collection === 'cards') {
    await payload.update({ collection, id, data: {}, overrideAccess: true });
  } else {
    await payload.update({ collection, id, data: {}, overrideAccess: true });
  }
}

async function assertMigrationComplete(payload: Payload): Promise<void> {
  const [cards, collections, claims] = await Promise.all([
    readAll(payload, 'cards'),
    readAll(payload, 'collections'),
    readAll(payload, 'content-path-claims'),
  ]);
  const legacy = collections.filter((doc) => isLegacyPath(doc.path));
  if (legacy.length > 0) {
    throw new Error(
      `После миграции остались пути /podborki: ${legacy.map((doc) => String(doc.path)).join(', ')}`,
    );
  }

  const claimed = new Set(
    claims.flatMap((claim) => (typeof claim.path === 'string' ? [claim.path] : [])),
  );
  const missing = [
    ...cards.map((doc) => contentDocumentPath('cards', { ...doc })),
    ...collections.map((doc) => contentDocumentPath('collections', { ...doc })),
  ].filter((path): path is string => path !== null && !claimed.has(path));
  if (missing.length > 0) {
    throw new Error(`После миграции отсутствуют claims для путей: ${missing.join(', ')}`);
  }
}

export async function runContentNamespaceMigration(
  payload: Payload,
  mode: MigrationMode,
): Promise<void> {
  // Сначала читается весь контент и выполняются все блокирующие preflight-проверки.
  const [cards, collections, claims] = await Promise.all([
    readAll(payload, 'cards'),
    readAll(payload, 'collections'),
    readAll(payload, 'content-path-claims'),
  ]);
  assertNoPublishedLegacyCollections(collections);
  assertNoProjectedCollisions(cards, collections);
  assertProjectedClaimsAvailable(cards, collections, claims);

  const roots = topLevelLegacyCollectionIds(collections);
  console.log(
    `[${mode}] карточек: ${String(cards.length)}, подборок: ${String(collections.length)}, ` +
      `верхнеуровневых узлов к пересборке: ${String(roots.length)}.`,
  );
  if (mode === 'dry-run') {
    console.log('DRY RUN: данные не изменены. Для применения повторите с --apply.');
    return;
  }

  for (const id of roots) {
    await touch(payload, 'collections', id);
  }

  // После пересборки корней descendants уже получили новые path штатными
  // хуками. Повторное сохранение идемпотентно выделяет недостающие ключи/claims.
  const [currentCards, currentCollections] = await Promise.all([
    readAll(payload, 'cards'),
    readAll(payload, 'collections'),
  ]);
  for (const doc of currentCards) {
    await touch(payload, 'cards', doc.id);
  }
  for (const doc of currentCollections) {
    await touch(payload, 'collections', doc.id);
  }

  await assertMigrationComplete(payload);
  console.log('APPLY: namespace перенесён, claims существуют для каждого итогового пути.');
}

// `payload run` исполняет модуль напрямую. Vitest импортирует чистые guards и
// не должен поднимать конфиг/БД, поэтому в тестовом процессе top-level запуск выключен.
if (process.env.VITEST !== 'true') {
  const [{ getPayload }, { default: config }] = await Promise.all([
    import('payload'),
    import('../src/payload.config'),
  ]);
  const payload = await getPayload({ config });
  await runContentNamespaceMigration(payload, migrationMode(process.argv.slice(2)));
}
