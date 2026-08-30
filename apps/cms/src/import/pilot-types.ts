import type { CardRecord } from '../../../../scripts/content-pilot/manifest.mjs';
import type { SiteContentMatrix } from '../../../../scripts/content-import/schema.js';

export interface PilotImportActor {
  readonly id: number | string;
  readonly role: string;
}

export interface ExistingCard {
  id: number | string;
  slug: string;
  pathClaimKey: string | null;
  title: string;
  h1: string | null;
  metaDescription: string | null;
  alt: string | null;
  caption: string | null;
  description: string | null;
  usageTerms: string | null;
  status: string;
  robots: string;
  collectionPaths: readonly string[];
  imageSourceFile: string | null;
}

export interface ExistingCollection {
  id: number | string;
  path: string;
  pathClaimKey: string | null;
  slug: string;
  nodeKind: string;
  parentPath: string | null;
  title: string;
  h1: string | null;
  metaDescription: string | null;
  intro: unknown;
  description: string | null;
  status: string;
  robots: string;
}

export interface ExistingContentPathClaim {
  readonly path: string;
  readonly ownerCollection: 'cards' | 'collections';
  readonly ownerKey: string;
}

/** Read-only boundary. Task 7 extends it with writes; preflight never does. */
export interface PilotImportStore {
  findActor(email: string): Promise<PilotImportActor | null>;
  findCardBySlug(slug: string): Promise<ExistingCard | null>;
  findCollectionByPath(path: string): Promise<ExistingCollection | null>;
  findContentPathClaimByPath?: (
    path: string,
  ) => Promise<ExistingContentPathClaim | null>;
}

export interface PilotPreflightInput {
  readonly actorEmail: string;
  readonly assetRoot: string;
  readonly manifest: readonly CardRecord[];
  readonly matrix: SiteContentMatrix;
  readonly store: PilotImportStore;
}

export type PilotPreflightRecordState = 'blocked' | 'create' | 'resume';

export interface PilotPreflightRecord {
  readonly key: string;
  readonly kind: 'card' | 'collection';
  readonly path: string;
  readonly state: PilotPreflightRecordState;
  readonly detail: string;
}

export interface PilotPreflightReport {
  readonly mode: 'dry-run';
  readonly collectionNodes: number;
  readonly leafTopics: number;
  readonly cards: number;
  readonly validFiles: number;
  readonly resumed: number;
  readonly mutationCount: 0;
  readonly blockingErrors: readonly string[];
  readonly records: readonly PilotPreflightRecord[];
}

/** Minimal Lexical value used by the importer and compared byte-for-byte on resume. */
export function pilotIntroDocument(text: string): Readonly<Record<string, unknown>> {
  return {
    root: {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'text',
              detail: 0,
              format: 0,
              mode: 'normal',
              style: '',
              text,
              version: 1,
            },
          ],
          direction: null,
          format: '',
          indent: 0,
          textFormat: 0,
          textStyle: '',
          version: 1,
        },
      ],
      direction: null,
      format: '',
      indent: 0,
      version: 1,
    },
  };
}
