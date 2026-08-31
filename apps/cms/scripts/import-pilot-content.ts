/**
 * One-off pilot importer. Dry-run is the default and is strictly read-only;
 * apply runs only after that same process receives a clean preflight report.
 *
 * `payload run` imports this module directly. All argument and environment
 * checks happen before Payload/config import, and dry-run disables schema push
 * plus onInit seeding so initialization is read-only too.
 */
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { PostgresAdapter } from '@payloadcms/db-postgres';
import { sql } from '@payloadcms/db-postgres';
import {
  commitTransaction,
  initTransaction,
  killTransaction,
  type Payload,
  type PayloadRequest,
} from 'payload';

import { loadManifest } from '../../../scripts/content-pilot/manifest.mjs';
import { loadSiteContent } from '../../../scripts/content-import/schema.js';
import {
  applyPilotContent,
  type PilotApplyStore,
  type PilotImportReport,
  type PilotVerificationExpected,
} from '../src/import/pilot-apply';
import {
  runPilotPreflight,
  type ExistingCard,
  type ExistingCollection,
  type ExistingContentPathClaim,
  type PilotImportStore,
  type PilotPreflightReport,
} from '../src/import/pilot-preflight';
import { pilotIntroDocument } from '../src/import/pilot-types';
import {
  pilotCardImportKey,
  pilotImageImportKey,
  trustedPilotImportContext,
} from '../src/import/pilot-import-identity';
import { loadEnvFiles, workspaceRoot } from '../src/env.mjs';
import type { Card, CardImage, Collection, User } from '../src/payload-types';

export type PilotImportMode = 'apply' | 'dry-run';

export interface PilotImportEnvironment {
  readonly actorEmail: string;
  readonly assetRoot: string;
}

export function resolvePilotWorkspaceRoot(): string {
  return workspaceRoot();
}

function rejectDestructiveDatabaseEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): void {
  const raw = env.PAYLOAD_DROP_DATABASE?.trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') {
    throw new Error('PAYLOAD_DROP_DATABASE must not be enabled for pilot import.');
  }
}

export function parsePilotImportMode(args: readonly string[]): PilotImportMode {
  if (args.length === 0 || (args.length === 1 && args[0] === '--dry-run')) {
    return 'dry-run';
  }
  if (args.length === 1 && args[0] === '--apply') {
    return 'apply';
  }
  if (args.includes('--apply') && args.includes('--dry-run')) {
    throw new Error('Choose only one mode: --dry-run or --apply.');
  }
  throw new Error(`Unknown arguments: ${args.join(' ') || 'none'}.`);
}

export function requirePilotImportEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): PilotImportEnvironment {
  const actorEmail = env.CONTENT_IMPORT_AI_EDITOR_EMAIL?.trim() ?? '';
  if (actorEmail === '') {
    throw new Error('CONTENT_IMPORT_AI_EDITOR_EMAIL must identify an existing ai-editor.');
  }
  const configuredAssetRoot = env.CONTENT_IMPORT_ASSET_ROOT?.trim() ?? '';
  if (configuredAssetRoot === '') {
    throw new Error('CONTENT_IMPORT_ASSET_ROOT must point to the accepted JPEG masters.');
  }
  return {
    actorEmail,
    assetRoot: resolve(cwd, configuredAssetRoot),
  };
}

export async function initializePilotDryRun<T>(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  workspaceRoot: string,
  initializePayload: () => Promise<T> | T,
): Promise<{ readonly environment: PilotImportEnvironment; readonly payload: T }> {
  const mode = parsePilotImportMode(args);
  if (mode === 'apply') {
    throw new Error('--apply is not implemented in Task 6; run --dry-run only.');
  }
  const environment = requirePilotImportEnvironment(env, workspaceRoot);
  rejectDestructiveDatabaseEnvironment(env);
  return { environment, payload: await initializePayload() };
}

export async function initializePilotImport<T>(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  workspaceRoot: string,
  initializers: {
    readonly initializeApply: () => Promise<T> | T;
    readonly initializeDryRun: () => Promise<T> | T;
  },
): Promise<{
  readonly environment: PilotImportEnvironment;
  readonly mode: PilotImportMode;
  readonly payload: T;
}> {
  const mode = parsePilotImportMode(args);
  const environment = requirePilotImportEnvironment(env, workspaceRoot);
  rejectDestructiveDatabaseEnvironment(env);
  const payload = mode === 'apply'
    ? await initializers.initializeApply()
    : await initializers.initializeDryRun();
  return { environment, mode, payload };
}

export async function initializePilotPayloadDryRun(options: {
  readonly disableDBConnect?: boolean;
  readonly key?: string;
} = {}): Promise<Payload> {
  // Load the root .env before the destructive-variable gate. Otherwise a
  // PAYLOAD_DROP_DATABASE value discovered by payload.config.ts would bypass
  // the earlier process.env check and reach the adapter at connect time.
  loadEnvFiles();
  rejectDestructiveDatabaseEnvironment(process.env);
  process.env.PAYLOAD_DB_PUSH = 'false';
  process.env.PAYLOAD_DB_DISABLE_CREATE = 'true';
  const [{ getPayload }, { default: configPromise }] = await Promise.all([
    import('payload'),
    import('../src/payload.config'),
  ]);
  const config = await configPromise;
  const dryRunConfig = Promise.resolve({
    ...config,
    admin: {
      ...config.admin,
      importMap: {
        ...config.admin.importMap,
        autoGenerate: false,
      },
    },
    typescript: {
      ...config.typescript,
      autoGenerate: false,
    },
  });
  return getPayload({
    config: dryRunConfig,
    ...(options.disableDBConnect === undefined
      ? {}
      : { disableDBConnect: options.disableDBConnect }),
    disableOnInit: true,
    key: options.key ?? 'pilot-import-preflight',
  });
}

export async function initializePilotPayloadApply(options: {
  readonly disableDBConnect?: boolean;
  readonly key?: string;
} = {}): Promise<Payload> {
  // Apply still starts with preflight. Reuse the hardened initialization so
  // schema push, database creation, type/import-map generation and onInit are
  // unable to mutate anything before preflight succeeds. The returned Local
  // API remains fully capable of the explicit writes performed afterwards.
  return initializePilotPayloadDryRun({
    ...options,
    key: options.key ?? 'pilot-import-apply',
  });
}

function relationshipPath(value: Collection['parent']): string | null {
  return typeof value === 'object' && value !== null ? value.path ?? null : null;
}

function imageRecord(value: Card['image']): CardImage | null {
  return typeof value === 'object' && value !== null ? value : null;
}

function toExistingCard(doc: Card): ExistingCard {
  const collections = doc.collections ?? [];
  const image = imageRecord(doc.image);
  return {
    id: doc.id,
    pilotImportKey: doc.pilotImportKey ?? null,
    updatedAt: doc.updatedAt,
    alt: doc.alt ?? null,
    caption: doc.caption ?? null,
    collectionPaths: collections.flatMap((value) => {
      const path = typeof value === 'object' && value !== null ? value.path ?? null : null;
      return path === null ? [] : [path];
    }),
    description: doc.description ?? null,
    h1: doc.h1 ?? null,
    imageAssignedFilename: image?.filename ?? null,
    imageId: image?.id ?? (doc.image as number | null),
    imagePilotImportKey: image?.pilotImportKey ?? null,
    imageHeight: image?.source?.height ?? null,
    imageMimeType: image?.mimeType ?? null,
    imageRevision: image?.revision ?? null,
    imageWidth: image?.source?.width ?? null,
    metaDescription: doc.metaDescription ?? null,
    pathClaimKey: doc.pathClaimKey ?? null,
    robots: doc.robots,
    slug: doc.slug,
    status: doc.status,
    title: doc.title,
    usageTerms: doc.usageTerms ?? null,
    visualDuplicateMatches: (doc.visualDuplicate?.similar ?? []).flatMap((match) => {
      const id = typeof match.card === 'object' && match.card !== null ? match.card.id : match.card;
      return id === null || id === undefined || match.distance === null || match.distance === undefined
        ? []
        : [{ id, distance: match.distance }];
    }),
  };
}

function toExistingImage(doc: CardImage) {
  return {
    id: doc.id,
    pilotImportKey: doc.pilotImportKey ?? null,
    revision: doc.revision ?? null,
    mimeType: doc.mimeType ?? null,
    width: doc.source?.width ?? null,
    height: doc.source?.height ?? null,
  };
}

function toExistingCollection(doc: Collection): ExistingCollection {
  return {
    id: doc.id,
    updatedAt: doc.updatedAt,
    description: doc.description ?? null,
    h1: doc.h1 ?? null,
    intro: doc.intro ?? null,
    metaDescription: doc.metaDescription ?? null,
    nodeKind: doc.nodeKind,
    parentPath: relationshipPath(doc.parent),
    path: doc.path ?? '',
    pathClaimKey: doc.pathClaimKey ?? null,
    robots: doc.robots,
    slug: doc.slug,
    status: doc.status,
    title: doc.title,
  };
}

export function createPayloadPilotImportStore(payload: Payload, actor: User): PilotImportStore {
  const user = actor;
  return {
    findActor(email) {
      return Promise.resolve(email === actor.email
        ? { id: actor.id, email: actor.email, role: actor.role }
        : null);
    },
    async findCardByPilotImportKey(key) {
      const result = await payload.find({
        collection: 'cards', depth: 1, limit: 1, overrideAccess: false,
        pagination: false, showHiddenFields: true, user, where: { pilotImportKey: { equals: key } },
      });
      const doc = result.docs[0];
      return doc === undefined ? null : toExistingCard(doc);
    },
    async findCardBySlug(slug) {
      const result = await payload.find({
        collection: 'cards',
        depth: 1,
        limit: 1,
        overrideAccess: false,
        pagination: false,
        showHiddenFields: true,
        user,
        where: { slug: { equals: slug } },
      });
      const doc = result.docs[0];
      return doc === undefined ? null : toExistingCard(doc);
    },
    async findImageByPilotImportKey(key) {
      const result = await payload.find({
        collection: 'card-images', depth: 0, limit: 1, overrideAccess: false,
        pagination: false, showHiddenFields: true, user, where: { pilotImportKey: { equals: key } },
      });
      const doc = result.docs[0];
      return doc === undefined ? null : toExistingImage(doc);
    },
    async findCollectionByPath(path) {
      const result = await payload.find({
        collection: 'collections',
        depth: 1,
        limit: 1,
        overrideAccess: false,
        pagination: false,
        user,
        where: { path: { equals: path } },
      });
      const doc = result.docs[0];
      return doc === undefined ? null : toExistingCollection(doc);
    },
    async findContentPathClaimByPath(path) {
      const result = await payload.find({
        collection: 'content-path-claims',
        depth: 0,
        limit: 1,
        overrideAccess: true,
        pagination: false,
        where: { path: { equals: path } },
      });
      const claim = result.docs[0];
      if (claim === undefined) return null;
      return {
        ownerCollection: claim.ownerCollection,
        ownerKey: claim.ownerKey,
        path: claim.path,
      } satisfies ExistingContentPathClaim;
    },
  };
}

function payloadRelationId(id: number | string): number {
  if (typeof id !== 'number') {
    throw new Error(`Configured Payload database requires numeric relation ids; received ${String(id)}.`);
  }
  return id;
}

type ReviewCollection = 'cards' | 'collections';

function reviewManagedSnapshot(doc: ExistingCard | ExistingCollection): Readonly<Record<string, unknown>> {
  if ('collectionPaths' in doc) {
    return {
      updatedAt: doc.updatedAt ?? '',
      pilotImportKey: doc.pilotImportKey ?? null,
      slug: doc.slug,
      pathClaimKey: doc.pathClaimKey,
      title: doc.title,
      h1: doc.h1,
      metaDescription: doc.metaDescription,
      alt: doc.alt,
      caption: doc.caption,
      description: doc.description,
      usageTerms: doc.usageTerms,
      status: doc.status,
      robots: doc.robots,
      collectionPaths: [...doc.collectionPaths],
      imageId: doc.imageId ?? null,
      imagePilotImportKey: doc.imagePilotImportKey ?? null,
      imageRevision: doc.imageRevision,
      imageMimeType: doc.imageMimeType,
      imageWidth: doc.imageWidth,
      imageHeight: doc.imageHeight,
    };
  }
  return {
    updatedAt: doc.updatedAt ?? '',
    path: doc.path,
    pathClaimKey: doc.pathClaimKey,
    slug: doc.slug,
    nodeKind: doc.nodeKind,
    parentPath: doc.parentPath,
    title: doc.title,
    h1: doc.h1,
    metaDescription: doc.metaDescription,
    intro: doc.intro,
    description: doc.description,
    status: doc.status,
    robots: doc.robots,
  };
}

function postgresReviewAdapter(payload: Payload): PostgresAdapter {
  if (payload.db.name !== 'postgres') {
    throw new Error('Pilot review promotion requires the configured PostgreSQL adapter.');
  }
  return payload.db as unknown as PostgresAdapter;
}

async function lockReviewRow(
  adapter: PostgresAdapter,
  collection: ReviewCollection,
  id: number | string,
  req: PayloadRequest,
): Promise<void> {
  const transactionID = await req.transactionID;
  if (transactionID === undefined || transactionID === null) {
    throw new Error('Pilot review transaction was not started.');
  }
  const session = adapter.sessions[String(transactionID)];
  const tableName = adapter.tableNameMap.get(collection);
  const table: unknown = tableName === undefined ? undefined : adapter.tables[tableName];
  if (session === undefined || tableName === undefined || typeof table !== 'object' || table === null || !('id' in table)) {
    throw new Error(`Pilot review cannot lock ${collection} row in the active Payload transaction.`);
  }
  const database = session.db as { execute(query: unknown): Promise<unknown> };
  await database.execute(sql`select ${table.id} from ${table} where ${table.id} = ${id} for update`);
}

async function promotePayloadDocumentWithRowLock<T extends ExistingCard | ExistingCollection>(input: {
  readonly actor: User;
  readonly collection: ReviewCollection;
  readonly expected: T;
  readonly payload: Payload;
  readonly toExisting: (doc: Card | Collection) => T;
}): Promise<T | null> {
  const adapter = postgresReviewAdapter(input.payload);
  // The Local API enriches this same object on the locked read/update. Starting
  // the transaction first ensures both operations inherit one adapter session.
  const req = { context: {}, payload: input.payload, user: input.actor } as PayloadRequest;
  const started = await initTransaction(req);
  if (!started) throw new Error('Pilot review transaction could not be started.');
  try {
    await lockReviewRow(adapter, input.collection, input.expected.id, req);
    const locked = await input.payload.findByID({
      collection: input.collection,
      depth: 1,
      id: input.expected.id,
      overrideAccess: false,
      req,
      showHiddenFields: true,
      user: input.actor,
    });
    const current = input.toExisting(locked);
    if (!isDeepStrictEqual(reviewManagedSnapshot(current), reviewManagedSnapshot(input.expected))) {
      await commitTransaction(req);
      return null;
    }
    const updated = await input.payload.update({
      collection: input.collection,
      data: { status: 'review' },
      depth: 1,
      id: input.expected.id,
      overrideAccess: false,
      req,
      showHiddenFields: true,
      user: input.actor,
    });
    await commitTransaction(req);
    return input.toExisting(updated);
  } catch (error) {
    await killTransaction(req);
    throw error;
  }
}

export function createPayloadPilotApplyStore(payload: Payload, actor: User): PilotApplyStore {
  const user = actor;
  return {
    findActor(email) {
      return Promise.resolve(email === actor.email
        ? { id: actor.id, email: actor.email, role: actor.role }
        : null);
    },
    async findCardByPilotImportKey(key) {
      const result = await payload.find({
        collection: 'cards', depth: 1, limit: 1, overrideAccess: false,
        pagination: false, showHiddenFields: true, user, where: { pilotImportKey: { equals: key } },
      });
      const doc = result.docs[0];
      return doc === undefined ? null : toExistingCard(doc);
    },
    async findImageByPilotImportKey(key) {
      const result = await payload.find({
        collection: 'card-images', depth: 0, limit: 1, overrideAccess: false,
        pagination: false, showHiddenFields: true, user, where: { pilotImportKey: { equals: key } },
      });
      const doc = result.docs[0];
      return doc === undefined ? null : toExistingImage(doc);
    },
    async findCardBySlug(slug) {
      const result = await payload.find({
        collection: 'cards',
        depth: 1,
        limit: 1,
        overrideAccess: false,
        pagination: false,
        showHiddenFields: true,
        user,
        where: { slug: { equals: slug } },
      });
      const doc = result.docs[0];
      return doc === undefined ? null : toExistingCard(doc);
    },
    async findCollectionByPath(path) {
      const result = await payload.find({
        collection: 'collections',
        depth: 1,
        limit: 1,
        overrideAccess: false,
        pagination: false,
        user,
        where: { path: { equals: path } },
      });
      const doc = result.docs[0];
      return doc === undefined ? null : toExistingCollection(doc);
    },
    async findContentPathClaimByPath(path) {
      const result = await payload.find({
        collection: 'content-path-claims',
        depth: 0,
        limit: 1,
        // Internal claims are unreadable to ai-editor. This isolated read-only
        // lookup is trusted; all content/image reads remain access-checked.
        overrideAccess: true,
        pagination: false,
        where: { path: { equals: path } },
      });
      const claim = result.docs[0];
      return claim === undefined ? null : {
        ownerCollection: claim.ownerCollection,
        ownerKey: claim.ownerKey,
        path: claim.path,
      };
    },
    async createCollection(seed, parentId) {
      const doc = await payload.create({
        collection: 'collections',
        data: {
          description: seed.description,
          h1: seed.h1,
          intro: pilotIntroDocument(seed.intro) as NonNullable<Collection['intro']>,
          metaDescription: seed.metaDescription,
          nodeKind: seed.nodeKind,
          parent: parentId === null ? null : payloadRelationId(parentId),
          robots: 'noindex,follow',
          slug: seed.slug,
          status: 'draft',
          title: seed.title,
        },
        overrideAccess: false,
        showHiddenFields: true,
        user,
      });
      return toExistingCollection(doc);
    },
    async createImage(seed, bytes) {
      const doc = await payload.create({
        collection: 'card-images',
        data: { title: seed.alt },
        file: {
          data: bytes,
          mimetype: 'image/jpeg',
          name: seed.sourceFile,
          size: bytes.byteLength,
        },
        overrideAccess: false,
        showHiddenFields: true,
        user,
        context: trustedPilotImportContext(pilotImageImportKey(seed.pilotId), actor.id),
      });
      return toExistingImage(doc);
    },
    async createCard(seed, imageId, collectionId) {
      const doc = await payload.create({
        collection: 'cards',
        depth: 1,
        data: {
          alt: seed.alt,
          caption: seed.caption,
          collections: [payloadRelationId(collectionId)],
          description: seed.description,
          h1: seed.h1,
          image: payloadRelationId(imageId),
          metaDescription: seed.metaDescription,
          robots: 'noindex,follow',
          slug: seed.slug,
          status: 'draft',
          title: seed.title,
          usageTerms: seed.usageTerms,
        },
        overrideAccess: false,
        showHiddenFields: true,
        user,
        context: trustedPilotImportContext(pilotCardImportKey(seed.pilotId), actor.id),
      });
      return toExistingCard(doc);
    },
    moveCollectionToReview(expected) {
      return promotePayloadDocumentWithRowLock({
        actor,
        collection: 'collections',
        expected,
        payload,
        toExisting: (doc) => toExistingCollection(doc as Collection),
      });
    },
    moveCardToReview(expected) {
      return promotePayloadDocumentWithRowLock({
        actor,
        collection: 'cards',
        expected,
        payload,
        toExisting: (doc) => toExistingCard(doc as Card),
      });
    },
    async verifyImported(expected: PilotVerificationExpected) {
      const [cards, collections, images] = await Promise.all([
        payload.find({
              collection: 'cards',
              depth: 1,
              overrideAccess: false,
              pagination: false,
              showHiddenFields: true,
              user,
              where: { pilotImportKey: { in: expected.cards.map((item) => item.key) } },
            }).then((result) => result.docs),
        payload.find({
              collection: 'collections',
              depth: 0,
              overrideAccess: false,
              pagination: false,
              user,
              where: { path: { in: expected.collections.map((item) => item.path) } },
            }).then((result) => result.docs),
        payload.find({
          collection: 'card-images', depth: 0, overrideAccess: false,
          pagination: false, showHiddenFields: true, user,
          where: { pilotImportKey: { in: expected.images.map((item) => item.key) } },
        }).then((result) => result.docs),
      ]);
      return {
        cards: cards.map((doc) => {
          const image = imageRecord(doc.image);
          return {
            id: doc.id,
            key: doc.pilotImportKey ?? null,
            robots: doc.robots,
            status: doc.status,
            image: image === null ? null : {
              id: image.id,
              key: image.pilotImportKey ?? null,
              revision: image.revision ?? null,
            },
          };
        }),
        collections: collections.map((doc) => ({
          id: doc.id, path: doc.path ?? '', robots: doc.robots, status: doc.status,
        })),
        images: images.map((doc) => ({
          id: doc.id, key: doc.pilotImportKey ?? null, revision: doc.revision ?? null,
        })),
      };
    },
  };
}

async function findPilotActorDocument(payload: Payload, email: string): Promise<User> {
  const result = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    where: { email: { equals: email } },
  });
  const actor = result.docs[0];
  if (actor === undefined || actor.role !== 'ai-editor') {
    throw new Error('CONTENT_IMPORT_AI_EDITOR_EMAIL must identify an existing ai-editor.');
  }
  return actor;
}

function compactReport(report: PilotPreflightReport): string {
  return JSON.stringify({
    mode: report.mode,
    collectionNodes: report.collectionNodes,
    leafTopics: report.leafTopics,
    cards: report.cards,
    validFiles: report.validFiles,
    resumed: report.resumed,
    mutationCount: report.mutationCount,
    blockingErrors: report.blockingErrors,
  });
}

function compactApplyReport(report: PilotImportReport): string {
  return JSON.stringify({ mode: report.mode, counts: report.counts });
}

async function main(): Promise<void> {
  loadEnvFiles();
  const workspaceRoot = resolvePilotWorkspaceRoot();
  const initialized = await initializePilotImport(
    process.argv.slice(2),
    process.env,
    workspaceRoot,
    {
      initializeApply: initializePilotPayloadApply,
      initializeDryRun: initializePilotPayloadDryRun,
    },
  );
  const [matrix, manifest] = await Promise.all([
    loadSiteContent(resolve(workspaceRoot, 'content/pilot-2026-08/site-content.json')),
    loadManifest(resolve(workspaceRoot, 'content/pilot-2026-08/manifest.json')),
  ]);
  // Actor bootstrap is the only trusted user lookup. From this point onward
  // content and image reads/writes use this actor with overrideAccess:false.
  const actor = await findPilotActorDocument(
    initialized.payload,
    initialized.environment.actorEmail,
  );
  const store = createPayloadPilotApplyStore(initialized.payload, actor);
  const report = await runPilotPreflight({
    actorEmail: initialized.environment.actorEmail,
    assetRoot: initialized.environment.assetRoot,
    manifest,
    matrix,
    store,
  });
  console.log(compactReport(report));
  if (report.blockingErrors.length > 0) {
    throw new Error(`Pilot preflight blocked by ${String(report.blockingErrors.length)} error(s).`);
  }
  if (initialized.mode === 'dry-run') return;

  const applied = await applyPilotContent({
    actor,
    actorEmail: initialized.environment.actorEmail,
    assetRoot: initialized.environment.assetRoot,
    manifest,
    matrix,
    preflight: report,
    reportPath: resolve(workspaceRoot, 'content/pilot-2026-08/import-report.json'),
    store,
  });
  console.log(compactApplyReport(applied));
}

if (process.env.VITEST !== 'true') {
  await main();
}
