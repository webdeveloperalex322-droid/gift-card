import type { CollectionBeforeValidateHook } from 'payload';

const PREFIX = 'generated-library-2026-08';
const CONTEXT_KEY = 'otkritkaGeneratedLibraryImport';
const SHA256 = /^[a-f0-9]{64}$/u;
const IMPORT_KEY = /^generated-library-2026-08:(?:(?:card|image):[a-f0-9]{64}|collection:[a-z0-9]+(?:-[a-z0-9]+)*)$/u;

interface TrustedSourceImportContext {
  readonly actorId: number | string;
  readonly key: string;
}

function assertSha256(value: string): string {
  const normalized = value.toLowerCase();
  if (!SHA256.test(normalized)) throw new Error('Source identity must be a full lowercase SHA-256.');
  return normalized;
}

export function sourceCardImportKey(sha256: string): string {
  return `${PREFIX}:card:${assertSha256(sha256)}`;
}

export function sourceImageImportKey(sha256: string): string {
  return `${PREFIX}:image:${assertSha256(sha256)}`;
}

export function sourceCollectionImportKey(key: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(key)) throw new Error('Collection import identity must be a valid slug.');
  return `${PREFIX}:collection:${key}`;
}

export function trustedSourceImportContext(key: string, actorId: number | string): Record<string, unknown> {
  if (!IMPORT_KEY.test(key)) throw new Error('Invalid generated-library import key.');
  return { [CONTEXT_KEY]: { actorId, key } satisfies TrustedSourceImportContext };
}

function trustedClaim(context: unknown): TrustedSourceImportContext | null {
  if (typeof context !== 'object' || context === null) return null;
  const value = (context as Record<string, unknown>)[CONTEXT_KEY];
  if (typeof value !== 'object' || value === null) return null;
  const { actorId, key } = value as Partial<TrustedSourceImportContext>;
  if ((typeof actorId !== 'number' && typeof actorId !== 'string') ||
      typeof key !== 'string' || !IMPORT_KEY.test(key)) return null;
  return { actorId, key };
}

export function assignTrustedSourceImportKey(): CollectionBeforeValidateHook {
  return ({ data, operation, originalDoc, req }) => {
    const next = { ...(data ?? {}) } as Record<string, unknown>;
    const persisted = (originalDoc as Record<string, unknown> | undefined)?.sourceImportKey;
    if (typeof persisted === 'string') {
      next.sourceImportKey = persisted;
      return next;
    }
    delete next.sourceImportKey;
    if (operation !== 'create' || req.user?.role !== 'ai-editor') return next;
    const claim = trustedClaim(req.context);
    if (claim === null || String(claim.actorId) !== String(req.user.id)) return next;
    next.sourceImportKey = claim.key;
    return next;
  };
}
