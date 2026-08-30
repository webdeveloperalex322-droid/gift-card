/**
 * One-off pilot importer. Task 6 exposes dry-run only; Task 7 adds apply.
 *
 * `payload run` imports this module directly. All argument and environment
 * checks happen before Payload/config import, and dry-run disables schema push
 * plus onInit seeding so initialization is read-only too.
 */
import { resolve } from 'node:path';

import type { Payload } from 'payload';

import { loadManifest } from '../../../scripts/content-pilot/manifest.mjs';
import { loadSiteContent } from '../../../scripts/content-import/schema.js';
import {
  runPilotPreflight,
  type ExistingCard,
  type ExistingCollection,
  type ExistingContentPathClaim,
  type PilotImportStore,
  type PilotPreflightReport,
} from '../src/import/pilot-preflight';
import { loadEnvFiles, workspaceRoot } from '../src/env.mjs';
import type { Card, CardImage, Collection } from '../src/payload-types';

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
    throw new Error('PAYLOAD_DROP_DATABASE must not be enabled for pilot dry-run.');
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
    alt: doc.alt ?? null,
    caption: doc.caption ?? null,
    collectionPaths: collections.flatMap((value) => {
      const path = typeof value === 'object' && value !== null ? value.path ?? null : null;
      return path === null ? [] : [path];
    }),
    description: doc.description ?? null,
    h1: doc.h1 ?? null,
    imageAssignedFilename: image?.filename ?? null,
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
  };
}

function toExistingCollection(doc: Collection): ExistingCollection {
  return {
    id: doc.id,
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

export function createPayloadPilotImportStore(payload: Payload): PilotImportStore {
  return {
    async findActor(email) {
      const result = await payload.find({
        collection: 'users',
        depth: 0,
        limit: 1,
        overrideAccess: true,
        pagination: false,
        where: { email: { equals: email } },
      });
      const actor = result.docs[0];
      return actor === undefined ? null : { id: actor.id, role: actor.role };
    },
    async findCardBySlug(slug) {
      const result = await payload.find({
        collection: 'cards',
        depth: 1,
        limit: 1,
        overrideAccess: true,
        pagination: false,
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
        overrideAccess: true,
        pagination: false,
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

async function main(): Promise<void> {
  loadEnvFiles();
  const workspaceRoot = resolvePilotWorkspaceRoot();
  const initialized = await initializePilotDryRun(
    process.argv.slice(2),
    process.env,
    workspaceRoot,
    initializePilotPayloadDryRun,
  );
  const [matrix, manifest] = await Promise.all([
    loadSiteContent(resolve(workspaceRoot, 'content/pilot-2026-08/site-content.json')),
    loadManifest(resolve(workspaceRoot, 'content/pilot-2026-08/manifest.json')),
  ]);
  const report = await runPilotPreflight({
    actorEmail: initialized.environment.actorEmail,
    assetRoot: initialized.environment.assetRoot,
    manifest,
    matrix,
    store: createPayloadPilotImportStore(initialized.payload),
  });
  console.log(compactReport(report));
  if (report.blockingErrors.length > 0) {
    throw new Error(`Pilot preflight blocked by ${String(report.blockingErrors.length)} error(s).`);
  }
}

if (process.env.VITEST !== 'true') {
  await main();
}
