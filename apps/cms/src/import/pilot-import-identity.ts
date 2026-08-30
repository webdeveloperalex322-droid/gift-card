import type { CollectionBeforeValidateHook } from 'payload';

const PILOT_IMPORT_PREFIX = 'pilot-2026-08';
const CONTEXT_KEY = 'otkritkaPilotImport';

interface TrustedPilotImportContext {
  readonly actorId: number | string;
  readonly key: string;
}

export function pilotCardImportKey(pilotId: string): string {
  return `${PILOT_IMPORT_PREFIX}:card:${pilotId}`;
}

export function pilotImageImportKey(pilotId: string): string {
  return `${PILOT_IMPORT_PREFIX}:image:${pilotId}`;
}

export function trustedPilotImportContext(
  key: string,
  actorId: number | string,
): Record<string, unknown> {
  return { [CONTEXT_KEY]: { actorId, key } satisfies TrustedPilotImportContext };
}

function trustedClaim(context: unknown): TrustedPilotImportContext | null {
  if (typeof context !== 'object' || context === null) return null;
  const value = (context as Record<string, unknown>)[CONTEXT_KEY];
  if (typeof value !== 'object' || value === null) return null;
  const { actorId, key } = value as Partial<TrustedPilotImportContext>;
  if ((typeof actorId !== 'number' && typeof actorId !== 'string') ||
      typeof key !== 'string' || !/^pilot-2026-08:(?:card|image):\d{2}$/u.test(key)) return null;
  return { actorId, key };
}

/**
 * REST/GraphQL cannot populate Payload's local request context. The importer
 * supplies this context while still writing with the ai-editor actor and
 * overrideAccess:false; ordinary API clients have the field stripped.
 */
export function assignTrustedPilotImportKey(): CollectionBeforeValidateHook {
  return ({ data, operation, originalDoc, req }) => {
    const next = { ...(data ?? {}) } as Record<string, unknown>;
    const persisted = (originalDoc as Record<string, unknown> | undefined)?.pilotImportKey;
    if (typeof persisted === 'string') {
      next.pilotImportKey = persisted;
      return next;
    }
    delete next.pilotImportKey;
    if (operation !== 'create' || req.user?.role !== 'ai-editor') return next;
    const claim = trustedClaim(req.context);
    if (claim === null || String(claim.actorId) !== String(req.user.id)) return next;
    next.pilotImportKey = claim.key;
    return next;
  };
}
