import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { computeImageRevision } from '@otkritka/images';
import { APIError } from 'payload';

import { buildCardPath } from '../seo/paths';
import type { GeneratedCardSeed, GeneratedCollectionSeed } from './library-seeds';
import {
  runGeneratedLibraryPreflight,
  type GeneratedLibraryExistingCard,
  type GeneratedLibraryExistingCollection,
  type GeneratedLibraryExistingImage,
  type GeneratedLibraryPreflightInput,
  type GeneratedLibraryPreflightReport,
  type GeneratedLibraryReadStore,
  generatedCardManagedDifferences,
  generatedCollectionManagedDifferences,
  isInterruptedGeneratedCollection,
  storedImageErrors,
} from './library-preflight';
import { sourceCardImportKey, sourceCollectionImportKey, sourceImageImportKey } from './source-import-identity';

export interface GeneratedLibraryApplyStore extends GeneratedLibraryReadStore {
  createCollection(seed: GeneratedCollectionSeed, parentId: number | string): Promise<GeneratedLibraryExistingCollection>;
  setCollectionRelated(collection: GeneratedLibraryExistingCollection, relatedIds: readonly (number | string)[]): Promise<GeneratedLibraryExistingCollection | null>;
  createImage(seed: GeneratedCardSeed, bytes: Buffer): Promise<GeneratedLibraryExistingImage>;
  createCard(seed: GeneratedCardSeed, imageId: number | string, collectionId: number | string): Promise<GeneratedLibraryExistingCard>;
  moveCollectionToReview(collection: GeneratedLibraryExistingCollection): Promise<GeneratedLibraryExistingCollection | null>;
  moveCardToReview(card: GeneratedLibraryExistingCard): Promise<GeneratedLibraryExistingCard | null>;
}

export interface GeneratedLibraryApplyInput extends Omit<GeneratedLibraryPreflightInput, 'store'> {
  readonly preflight: GeneratedLibraryPreflightReport;
  readonly store: GeneratedLibraryApplyStore;
  readonly recordOrphanedImage: (value: {
    readonly sourceSha256: string;
    readonly image: GeneratedLibraryExistingImage;
    readonly reason: string;
  }) => Promise<void>;
}

export interface GeneratedLibraryApplyReport {
  readonly mode: 'apply';
  readonly sourceRows: number;
  readonly uniqueSources: number;
  readonly aliases: number;
  readonly reusedPilotCards: number;
  readonly createdCollections: number;
  readonly resumedCollections: number;
  readonly collectionReview: number;
  readonly collectionDraft: number;
  readonly collectionReviewRefusals: readonly { readonly path: string; readonly reason: string }[];
  readonly createdImages: number;
  readonly resumedImages: number;
  readonly createdCards: number;
  readonly resumedCards: number;
  readonly review: number;
  readonly draft: number;
  readonly published: number;
  readonly indexed: number;
  readonly sitemapUrlsAdded: 0;
  readonly reviewRefusals: readonly { readonly sourceSha256: string; readonly reason: string }[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const REVIEW_REFUSAL_RULES = new Set([
  'incomplete-for-review', 'meta-duplicate-unresolved', 'visual-duplicate-unresolved',
]);

export function reviewRefusalReason(error: unknown): string | null {
  if (!(error instanceof APIError) || error.status !== 400 || error.isOperational !== true) return null;
  const data = error.data as { rule?: unknown } | undefined;
  return typeof data?.rule === 'string' && REVIEW_REFUSAL_RULES.has(data.rule) ? errorMessage(error) : null;
}

async function assertFreshActor(input: GeneratedLibraryApplyInput): Promise<void> {
  const actor = await input.store.findActor(input.actorEmail.trim());
  if (actor === null || actor.role !== 'ai-editor') throw new Error('Generated library apply requires a current ai-editor actor.');
}

function assertApplyPreflight(original: GeneratedLibraryPreflightReport, current: GeneratedLibraryPreflightReport): void {
  if (original.mode !== 'dry-run' || original.mutationCount !== 0 || original.blockingErrors.length > 0 ||
      original.fingerprint === null || current.fingerprint !== original.fingerprint) {
    throw new Error('Generated library state changed after preflight; run a new dry-run before apply.');
  }
}

function pathDepth(path: string): number {
  return path.split('/').filter(Boolean).length;
}

function managedSnapshot(value: GeneratedLibraryExistingCard | GeneratedLibraryExistingCollection): unknown {
  return { ...value, relatedPaths: 'relatedPaths' in value ? [...(value.relatedPaths ?? [])].sort() : undefined };
}

export async function applyGeneratedLibrary(input: GeneratedLibraryApplyInput): Promise<GeneratedLibraryApplyReport> {
  const current = await runGeneratedLibraryPreflight(input);
  assertApplyPreflight(input.preflight, current);
  await assertFreshActor(input);

  let createdCollections = 0;
  let resumedCollections = 0;
  const collectionReviewRefusals: Array<{ path: string; reason: string }> = [];
  const collectionByPath = new Map<string, GeneratedLibraryExistingCollection>();
  const createdCollectionPaths = new Set<string>();
  for (const seed of [...input.seeds.collections].sort((left, right) => pathDepth(left.path) - pathDepth(right.path) || left.path.localeCompare(right.path))) {
    const key = sourceCollectionImportKey(seed.key);
    let collection = await input.store.findCollectionBySourceKey(key);
    if (collection === null) {
      const occupied = await input.store.findCollectionByPath(seed.path);
      if (occupied !== null) throw new Error(`Collection path ${seed.path} is occupied without exact source identity ${key}.`);
      const parent = collectionByPath.get(seed.parentPath) ?? await input.store.findCollectionByPath(seed.parentPath);
      if (parent === null) throw new Error(`Collection parent ${seed.parentPath} disappeared after preflight.`);
      await assertFreshActor(input);
      collection = await input.store.createCollection(seed, parent.id);
      createdCollections += 1;
      createdCollectionPaths.add(seed.path);
    } else {
      resumedCollections += 1;
    }
    collectionByPath.set(seed.path, collection);
  }
  for (const seed of input.seeds.collections) {
    let collection = collectionByPath.get(seed.path)!;
    const related = await Promise.all(seed.relatedPaths.map(async (path) =>
      collectionByPath.get(path) ?? input.store.findCollectionByPath(path)));
    if (related.some((value) => value === null)) throw new Error(`Related collection disappeared for ${seed.path}.`);
    if (createdCollectionPaths.has(seed.path) || isInterruptedGeneratedCollection(collection)) {
      await assertFreshActor(input);
      const updated = await input.store.setCollectionRelated(collection, related.map((value) => value!.id));
      if (updated === null) throw new Error(`Collection ${seed.path} changed concurrently before related update.`);
      collection = updated;
      collectionByPath.set(seed.path, collection);
    }
    if (collection.status === 'draft') {
      try {
        const currentCollection = await input.store.findCollectionBySourceKey(sourceCollectionImportKey(seed.key));
        if (currentCollection === null || !isDeepStrictEqual(managedSnapshot(currentCollection), managedSnapshot(collection))) {
          throw new Error(`Collection ${seed.path} changed concurrently before review.`);
        }
        await assertFreshActor(input);
        const moved = await input.store.moveCollectionToReview(collection);
        if (moved === null) throw new Error(`Collection ${seed.path} changed concurrently before review.`);
        collection = moved;
        collectionByPath.set(seed.path, collection);
      } catch (error) {
        const reason = reviewRefusalReason(error);
        if (reason === null) throw error;
        collectionReviewRefusals.push({ path: seed.path, reason });
      }
    }
  }

  let createdImages = 0;
  let resumedImages = 0;
  let createdCards = 0;
  let resumedCards = 0;
  const reviewRefusals: Array<{ sourceSha256: string; reason: string }> = [];
  const preparedByHash = new Map(current.preparedCards.map((item) => [item.seed.sourceSha256, item]));
  for (const seed of input.seeds.cards) {
    const cardKey = sourceCardImportKey(seed.sourceSha256);
    const imageKey = sourceImageImportKey(seed.sourceSha256);
    let card = await input.store.findCardBySourceKey(cardKey);
    if (card === null) {
      const [claim, slugMatch] = await Promise.all([
        input.store.findContentPathClaimByPath(buildCardPath(seed.slug)), input.store.findCardBySlug(seed.slug),
      ]);
      if (claim !== null || slugMatch !== null) throw new Error(`Card path ${buildCardPath(seed.slug)} became occupied before image creation.`);
    }
    let image = await input.store.findImageBySourceKey(imageKey);
    let imageCreated = false;
    try {
      if (image === null) {
        const prepared = preparedByHash.get(seed.sourceSha256);
        if (prepared === undefined) throw new Error(`Prepared portrait is missing for ${seed.sourceSha256}.`);
        const portraitBytes = await input.readBytes(prepared.portraitPath);
        const [portraitSha256, portraitRevision] = await Promise.all([
          Promise.resolve(createHash('sha256').update(portraitBytes).digest('hex')),
          computeImageRevision(portraitBytes),
        ]);
        if (portraitSha256 !== prepared.portraitSha256 || portraitRevision !== prepared.portraitRevision) {
          throw new Error(`Source portrait changed after preflight: ${prepared.portraitPath}.`);
        }
        await assertFreshActor(input);
        image = await input.store.createImage(seed, portraitBytes);
        imageCreated = true;
        const storageErrors = await storedImageErrors(`Image ${imageKey}`, image, prepared.portraitRevision, input.store);
        if (storageErrors.length > 0) throw new Error(storageErrors.join(' '));
        createdImages += 1;
      } else resumedImages += 1;
      if (card === null) {
        const collection = collectionByPath.get(seed.collectionPath) ?? await input.store.findCollectionByPath(seed.collectionPath);
        if (collection === null) throw new Error(`Primary collection ${seed.collectionPath} disappeared after preflight.`);
        const [claim, slugMatch] = await Promise.all([
          input.store.findContentPathClaimByPath(buildCardPath(seed.slug)), input.store.findCardBySlug(seed.slug),
        ]);
        if (claim !== null || slugMatch !== null) throw new Error(`Card path ${buildCardPath(seed.slug)} became occupied after image creation.`);
        await assertFreshActor(input);
        card = await input.store.createCard(seed, image.id, collection.id);
        createdCards += 1;
      } else resumedCards += 1;
    } catch (error) {
      if (imageCreated && image !== null) await input.recordOrphanedImage({ sourceSha256: seed.sourceSha256, image, reason: errorMessage(error) });
      throw error;
    }
    if (card.status === 'draft') {
      try {
        const fresh = await input.store.findCardBySourceKey(cardKey);
        if (fresh === null) throw new Error(`Card ${cardKey} disappeared before review.`);
        if (!isDeepStrictEqual(managedSnapshot(fresh), managedSnapshot(card))) throw new Error(`Card ${cardKey} changed concurrently before review.`);
        await assertFreshActor(input);
        const moved = await input.store.moveCardToReview(card);
        if (moved === null) throw new Error(`Card ${cardKey} changed concurrently before review.`);
        card = moved;
      } catch (error) {
        const reason = reviewRefusalReason(error);
        if (reason === null) throw error;
        reviewRefusals.push({ sourceSha256: seed.sourceSha256, reason });
      }
    }
  }

  let review = 0;
  let draft = 0;
  let published = 0;
  let indexed = 0;
  for (const seed of input.seeds.cards) {
    const card = await input.store.findCardBySourceKey(sourceCardImportKey(seed.sourceSha256));
    const image = await input.store.findImageBySourceKey(sourceImageImportKey(seed.sourceSha256));
    if (card === null || image === null || card.imageId === null || card.imageId === undefined ||
        String(card.imageId) !== String(image.id) || card.collectionPath !== seed.collectionPath) {
      throw new Error(`Final verification failed for source ${seed.sourceSha256}.`);
    }
    const cardKey = sourceCardImportKey(seed.sourceSha256);
    if (card.sourceImportKey !== cardKey) throw new Error(`Final card identity failed for source ${seed.sourceSha256}.`);
    const differences = generatedCardManagedDifferences(seed, card);
    if (differences.length > 0) throw new Error(`Final card ${cardKey} differs in managed fields: ${differences.join(', ')}.`);
    const path = buildCardPath(seed.slug);
    const claim = await input.store.findContentPathClaimByPath(path);
    if (typeof card.pathClaimKey !== 'string' || claim === null || claim.ownerCollection !== 'cards' ||
        claim.ownerKey !== `cards:${card.pathClaimKey}`) throw new Error(`Final card path claim failed for ${path}.`);
    const expectedRevision = preparedByHash.get(seed.sourceSha256)?.portraitRevision;
    if (expectedRevision === undefined) throw new Error(`Prepared portrait is missing for ${seed.sourceSha256}.`);
    const storageErrors = await storedImageErrors(`Image ${sourceImageImportKey(seed.sourceSha256)}`, image, expectedRevision, input.store);
    if (storageErrors.length > 0) throw new Error(storageErrors.join(' '));
    if (card.robots !== 'noindex,follow') indexed += 1;
    if (card.status === 'review') review += 1;
    else if (card.status === 'draft') draft += 1;
    else if (card.status === 'published') published += 1;
    else throw new Error(`Imported card ${String(card.id)} has forbidden status ${card.status}.`);
  }

  let collectionReview = 0;
  let collectionDraft = 0;
  for (const seed of input.seeds.collections) {
    const key = sourceCollectionImportKey(seed.key);
    const collection = await input.store.findCollectionBySourceKey(key);
    if (collection === null || collection.sourceImportKey !== key || collection.path !== seed.path) {
      throw new Error(`Final collection identity failed for ${seed.path}.`);
    }
    const differences = generatedCollectionManagedDifferences(seed, collection);
    const actualRelated = [...(collection.relatedPaths ?? [])].sort();
    const expectedRelated = [...seed.relatedPaths].sort();
    if (!isDeepStrictEqual(actualRelated, expectedRelated)) differences.push('related paths');
    if (differences.length > 0) throw new Error(`Final collection ${key} differs in managed fields: ${differences.join(', ')}.`);
    const claim = await input.store.findContentPathClaimByPath(seed.path);
    if (typeof collection.pathClaimKey !== 'string' || claim === null || claim.ownerCollection !== 'collections' ||
        claim.ownerKey !== `collections:${collection.pathClaimKey}`) throw new Error(`Final collection path claim failed for ${seed.path}.`);
    if (collection.robots !== 'noindex,follow') indexed += 1;
    if (collection.status === 'review') collectionReview += 1;
    else if (collection.status === 'draft') collectionDraft += 1;
    else if (collection.status === 'published') published += 1;
    else throw new Error(`Imported collection ${seed.path} has forbidden status ${collection.status}.`);
  }
  if (published > 0 || indexed > 0) throw new Error(`Final audit found forbidden published/indexed content: ${String(published)}/${String(indexed)}.`);

  return {
    mode: 'apply',
    sourceRows: input.plan.sourceRowCount,
    uniqueSources: input.plan.uniqueSourceCount,
    aliases: input.plan.aliases.length,
    reusedPilotCards: input.plan.pilotRowCount,
    createdCollections,
    resumedCollections,
    collectionReview,
    collectionDraft,
    collectionReviewRefusals,
    createdImages,
    resumedImages,
    createdCards,
    resumedCards,
    review,
    draft,
    published,
    indexed,
    sitemapUrlsAdded: 0,
    reviewRefusals,
  };
}
