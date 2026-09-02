import { readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { PostgresAdapter } from '@payloadcms/db-postgres';
import { sql } from '@payloadcms/db-postgres';
import { commitTransaction, initTransaction, killTransaction, type Payload, type PayloadRequest, type Where } from 'payload';

import { applyGeneratedLibrary, type GeneratedLibraryApplyStore } from '../src/import/library-apply';
import { approveGeneratedLibraryDryRun, assertGeneratedLibraryDryRunApproved } from '../src/import/library-approval';
import {
  GENERATED_LIBRARY_PACKAGES,
  planGeneratedLibrary,
  type GeneratedLibraryPackageName,
  type GeneratedManifestPackage,
  type GeneratedManifestRowInput,
} from '../src/import/library-manifest';
import {
  type GeneratedLibraryActor,
  type GeneratedLibraryExistingCard,
  type GeneratedLibraryExistingCollection,
  type GeneratedLibraryExistingImage,
  runGeneratedLibraryPreflight,
} from '../src/import/library-preflight';
import { buildGeneratedLibrarySeeds, type GeneratedCardSeed, type GeneratedCollectionSeed } from '../src/import/library-seeds';
import { pilotIntroDocument } from '../src/import/pilot-types';
import { trustedSourceImportContext, sourceCardImportKey, sourceCollectionImportKey, sourceImageImportKey } from '../src/import/source-import-identity';
import { loadEnvFiles, workspaceRoot } from '../src/env.mjs';
import type { Card, CardImage, Collection, User } from '../src/payload-types';
import { imageStorage } from '../src/images/storage-env';

export type GeneratedLibraryMode = 'apply' | 'dry-run';

export interface GeneratedLibraryEnvironment {
  readonly actorEmail: string;
  readonly assetRoot: string;
}

export function parseGeneratedLibraryCli(args: readonly string[]): GeneratedLibraryMode {
  if (args.length === 0) throw new Error('Generated library import requires an explicit mode: --dry-run or --apply.');
  if (args.length !== 1 || (args[0] !== '--dry-run' && args[0] !== '--apply')) {
    throw new Error('Choose exactly one generated library import mode: --dry-run or --apply.');
  }
  return args[0] === '--apply' ? 'apply' : 'dry-run';
}

export function requireGeneratedLibraryEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): GeneratedLibraryEnvironment {
  const configuredRoot = env.GENERATED_LIBRARY_ROOT?.trim() ?? '';
  if (configuredRoot === '') throw new Error('GENERATED_LIBRARY_ROOT must point to the four generation packages.');
  const actorEmail = env.AI_EDITOR_EMAIL?.trim() ?? '';
  if (actorEmail === '') throw new Error('AI_EDITOR_EMAIL must identify an existing ai-editor.');
  return { assetRoot: resolve(cwd, configuredRoot), actorEmail };
}

export function assertGeneratedLibraryActor(actor: GeneratedLibraryActor): void {
  if (actor.role !== 'ai-editor') throw new Error(`Import actor must have role ai-editor; received ${actor.role}.`);
}

function relationshipId(value: unknown): number | string | null {
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'id' in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === 'number' || typeof id === 'string' ? id : null;
  }
  return null;
}

function firstCollectionPath(card: Card): string | null {
  const first = card.collections?.[0];
  return typeof first === 'object' && first !== null ? first.path ?? null : null;
}

function relationshipPath(value: unknown): string | null {
  return typeof value === 'object' && value !== null && 'path' in value && typeof value.path === 'string'
    ? value.path
    : null;
}

function toCard(doc: Card): GeneratedLibraryExistingCard {
  const value = doc as Card & { sourceImportKey?: string | null };
  return {
    id: doc.id,
    sourceImportKey: value.sourceImportKey ?? null,
    slug: doc.slug,
    title: doc.title,
    h1: doc.h1 ?? null,
    metaDescription: doc.metaDescription ?? null,
    alt: doc.alt ?? null,
    caption: doc.caption ?? null,
    description: doc.description ?? null,
    usageTerms: doc.usageTerms ?? null,
    status: doc.status,
    robots: doc.robots,
    imageId: relationshipId(doc.image),
    collectionPath: firstCollectionPath(doc),
    pathClaimKey: doc.pathClaimKey ?? null,
    updatedAt: doc.updatedAt,
  };
}

function toImage(doc: CardImage): GeneratedLibraryExistingImage {
  const value = doc as CardImage & { sourceImportKey?: string | null };
  return {
    id: doc.id, sourceImportKey: value.sourceImportKey ?? null, revision: doc.revision ?? null,
    keyBase: doc.keyBase ?? null, originalKey: doc.originalKey ?? null,
    variants: doc.variants?.map(({ key }) => ({ key })) ?? [],
  };
}

function toCollection(doc: Collection): GeneratedLibraryExistingCollection {
  const value = doc as Collection & { sourceImportKey?: string | null };
  return {
    id: doc.id, sourceImportKey: value.sourceImportKey ?? null, path: doc.path ?? '',
    pathClaimKey: doc.pathClaimKey ?? null, updatedAt: doc.updatedAt, slug: doc.slug,
    nodeKind: doc.nodeKind, parentPath: relationshipPath(doc.parent),
    relatedPaths: doc.related?.flatMap((item) => {
      const path = relationshipPath(item);
      return path === null ? [] : [path];
    }) ?? [],
    title: doc.title, h1: doc.h1 ?? null, metaDescription: doc.metaDescription ?? null,
    intro: doc.intro ?? null, description: doc.description ?? null, status: doc.status, robots: doc.robots,
  };
}

function numericId(id: number | string): number {
  if (typeof id !== 'number') throw new Error(`PostgreSQL relationships require numeric ids; received ${String(id)}.`);
  return id;
}

type GeneratedReviewCollection = 'cards' | 'collections';

function generatedPostgresAdapter(payload: Payload): PostgresAdapter {
  if (payload.db.name !== 'postgres') throw new Error('Generated-library review promotion requires PostgreSQL.');
  return payload.db as unknown as PostgresAdapter;
}

async function lockGeneratedReviewRow(adapter: PostgresAdapter, collection: GeneratedReviewCollection,
  id: number | string, req: PayloadRequest): Promise<void> {
  const transactionID = await req.transactionID;
  if (transactionID === undefined || transactionID === null) throw new Error('Generated-library review transaction was not started.');
  const session = adapter.sessions[String(transactionID)];
  const tableName = adapter.tableNameMap.get(collection);
  const table: unknown = tableName === undefined ? undefined : adapter.tables[tableName];
  if (session === undefined || tableName === undefined || typeof table !== 'object' || table === null || !('id' in table)) {
    throw new Error(`Generated-library review cannot lock ${collection} row.`);
  }
  const database = session.db as { execute(query: unknown): Promise<unknown> };
  await database.execute(sql`select ${table.id} from ${table} where ${table.id} = ${id} for update`);
}

export async function setGeneratedStatusWithRowLock<T extends GeneratedLibraryExistingCard | GeneratedLibraryExistingCollection>(input: {
  readonly actor: User; readonly collection: GeneratedReviewCollection; readonly expected: T; readonly payload: Payload;
  readonly toExisting: (doc: Card | Collection) => T;
}): Promise<T | null> {
  const adapter = generatedPostgresAdapter(input.payload);
  const req = { context: {}, payload: input.payload, user: input.actor } as PayloadRequest;
  const started = await initTransaction(req);
  if (!started) throw new Error('Generated-library review transaction could not be started.');
  try {
    await lockGeneratedReviewRow(adapter, input.collection, input.expected.id, req);
    const locked = await input.payload.findByID({ collection: input.collection, depth: 1, id: input.expected.id,
      overrideAccess: false, req, showHiddenFields: true, user: input.actor });
    const current = input.toExisting(locked);
    if (!isDeepStrictEqual(current, input.expected)) {
      await commitTransaction(req);
      return null;
    }
    const updated = await input.payload.update({ collection: input.collection, data: { status: 'review' }, depth: 1,
      id: input.expected.id, overrideAccess: false, req, showHiddenFields: true, user: input.actor });
    await commitTransaction(req);
    return input.toExisting(updated);
  } catch (error) {
    await killTransaction(req);
    throw error;
  }
}

export function createPayloadGeneratedLibraryStore(payload: Payload, actorEmail: string): GeneratedLibraryApplyStore {
  let actor: User | null = null;
  const loadActor = async (): Promise<User> => {
    const fresh = await findActor(payload, actorEmail);
    if (fresh === null) throw new Error(`Import actor ${actorEmail} does not exist.`);
    actor = fresh;
    assertGeneratedLibraryActor({ id: fresh.id, email: fresh.email, role: fresh.role });
    return fresh;
  };
  const findOne = async <T extends 'cards' | 'card-images' | 'collections'>(collection: T, where: Where, depth: number) => {
    if (actor === null) throw new Error('Import actor must be refreshed before content reads.');
    const result = await payload.find({
      collection, where, depth, limit: 1, pagination: false, overrideAccess: false,
      showHiddenFields: true, user: actor,
    });
    return result.docs[0];
  };
  return {
    async isSchemaReady() {
      try {
        for (const collection of ['cards', 'card-images', 'collections'] as const) {
          await payload.find({ collection, depth: 0, limit: 1, pagination: false, overrideAccess: true,
            where: { sourceImportKey: { exists: true } } });
        }
        return true;
      } catch { return false; }
    },
    async findActor(email) {
      if (email !== actorEmail) return null;
      const fresh = await findActor(payload, actorEmail);
      if (fresh === null) return null;
      actor = fresh;
      return { id: fresh.id, email: fresh.email, role: fresh.role };
    },
    findPilotCardByKey: async (key) => {
      const doc = await findOne('cards', { pilotImportKey: { equals: key } }, 1);
      return doc === undefined ? null : { id: doc.id, imageId: relationshipId(doc.image) };
    },
    findPilotImageByKey: async (key) => {
      const doc = await findOne('card-images', { pilotImportKey: { equals: key } }, 0);
      return doc === undefined ? null : toImage(doc);
    },
    findCollectionByPath: async (path) => {
      const doc = await findOne('collections', { path: { equals: path } }, 1);
      return doc === undefined ? null : toCollection(doc);
    },
    findCollectionBySourceKey: async (key) => {
      const doc = await findOne('collections', { sourceImportKey: { equals: key } }, 1);
      return doc === undefined ? null : toCollection(doc);
    },
    findCardBySourceKey: async (key) => {
      const doc = await findOne('cards', { sourceImportKey: { equals: key } }, 1);
      return doc === undefined ? null : toCard(doc);
    },
    findImageBySourceKey: async (key) => {
      const doc = await findOne('card-images', { sourceImportKey: { equals: key } }, 0);
      return doc === undefined ? null : toImage(doc);
    },
    findCardBySlug: async (slug) => {
      const doc = await findOne('cards', { slug: { equals: slug } }, 1);
      return doc === undefined ? null : toCard(doc);
    },
    async findContentPathClaimByPath(path) {
      const result = await payload.find({ collection: 'content-path-claims', depth: 0, limit: 1,
        pagination: false, overrideAccess: true, where: { path: { equals: path } } });
      const claim = result.docs[0];
      return claim === undefined ? null : {
        path: claim.path, ownerCollection: claim.ownerCollection, ownerKey: claim.ownerKey,
      };
    },
    hasOriginal: (key) => imageStorage().hasOriginal(key),
    hasDerivative: (key) => imageStorage().hasDerivative(key),
    async createCollection(seed: GeneratedCollectionSeed, parentId) {
      const user = await loadActor();
      const doc = await payload.create({
        collection: 'collections',
        data: {
          title: seed.title, h1: seed.h1, slug: seed.slug, nodeKind: seed.nodeKind,
          parent: numericId(parentId), description: seed.description,
          intro: pilotIntroDocument(seed.intro) as NonNullable<Collection['intro']>,
          metaDescription: seed.metaDescription, status: 'draft', robots: 'noindex,follow',
        },
        overrideAccess: false, showHiddenFields: true, user,
        context: trustedSourceImportContext(sourceCollectionImportKey(seed.key), user.id),
      });
      return toCollection(doc);
    },
    async setCollectionRelated(collection, relatedIds) {
      const user = await loadActor();
      const doc = await payload.update({
        collection: 'collections', id: numericId(collection.id), depth: 1,
        data: { related: relatedIds.map(numericId) },
        overrideAccess: false, showHiddenFields: true, user,
      });
      return toCollection(doc);
    },
    async createImage(seed: GeneratedCardSeed, bytes) {
      const user = await loadActor();
      const doc = await payload.create({
        collection: 'card-images', data: { title: seed.alt },
        file: { data: bytes, mimetype: 'image/jpeg', name: basename(seed.sourceFile), size: bytes.byteLength },
        overrideAccess: false, showHiddenFields: true, user,
        context: trustedSourceImportContext(sourceImageImportKey(seed.sourceSha256), user.id),
      });
      return toImage(doc);
    },
    async createCard(seed: GeneratedCardSeed, imageId, collectionId) {
      const user = await loadActor();
      const doc = await payload.create({
        collection: 'cards', depth: 1,
        data: {
          title: seed.title, h1: seed.h1, slug: seed.slug, image: numericId(imageId), alt: seed.alt,
          caption: seed.caption, description: seed.description, metaDescription: seed.metaDescription,
          usageTerms: seed.usageTerms, collections: [numericId(collectionId)], status: 'draft', robots: 'noindex,follow',
        },
        overrideAccess: false, showHiddenFields: true, user,
        context: trustedSourceImportContext(sourceCardImportKey(seed.sourceSha256), user.id),
      });
      return toCard(doc);
    },
    async moveCollectionToReview(collection) {
      const user = await loadActor();
      return setGeneratedStatusWithRowLock({
        actor: user, collection: 'collections', expected: collection, payload,
        toExisting: (doc) => toCollection(doc as Collection),
      });
    },
    async moveCardToReview(card) {
      const user = await loadActor();
      return setGeneratedStatusWithRowLock({
        actor: user, collection: 'cards', expected: card, payload,
        toExisting: (doc) => toCard(doc as Card),
      });
    },
  };
}

export async function resolveGeneratedLibraryAssetPath(
  assetRoot: string,
  packageName: GeneratedLibraryPackageName,
  raw: string,
  realpathFn: (path: string) => Promise<string> = realpath,
): Promise<string> {
  if (isAbsolute(raw)) throw new Error(`Manifest asset path must be relative: ${raw}.`);
  const slash = raw.replaceAll('\\', '/');
  const prefixes = [`.local/${packageName}/`, `content/${packageName}/`, `${packageName}/`];
  const suffix = prefixes.reduce<string | null>((found, prefix) => found ?? (slash.startsWith(prefix) ? slash.slice(prefix.length) : null), null);
  if (suffix === null || suffix === '' || suffix.startsWith('../')) throw new Error(`Manifest asset path escapes package ${packageName}: ${raw}.`);
  const root = await realpathFn(assetRoot);
  const packageRoot = await realpathFn(resolve(root, packageName));
  const packageChild = relative(root, packageRoot);
  if (packageChild.startsWith('..') || isAbsolute(packageChild)) throw new Error(`Generation package escapes asset root: ${packageName}.`);
  const absolute = await realpathFn(resolve(packageRoot, suffix));
  const child = relative(packageRoot, absolute);
  if (child.startsWith('..') || isAbsolute(child)) throw new Error(`Manifest asset path escapes package ${packageName}: ${raw}.`);
  return absolute;
}

async function loadPackage(assetRoot: string, name: GeneratedLibraryPackageName): Promise<GeneratedManifestPackage> {
  const manifestPath = await resolveGeneratedLibraryAssetPath(assetRoot, name, `${name}/manifest.json`);
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  const cards = typeof parsed === 'object' && parsed !== null && 'cards' in parsed ? parsed.cards : null;
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(cards)
      ? cards
      : null;
  if (rows === null) throw new Error(`Manifest ${name}/manifest.json must contain an array or cards array.`);
  const normalized: GeneratedManifestRowInput[] = [];
  for (const [index, value] of rows.entries()) {
    if (typeof value !== 'object' || value === null) throw new Error(`Manifest ${name} row ${String(index + 1)} must be an object.`);
    const row = value as Partial<GeneratedManifestRowInput>;
    const required = ['id', 'theme', 'backgroundPath', 'finalPath', 'headline', 'wish', 'alt'] as const;
    for (const field of required) if (typeof row[field] !== 'string' || row[field].trim() === '') throw new Error(`Manifest ${name} row ${String(index + 1)} has invalid ${field}.`);
    normalized.push({
      ...row,
      id: row.id!, theme: row.theme!, headline: row.headline!, wish: row.wish!, alt: row.alt!,
      backgroundPath: await resolveGeneratedLibraryAssetPath(assetRoot, name, row.backgroundPath!),
      finalPath: await resolveGeneratedLibraryAssetPath(assetRoot, name, row.finalPath!),
      ...(typeof row.squarePath === 'string'
        ? { squarePath: await resolveGeneratedLibraryAssetPath(assetRoot, name, row.squarePath) }
        : {}),
    } satisfies GeneratedManifestRowInput);
  }
  return { name, rows: normalized };
}

async function findActor(payload: Payload, email: string): Promise<User | null> {
  const result = await payload.find({ collection: 'users', depth: 0, limit: 1, pagination: false, overrideAccess: true, where: { email: { equals: email } } });
  const actor = result.docs[0];
  return actor ?? null;
}

async function initializePayload(): Promise<Payload> {
  process.env.PAYLOAD_DB_PUSH = 'false';
  process.env.PAYLOAD_DB_DISABLE_CREATE = 'true';
  const [{ getPayload }, { default: config }] = await Promise.all([import('payload'), import('../src/payload.config')]);
  return getPayload({ config, disableOnInit: true, key: 'generated-library-import' });
}

async function writeReport(path: string, value: unknown): Promise<void> {
  const temporary = resolve(dirname(path), `.${basename(path)}.${String(process.pid)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function recordOrphanedImage(assetRoot: string, value: {
  readonly sourceSha256: string;
  readonly image: GeneratedLibraryExistingImage;
  readonly reason: string;
}): Promise<void> {
  const path = resolve(assetRoot, 'generated-library-orphan-cleanup.json');
  let records: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (Array.isArray(parsed)) records = parsed;
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  await writeReport(path, [...records, { ...value, recordedAt: new Date().toISOString() }]);
}

async function main(): Promise<void> {
  loadEnvFiles();
  const mode = parseGeneratedLibraryCli(process.argv.slice(2));
  const environment = requireGeneratedLibraryEnvironment(process.env, workspaceRoot());
  const packages = await Promise.all(GENERATED_LIBRARY_PACKAGES.map((name) => loadPackage(environment.assetRoot, name)));
  const plan = await planGeneratedLibrary({
    packages,
    readBytes: (path) => readFile(path),
    expected: { sourceRows: 1150, uniqueSources: 1021, pilotRows: 50, pilotRepeatedOutside: 49, sovietRepeatedInPopular: 80, creationCandidates: 971 },
  });
  const seeds = buildGeneratedLibrarySeeds(plan);
  const payload = await initializePayload();
  const store = createPayloadGeneratedLibraryStore(payload, environment.actorEmail);
  const preflightInput = { actorEmail: environment.actorEmail, plan, seeds, store, readBytes: (path: string) => readFile(path) };
  const preflight = await runGeneratedLibraryPreflight(preflightInput);
  console.log(JSON.stringify({ ...preflight, preparedCards: preflight.preparedCards.length }));
  if (preflight.blockingErrors.length > 0) throw new Error(`Generated library preflight blocked by ${String(preflight.blockingErrors.length)} error(s).`);
  if (mode === 'dry-run') {
    await approveGeneratedLibraryDryRun(environment.assetRoot, environment.actorEmail, preflight);
    return;
  }
  await assertGeneratedLibraryDryRunApproved(environment.assetRoot, environment.actorEmail, preflight.fingerprint);
  const applied = await applyGeneratedLibrary({
    ...preflightInput, preflight,
    recordOrphanedImage: (value) => recordOrphanedImage(environment.assetRoot, value),
  });
  const report = {
    ...applied,
    duplicateGroups: plan.groups.filter(({ rows }) => rows.length > 1).length,
    representativeAliases: plan.aliases,
  };
  await writeReport(resolve(environment.assetRoot, 'generated-library-import-report.json'), report);
  console.log(JSON.stringify(report));
}

if (process.env.VITEST !== 'true') await main();
