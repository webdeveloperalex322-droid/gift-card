import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Payload, Where } from 'payload';

import { applyGeneratedLibrary, type GeneratedLibraryApplyStore } from '../src/import/library-apply';
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
  };
}

function toImage(doc: CardImage): GeneratedLibraryExistingImage {
  const value = doc as CardImage & { sourceImportKey?: string | null };
  return { id: doc.id, sourceImportKey: value.sourceImportKey ?? null, revision: doc.revision ?? null };
}

function toCollection(doc: Collection): GeneratedLibraryExistingCollection {
  const value = doc as Collection & { sourceImportKey?: string | null };
  return { id: doc.id, sourceImportKey: value.sourceImportKey ?? null, path: doc.path ?? '', status: doc.status, robots: doc.robots };
}

function numericId(id: number | string): number {
  if (typeof id !== 'number') throw new Error(`PostgreSQL relationships require numeric ids; received ${String(id)}.`);
  return id;
}

export function createPayloadGeneratedLibraryStore(payload: Payload, actor: User): GeneratedLibraryApplyStore {
  const findOne = async <T extends 'cards' | 'card-images' | 'collections'>(collection: T, where: Where, depth: number) => {
    const result = await payload.find({
      collection, where, depth, limit: 1, pagination: false, overrideAccess: false,
      showHiddenFields: true, user: actor,
    });
    return result.docs[0];
  };
  return {
    findActor: (email) => Promise.resolve(email === actor.email
      ? { id: actor.id, email: actor.email, role: actor.role }
      : null),
    findPilotCardByKey: async (key) => {
      const doc = await findOne('cards', { pilotImportKey: { equals: key } }, 0);
      return doc === undefined ? null : { id: doc.id };
    },
    findCollectionByPath: async (path) => {
      const doc = await findOne('collections', { path: { equals: path } }, 0);
      return doc === undefined ? null : toCollection(doc);
    },
    findCollectionBySourceKey: async (key) => {
      const doc = await findOne('collections', { sourceImportKey: { equals: key } }, 0);
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
    async createCollection(seed: GeneratedCollectionSeed, parentId) {
      const doc = await payload.create({
        collection: 'collections',
        data: {
          title: seed.title, h1: seed.h1, slug: seed.slug, nodeKind: seed.nodeKind,
          parent: numericId(parentId), description: seed.description,
          intro: pilotIntroDocument(seed.intro) as NonNullable<Collection['intro']>,
          metaDescription: seed.metaDescription, status: 'draft', robots: 'noindex,follow',
        },
        overrideAccess: false, showHiddenFields: true, user: actor,
        context: trustedSourceImportContext(sourceCollectionImportKey(seed.key), actor.id),
      });
      return toCollection(doc);
    },
    async setCollectionRelated(collection, relatedIds) {
      await payload.update({
        collection: 'collections', id: numericId(collection.id),
        data: { related: relatedIds.map(numericId) },
        overrideAccess: false, showHiddenFields: true, user: actor,
      });
    },
    async createImage(seed: GeneratedCardSeed, bytes) {
      const doc = await payload.create({
        collection: 'card-images', data: { title: seed.alt },
        file: { data: bytes, mimetype: 'image/jpeg', name: basename(seed.sourceFile), size: bytes.byteLength },
        overrideAccess: false, showHiddenFields: true, user: actor,
        context: trustedSourceImportContext(sourceImageImportKey(seed.sourceSha256), actor.id),
      });
      return toImage(doc);
    },
    async createCard(seed: GeneratedCardSeed, imageId, collectionId) {
      const doc = await payload.create({
        collection: 'cards', depth: 1,
        data: {
          title: seed.title, h1: seed.h1, slug: seed.slug, image: numericId(imageId), alt: seed.alt,
          caption: seed.caption, description: seed.description, metaDescription: seed.metaDescription,
          usageTerms: seed.usageTerms, collections: [numericId(collectionId)], status: 'draft', robots: 'noindex,follow',
        },
        overrideAccess: false, showHiddenFields: true, user: actor,
        context: trustedSourceImportContext(sourceCardImportKey(seed.sourceSha256), actor.id),
      });
      return toCard(doc);
    },
    async moveCollectionToReview(collection) {
      const doc = await payload.update({
        collection: 'collections', id: numericId(collection.id), data: { status: 'review' },
        overrideAccess: false, showHiddenFields: true, user: actor,
      });
      return toCollection(doc);
    },
    async moveCardToReview(card) {
      const doc = await payload.update({
        collection: 'cards', id: numericId(card.id), depth: 1, data: { status: 'review' },
        overrideAccess: false, showHiddenFields: true, user: actor,
      });
      return toCard(doc);
    },
  };
}

function normalizeAssetPath(assetRoot: string, packageName: GeneratedLibraryPackageName, raw: string): string {
  if (isAbsolute(raw)) throw new Error(`Manifest asset path must be relative: ${raw}.`);
  const slash = raw.replaceAll('\\', '/');
  const prefixes = [`.local/${packageName}/`, `content/${packageName}/`, `${packageName}/`];
  const suffix = prefixes.reduce<string | null>((found, prefix) => found ?? (slash.startsWith(prefix) ? slash.slice(prefix.length) : null), null);
  if (suffix === null || suffix === '' || suffix.startsWith('../')) throw new Error(`Manifest asset path escapes package ${packageName}: ${raw}.`);
  const packageRoot = resolve(assetRoot, packageName);
  const absolute = resolve(packageRoot, suffix);
  const child = relative(packageRoot, absolute);
  if (child.startsWith('..') || isAbsolute(child)) throw new Error(`Manifest asset path escapes package ${packageName}: ${raw}.`);
  return absolute;
}

async function loadPackage(assetRoot: string, name: GeneratedLibraryPackageName): Promise<GeneratedManifestPackage> {
  const parsed: unknown = JSON.parse(await readFile(resolve(assetRoot, name, 'manifest.json'), 'utf8'));
  const cards = typeof parsed === 'object' && parsed !== null && 'cards' in parsed ? parsed.cards : null;
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(cards)
      ? cards
      : null;
  if (rows === null) throw new Error(`Manifest ${name}/manifest.json must contain an array or cards array.`);
  const normalized = rows.map((value, index) => {
    if (typeof value !== 'object' || value === null) throw new Error(`Manifest ${name} row ${String(index + 1)} must be an object.`);
    const row = value as Partial<GeneratedManifestRowInput>;
    const required = ['id', 'theme', 'backgroundPath', 'finalPath', 'headline', 'wish', 'alt'] as const;
    for (const field of required) if (typeof row[field] !== 'string' || row[field].trim() === '') throw new Error(`Manifest ${name} row ${String(index + 1)} has invalid ${field}.`);
    return {
      ...row,
      id: row.id!, theme: row.theme!, headline: row.headline!, wish: row.wish!, alt: row.alt!,
      backgroundPath: normalizeAssetPath(assetRoot, name, row.backgroundPath!),
      finalPath: normalizeAssetPath(assetRoot, name, row.finalPath!),
      ...(typeof row.squarePath === 'string' ? { squarePath: normalizeAssetPath(assetRoot, name, row.squarePath) } : {}),
    } satisfies GeneratedManifestRowInput;
  });
  return { name, rows: normalized };
}

async function findActor(payload: Payload, email: string): Promise<User> {
  const result = await payload.find({ collection: 'users', depth: 0, limit: 1, pagination: false, overrideAccess: true, where: { email: { equals: email } } });
  const actor = result.docs[0];
  if (actor === undefined) throw new Error(`Import actor ${email} does not exist.`);
  assertGeneratedLibraryActor({ id: actor.id, email: actor.email, role: actor.role });
  return actor;
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
  const actor = await findActor(payload, environment.actorEmail);
  const store = createPayloadGeneratedLibraryStore(payload, actor);
  const preflightInput = { actorEmail: actor.email, plan, seeds, store, readBytes: (path: string) => readFile(path) };
  const preflight = await runGeneratedLibraryPreflight(preflightInput);
  console.log(JSON.stringify({ ...preflight, preparedCards: preflight.preparedCards.length }));
  if (preflight.blockingErrors.length > 0) throw new Error(`Generated library preflight blocked by ${String(preflight.blockingErrors.length)} error(s).`);
  if (mode === 'dry-run') return;
  const applied = await applyGeneratedLibrary({ ...preflightInput, preflight });
  const report = {
    ...applied,
    duplicateGroups: plan.groups.filter(({ rows }) => rows.length > 1).length,
    representativeAliases: plan.aliases,
  };
  await writeReport(resolve(environment.assetRoot, 'generated-library-import-report.json'), report);
  console.log(JSON.stringify(report));
}

if (process.env.VITEST !== 'true') await main();
