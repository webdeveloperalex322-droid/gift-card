import type { GeneratedCardSeed, GeneratedCollectionSeed } from './library-seeds';
import {
  runGeneratedLibraryPreflight,
  type GeneratedLibraryExistingCard,
  type GeneratedLibraryExistingCollection,
  type GeneratedLibraryExistingImage,
  type GeneratedLibraryPreflightInput,
  type GeneratedLibraryPreflightReport,
  type GeneratedLibraryReadStore,
} from './library-preflight';
import { sourceCardImportKey, sourceCollectionImportKey, sourceImageImportKey } from './source-import-identity';

export interface GeneratedLibraryApplyStore extends GeneratedLibraryReadStore {
  createCollection(seed: GeneratedCollectionSeed, parentId: number | string): Promise<GeneratedLibraryExistingCollection>;
  setCollectionRelated(collection: GeneratedLibraryExistingCollection, relatedIds: readonly (number | string)[]): Promise<void>;
  createImage(seed: GeneratedCardSeed, bytes: Buffer): Promise<GeneratedLibraryExistingImage>;
  createCard(seed: GeneratedCardSeed, imageId: number | string, collectionId: number | string): Promise<GeneratedLibraryExistingCard>;
  moveCollectionToReview(collection: GeneratedLibraryExistingCollection): Promise<GeneratedLibraryExistingCollection>;
  moveCardToReview(card: GeneratedLibraryExistingCard): Promise<GeneratedLibraryExistingCard>;
}

export interface GeneratedLibraryApplyInput extends Omit<GeneratedLibraryPreflightInput, 'store'> {
  readonly preflight: GeneratedLibraryPreflightReport;
  readonly store: GeneratedLibraryApplyStore;
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
  readonly published: 0;
  readonly indexed: 0;
  readonly sitemapUrlsAdded: 0;
  readonly reviewRefusals: readonly { readonly sourceSha256: string; readonly reason: string }[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export async function applyGeneratedLibrary(input: GeneratedLibraryApplyInput): Promise<GeneratedLibraryApplyReport> {
  const current = await runGeneratedLibraryPreflight(input);
  assertApplyPreflight(input.preflight, current);
  const actor = await input.store.findActor(input.actorEmail.trim());
  if (actor === null || actor.role !== 'ai-editor') throw new Error('Generated library apply requires an ai-editor actor.');

  let createdCollections = 0;
  let resumedCollections = 0;
  const collectionReviewRefusals: Array<{ path: string; reason: string }> = [];
  const collectionByPath = new Map<string, GeneratedLibraryExistingCollection>();
  for (const seed of [...input.seeds.collections].sort((left, right) => pathDepth(left.path) - pathDepth(right.path) || left.path.localeCompare(right.path))) {
    const key = sourceCollectionImportKey(seed.key);
    let collection = await input.store.findCollectionBySourceKey(key) ?? await input.store.findCollectionByPath(seed.path);
    if (collection === null) {
      const parent = collectionByPath.get(seed.parentPath) ?? await input.store.findCollectionByPath(seed.parentPath);
      if (parent === null) throw new Error(`Collection parent ${seed.parentPath} disappeared after preflight.`);
      collection = await input.store.createCollection(seed, parent.id);
      createdCollections += 1;
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
    await input.store.setCollectionRelated(collection, related.map((value) => value!.id));
    if (collection.status === 'draft') {
      try {
        collection = await input.store.moveCollectionToReview(collection);
        collectionByPath.set(seed.path, collection);
      } catch (error) {
        collectionReviewRefusals.push({ path: seed.path, reason: errorMessage(error) });
      }
    }
  }

  let collectionReview = 0;
  let collectionDraft = 0;
  for (const seed of input.seeds.collections) {
    const collection = collectionByPath.get(seed.path);
    if (collection?.status === 'review') collectionReview += 1;
    else if (collection?.status === 'draft') collectionDraft += 1;
    else throw new Error(`Imported collection ${seed.path} has a forbidden or missing status.`);
    if (collection.robots !== 'noindex,follow') throw new Error(`Imported collection ${seed.path} became indexable.`);
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
    let image = await input.store.findImageBySourceKey(imageKey);
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
      image = await input.store.createImage(seed, portraitBytes);
      createdImages += 1;
    } else {
      resumedImages += 1;
    }
    let card = await input.store.findCardBySourceKey(cardKey);
    if (card === null) {
      const collection = collectionByPath.get(seed.collectionPath) ?? await input.store.findCollectionByPath(seed.collectionPath);
      if (collection === null) throw new Error(`Primary collection ${seed.collectionPath} disappeared after preflight.`);
      card = await input.store.createCard(seed, image.id, collection.id);
      createdCards += 1;
    } else {
      resumedCards += 1;
    }
    if (card.status === 'draft') {
      try {
        card = await input.store.moveCardToReview(card);
      } catch (error) {
        reviewRefusals.push({ sourceSha256: seed.sourceSha256, reason: errorMessage(error) });
      }
    }
  }

  let review = 0;
  let draft = 0;
  for (const seed of input.seeds.cards) {
    const card = await input.store.findCardBySourceKey(sourceCardImportKey(seed.sourceSha256));
    const image = await input.store.findImageBySourceKey(sourceImageImportKey(seed.sourceSha256));
    if (card === null || image === null || card.imageId === null || card.imageId === undefined ||
        String(card.imageId) !== String(image.id) || card.collectionPath !== seed.collectionPath) {
      throw new Error(`Final verification failed for source ${seed.sourceSha256}.`);
    }
    if (card.robots !== 'noindex,follow') throw new Error(`Imported card ${String(card.id)} became indexable.`);
    if (card.status === 'review') review += 1;
    else if (card.status === 'draft') draft += 1;
    else throw new Error(`Imported card ${String(card.id)} has forbidden status ${card.status}.`);
  }

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
    published: 0,
    indexed: 0,
    sitemapUrlsAdded: 0,
    reviewRefusals,
  };
}
import { createHash } from 'node:crypto';
import { computeImageRevision } from '@otkritka/images';
