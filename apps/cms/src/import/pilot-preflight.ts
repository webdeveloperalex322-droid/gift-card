import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import sharp from 'sharp';

import { computeImageRevision } from '@otkritka/images';

import { validateSiteContent } from '../../../../scripts/content-import/schema.js';
import type { CardSeed, CollectionSeed } from '../../../../scripts/content-import/schema.js';
import { buildCardPath, CARD_PATH_PREFIX } from '../seo/paths';
import {
  pilotCardImportKey,
  pilotCollectionImportKey,
  pilotImageImportKey,
} from './pilot-import-identity';
import {
  pilotIntroDocument,
  type ExistingCard,
  type ExistingCollection,
  type ExistingContentPathClaim,
  type PilotImportStore,
  type PilotAssetIdentity,
  type PilotPreparedAsset,
  type PilotPreflightInput,
  type PilotPreflightRecord,
  type PilotPreflightReport,
} from './pilot-types';

export type {
  ExistingCard,
  ExistingCollection,
  ExistingContentPathClaim,
  PilotImportStore,
  PilotPreflightInput,
  PilotPreflightRecord,
  PilotPreflightReport,
} from './pilot-types';

interface CheckedRecord {
  readonly record: PilotPreflightRecord;
  readonly errors: readonly string[];
}

interface AssetCheck {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly identity: PilotAssetIdentity | null;
  readonly bytes: Buffer | null;
}

function valueLabel(value: unknown): string {
  return value === null ? 'null' : JSON.stringify(value);
}

function differingFields(
  expected: Readonly<Record<string, unknown>>,
  actual: Readonly<Record<string, unknown>>,
): string[] {
  return Object.keys(expected).filter((field) => !isDeepStrictEqual(actual[field], expected[field]));
}

const LEXICAL_EMPTY_DEFAULTS: Readonly<Record<string, readonly unknown[]>> = {
  detail: [0],
  direction: [null, 'ltr'],
  format: ['', 0],
  indent: [0],
  mode: ['normal'],
  style: [''],
  textFormat: [0],
  textStyle: [''],
};

/**
 * Canonicalizes only Payload/Lexical service defaults. Node type, child order,
 * text, non-default formatting and link fields remain comparison-significant.
 */
export function normalizePilotRichText(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizePilotRichText);
  if (typeof value !== 'object' || value === null) return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    if (key === 'version') continue;
    const ignored = LEXICAL_EMPTY_DEFAULTS[key];
    if (ignored?.some((candidate) => Object.is(candidate, child)) === true) continue;
    normalized[key] = normalizePilotRichText(child);
  }
  return normalized;
}

function cardPath(slug: string): string {
  return buildCardPath(slug);
}

function cardSlugForPath(path: string): string | null {
  const prefix = `${CARD_PATH_PREFIX}/`;
  if (!path.startsWith(prefix)) return null;
  const suffix = path.slice(prefix.length);
  return suffix !== '' && !suffix.includes('/') ? suffix : null;
}

function expectedParentPath(
  seed: CollectionSeed,
  collectionsByKey: ReadonlyMap<string, CollectionSeed>,
): string | null {
  if (seed.parentKey === null) return null;
  return collectionsByKey.get(seed.parentKey)?.path ?? null;
}

function expectedCollectionFields(
  seed: CollectionSeed,
  collectionsByKey: ReadonlyMap<string, CollectionSeed>,
): Readonly<Record<string, unknown>> {
  return {
    pilotImportKey: pilotCollectionImportKey(seed.key),
    slug: seed.slug,
    path: seed.path,
    nodeKind: seed.nodeKind,
    parentPath: expectedParentPath(seed, collectionsByKey),
    title: seed.title,
    h1: seed.h1,
    metaDescription: seed.metaDescription,
    intro: normalizePilotRichText(pilotIntroDocument(seed.intro)),
    description: seed.description,
    robots: seed.robots,
  };
}

export function collectionManagedFieldDifferences(
  seed: CollectionSeed,
  existing: ExistingCollection,
  collectionsByKey: ReadonlyMap<string, CollectionSeed>,
): string[] {
  return differingFields(
    expectedCollectionFields(seed, collectionsByKey),
    actualCollectionFields(existing),
  );
}

function actualCollectionFields(existing: ExistingCollection): Readonly<Record<string, unknown>> {
  return {
    pilotImportKey: existing.pilotImportKey ?? null,
    slug: existing.slug,
    path: existing.path,
    nodeKind: existing.nodeKind,
    parentPath: existing.parentPath,
    title: existing.title,
    h1: existing.h1,
    metaDescription: existing.metaDescription,
    intro: normalizePilotRichText(existing.intro),
    description: existing.description,
    robots: existing.robots,
  };
}

function expectedCardFields(
  seed: CardSeed,
  collectionsByKey: ReadonlyMap<string, CollectionSeed>,
  identity: PilotAssetIdentity | null,
): Readonly<Record<string, unknown>> {
  const collectionPath = collectionsByKey.get(seed.collectionKey)?.path;
  return {
    pilotImportKey: pilotCardImportKey(seed.pilotId),
    slug: seed.slug,
    title: seed.title,
    h1: seed.h1,
    metaDescription: seed.metaDescription,
    alt: seed.alt,
    caption: seed.caption,
    description: seed.description,
    usageTerms: seed.usageTerms,
    robots: seed.robots,
    collectionPaths: collectionPath === undefined ? [] : [collectionPath],
    imageRevision: identity?.revision ?? null,
    imagePilotImportKey: pilotImageImportKey(seed.pilotId),
    imageMimeType: identity?.mimeType ?? null,
    imageWidth: identity?.width ?? null,
    imageHeight: identity?.height ?? null,
  };
}

export function cardManagedFieldDifferences(
  seed: CardSeed,
  existing: ExistingCard,
  collectionsByKey: ReadonlyMap<string, CollectionSeed>,
  identity: PilotAssetIdentity,
): string[] {
  return differingFields(
    expectedCardFields(seed, collectionsByKey, identity),
    actualCardFields(existing),
  );
}

function actualCardFields(existing: ExistingCard): Readonly<Record<string, unknown>> {
  return {
    pilotImportKey: existing.pilotImportKey ?? null,
    slug: existing.slug,
    title: existing.title,
    h1: existing.h1,
    metaDescription: existing.metaDescription,
    alt: existing.alt,
    caption: existing.caption,
    description: existing.description,
    usageTerms: existing.usageTerms,
    robots: existing.robots,
    collectionPaths: [...existing.collectionPaths],
    imageRevision: existing.imageRevision,
    imagePilotImportKey: existing.imagePilotImportKey ?? null,
    imageMimeType: existing.imageMimeType,
    imageWidth: existing.imageWidth,
    imageHeight: existing.imageHeight,
  };
}

function statusError(kind: 'Card' | 'Collection', key: string, existing: { status: string }): string | null {
  return existing.status === 'draft' || existing.status === 'review'
    ? null
    : `${kind} ${key} existing record is ${existing.status}; only draft or review can resume.`;
}

function claimError(
  label: string,
  path: string,
  kind: 'cards' | 'collections',
  existing: { pathClaimKey: string | null } | null,
  claim: ExistingContentPathClaim | null,
): string | null {
  if (claim === null) {
    return existing === null
      ? null
      : `${label} final path ${path} has no permanent content-path claim.`;
  }
  if (existing === null || existing.pathClaimKey === null || existing.pathClaimKey.trim() === '') {
    return `${label} final path ${path} is permanently claimed by ${claim.ownerKey}.`;
  }
  const expectedOwnerKey = `${kind}:${existing.pathClaimKey}`;
  return claim.ownerCollection === kind && claim.ownerKey === expectedOwnerKey
    ? null
    : `${label} final path ${path} is permanently claimed by ${claim.ownerKey}.`;
}

async function checkCollection(
  seed: CollectionSeed,
  store: PilotImportStore,
  collectionsByKey: ReadonlyMap<string, CollectionSeed>,
): Promise<CheckedRecord> {
  const errors: string[] = [];
  const importKey = pilotCollectionImportKey(seed.key);
  const [existing, pathMatch, cardCollision, claim] = await Promise.all([
    store.findCollectionByPilotImportKey(importKey),
    store.findCollectionByPath(seed.path),
    (() => {
      const slug = cardSlugForPath(seed.path);
      return slug === null ? Promise.resolve(null) : store.findCardBySlug(slug);
    })(),
    store.findContentPathClaimByPath(seed.path),
  ]);
  if (cardCollision !== null) {
    errors.push(
      `Collection ${seed.key} final path ${seed.path} is occupied by card ${String(cardCollision.id)}.`,
    );
  }
  if (pathMatch !== null && (existing === null || String(pathMatch.id) !== String(existing.id))) {
    errors.push(
      `Collection ${seed.key} final path ${seed.path} is occupied by collection ${String(pathMatch.id)} with another import identity.`,
    );
  }
  if (existing !== null) {
    const fields = differingFields(
      expectedCollectionFields(seed, collectionsByKey),
      actualCollectionFields(existing),
    );
    errors.push(...fields.map((field) =>
      `Collection ${seed.key} existing record ${String(existing.id)} differs in managed field ${field}.`,
    ));
    const state = statusError('Collection', seed.key, existing);
    if (state !== null) errors.push(state);
  }
  const identityAtExpectedPath = existing !== null && existing.path === seed.path ? existing : null;
  const problem = pathMatch !== null && identityAtExpectedPath === null
    ? null
    : claimError(`Collection ${seed.key}`, seed.path, 'collections', identityAtExpectedPath, claim);
  if (problem !== null) errors.push(problem);
  return {
    errors,
    record: {
      key: `collection:${seed.key}`,
      kind: 'collection',
      path: seed.path,
      state: errors.length > 0 ? 'blocked' : existing === null ? 'create' : 'resume',
      detail: errors.length > 0
        ? errors.join(' ')
        : existing === null ? 'validated creation candidate' : `resume existing ${String(existing.id)}`,
    },
  };
}

async function checkCard(
  seed: CardSeed,
  store: PilotImportStore,
  collectionsByKey: ReadonlyMap<string, CollectionSeed>,
  identity: PilotAssetIdentity | null,
): Promise<CheckedRecord> {
  const path = cardPath(seed.slug);
  const errors: string[] = [];
  const importKey = pilotCardImportKey(seed.pilotId);
  const imageImportKey = pilotImageImportKey(seed.pilotId);
  const [existing, slugMatch, image, collectionCollision, claim] = await Promise.all([
    store.findCardByPilotImportKey(importKey),
    store.findCardBySlug(seed.slug),
    store.findImageByPilotImportKey(imageImportKey),
    store.findCollectionByPath(path),
    store.findContentPathClaimByPath(path),
  ]);
  if (slugMatch !== null && (existing === null || String(slugMatch.id) !== String(existing.id))) {
    errors.push(`Card ${seed.pilotId} final path ${path} is occupied by card ${String(slugMatch.id)} with another import identity.`);
  }
  if (collectionCollision !== null) {
    errors.push(
      `Card ${seed.pilotId} final path ${path} is occupied by collection ${String(collectionCollision.id)}.`,
    );
  }
  if (existing !== null) {
    const fields = differingFields(
      expectedCardFields(seed, collectionsByKey, identity),
      actualCardFields(existing),
    );
    errors.push(...fields.map((field) =>
      `Card ${seed.pilotId} existing record ${String(existing.id)} differs in managed field ${field}.`,
    ));
    const state = statusError('Card', seed.pilotId, existing);
    if (state !== null) errors.push(state);
  }
  if (image !== null && identity !== null) {
    const imageFields = differingFields(
      {
        pilotImportKey: imageImportKey,
        revision: identity.revision,
        mimeType: identity.mimeType,
        width: identity.width,
        height: identity.height,
      },
      {
        pilotImportKey: image.pilotImportKey,
        revision: image.revision,
        mimeType: image.mimeType,
        width: image.width,
        height: image.height,
      },
    );
    errors.push(...imageFields.map((field) =>
      `Card ${seed.pilotId} existing pilot image ${String(image.id)} differs in managed field ${field}.`,
    ));
  }
  const problem = claimError(`Card ${seed.pilotId}`, path, 'cards', existing, claim);
  if (problem !== null) errors.push(problem);
  return {
    errors,
    record: {
      key: `card:${seed.pilotId}`,
      kind: 'card',
      path,
      state: errors.length > 0 ? 'blocked' : existing === null ? 'create' : 'resume',
      detail: errors.length > 0
        ? errors.join(' ')
        : existing === null ? 'validated creation candidate' : `resume existing ${String(existing.id)}`,
    },
  };
}

async function checkAsset(assetRoot: string, seed: CardSeed): Promise<AssetCheck> {
  const path = join(assetRoot, seed.sourceFile);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
    return {
      valid: false,
      identity: null,
      bytes: null,
      errors: [code === 'ENOENT'
        ? `Asset ${seed.sourceFile} is missing.`
        : `Asset ${seed.sourceFile} cannot be read: ${error instanceof Error ? error.message : String(error)}.`],
    };
  }

  const errors: string[] = [];
  let identity: PilotAssetIdentity | null = null;
  try {
    const metadata = await sharp(bytes).metadata();
    const width = metadata.width;
    const height = metadata.height;
    if (metadata.format !== 'jpeg') {
      errors.push(`Asset ${seed.sourceFile} must be JPEG; received ${metadata.format ?? 'unknown'}.`);
    }
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
      errors.push(`Asset ${seed.sourceFile} has no readable integer dimensions.`);
    } else {
      if (width < 1024 || height < 1280) {
        errors.push(
          `Asset ${seed.sourceFile} must be at least 1024x1280; received ${String(width)}x${String(height)}.`,
        );
      }
      if (width * 5 !== height * 4) {
        errors.push(
          `Asset ${seed.sourceFile} must have exact 4:5 ratio; received ${String(width)}x${String(height)}.`,
        );
      }
    }
    if (metadata.format === 'jpeg' && Number.isInteger(width) && Number.isInteger(height)) {
      identity = {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        revision: await computeImageRevision(bytes),
        mimeType: 'image/jpeg',
        format: 'jpeg',
        width,
        height,
        ratio: '4:5',
        path,
      };
    }
  } catch (error) {
    errors.push(
      `Asset ${seed.sourceFile} cannot be decoded by Sharp: ${error instanceof Error ? error.message : valueLabel(error)}.`,
    );
  }
  return { valid: errors.length === 0, errors, identity, bytes };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

async function directoryErrors(assetRoot: string, expectedFiles: ReadonlySet<string>): Promise<string[]> {
  try {
    const entries = await readdir(assetRoot, { withFileTypes: true });
    const actualFiles = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
    const missing = [...expectedFiles].filter((name) => !actualFiles.includes(name)).sort();
    const unexpected = actualFiles.filter((name) => !expectedFiles.has(name));
    if (missing.length === 0 && unexpected.length === 0 && actualFiles.length === expectedFiles.size) {
      return [];
    }
    const details = [
      missing.length > 0 ? `missing: ${missing.join(', ')}` : '',
      unexpected.length > 0 ? `unexpected: ${unexpected.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    return [`Asset root must contain exactly the 50 matrix JPEGs; ${details}.`];
  } catch (error) {
    return [
      `Asset root ${assetRoot} cannot be read: ${error instanceof Error ? error.message : String(error)}.`,
    ];
  }
}

function internalPathErrors(input: PilotPreflightInput): string[] {
  const owners = new Map<string, string>();
  const errors: string[] = [];
  for (const candidate of [
    ...input.matrix.collections.map((seed) => ({ owner: `collection:${seed.key}`, path: seed.path })),
    ...input.matrix.cards.map((seed) => ({ owner: `card:${seed.pilotId}`, path: cardPath(seed.slug) })),
  ]) {
    const previous = owners.get(candidate.path);
    if (previous !== undefined) {
      errors.push(`Pilot final path ${candidate.path} is assigned to both ${previous} and ${candidate.owner}.`);
    } else {
      owners.set(candidate.path, candidate.owner);
    }
  }
  return errors;
}

/**
 * Reads assets and database state only. The adapter has no write method, so a
 * preflight cannot mutate CMS even accidentally.
 */
export async function runPilotPreflight(input: PilotPreflightInput): Promise<PilotPreflightReport> {
  const blockingErrors = [
    ...validateSiteContent(input.matrix, input.manifest),
    ...internalPathErrors(input),
  ];

  const actorEmail = input.actorEmail.trim();
  let actor: Awaited<ReturnType<PilotImportStore['findActor']>> = null;
  if (actorEmail === '') {
    blockingErrors.push('Import actor email must be explicit.');
  } else {
    actor = await input.store.findActor(actorEmail);
    if (actor === null) {
      blockingErrors.push(`Import actor ${actorEmail} does not exist.`);
    } else if (actor.role !== 'ai-editor') {
      blockingErrors.push(
        `Import actor ${actorEmail} must have role ai-editor; received ${actor.role}.`,
      );
    }
  }

  const expectedFiles = new Set(input.matrix.cards.map((card) => card.sourceFile));
  blockingErrors.push(...await directoryErrors(input.assetRoot, expectedFiles));
  const assetChecks = await Promise.all(
    input.matrix.cards.map((seed) => checkAsset(input.assetRoot, seed)),
  );
  blockingErrors.push(...assetChecks.flatMap((result) => result.errors));

  const collectionsByKey = new Map(input.matrix.collections.map((seed) => [seed.key, seed]));
  const [collectionChecks, cardChecks] = await Promise.all([
    Promise.all(input.matrix.collections.map((seed) =>
      checkCollection(seed, input.store, collectionsByKey),
    )),
    Promise.all(input.matrix.cards.map((seed, index) =>
      checkCard(seed, input.store, collectionsByKey, assetChecks[index]?.identity ?? null),
    )),
  ]);
  const checks = [...collectionChecks, ...cardChecks];
  blockingErrors.push(...checks.flatMap((result) => result.errors));
  const records = checks.map((result) => result.record);

  const uniqueBlockingErrors = [...new Set(blockingErrors)];
  const preflightFingerprint = uniqueBlockingErrors.length === 0 && actor !== null &&
      assetChecks.every((result) => result.identity !== null)
    ? fingerprint({
        actor: { email: actor.email ?? actorEmail, id: actor.id, role: actor.role },
        assets: input.matrix.cards.map((seed, index) => ({
          pilotId: seed.pilotId,
          sourceFile: seed.sourceFile,
          identity: assetChecks[index]?.identity,
        })),
        manifest: input.manifest,
        matrix: input.matrix,
      })
    : null;
  const preparedAssets: PilotPreparedAsset[] = preflightFingerprint === null
    ? []
    : input.matrix.cards.flatMap((seed, index) => {
        const check = assetChecks[index];
        return check?.valid === true && check.identity !== null && check.bytes !== null
          ? [{ pilotId: seed.pilotId, sourceFile: seed.sourceFile, bytes: check.bytes, identity: check.identity }]
          : [];
      });

  return {
    mode: 'dry-run',
    collectionNodes: input.matrix.collections.length,
    leafTopics: input.matrix.collections.filter((seed) => seed.leafTopic).length,
    cards: input.matrix.cards.length,
    validFiles: assetChecks.filter((result) => result.valid).length,
    resumed: records.filter((record) => record.state === 'resume').length,
    mutationCount: 0,
    blockingErrors: uniqueBlockingErrors,
    records,
    fingerprint: preflightFingerprint,
    preparedAssets,
  };
}
