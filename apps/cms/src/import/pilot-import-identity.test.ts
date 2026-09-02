import { describe, expect, it } from 'vitest';

import {
  assignTrustedPilotImportKey,
  pilotCardImportKey,
  pilotCollectionImportKey,
  pilotImageImportKey,
  trustedPilotImportContext,
} from './pilot-import-identity';

describe('pilot import identity', () => {
  it('builds distinct stable keys for cards and images', () => {
    expect(pilotCardImportKey('07')).toBe('pilot-2026-08:card:07');
    expect(pilotImageImportKey('07')).toBe('pilot-2026-08:image:07');
  });

  it('builds and accepts a deterministic collection import key only in trusted context', async () => {
    const key = pilotCollectionImportKey('den-rozhdeniya-muzhchine');
    expect(key).toBe('pilot-2026-08:collection:den-rozhdeniya-muzhchine');

    const hook = assignTrustedPilotImportKey();
    const created: unknown = await hook({
      data: { pilotImportKey: 'spoofed' },
      operation: 'create',
      originalDoc: undefined,
      req: {
        context: trustedPilotImportContext(String(key), 91),
        user: { id: 91, role: 'ai-editor' },
      },
    } as never);
    expect(created).toMatchObject({ pilotImportKey: key });
  });

  it('assigns a key only from the importer-only request context and keeps it immutable', async () => {
    const hook = assignTrustedPilotImportKey();
    const trusted = trustedPilotImportContext('pilot-2026-08:card:07', 91);
    const created: unknown = await hook({
      data: { pilotImportKey: 'spoofed' },
      operation: 'create',
      originalDoc: undefined,
      req: { context: trusted, user: { id: 91, role: 'ai-editor' } },
    } as never);
    expect(created).toMatchObject({ pilotImportKey: 'pilot-2026-08:card:07' });

    const spoofed: unknown = await hook({
      data: { pilotImportKey: 'spoofed' },
      operation: 'create',
      originalDoc: undefined,
      req: { context: {}, user: { id: 91, role: 'ai-editor' } },
    } as never);
    expect(spoofed).not.toHaveProperty('pilotImportKey');

    const updated: unknown = await hook({
      data: { pilotImportKey: 'replacement' },
      operation: 'update',
      originalDoc: { pilotImportKey: 'pilot-2026-08:card:07' },
      req: { context: trusted, user: { id: 91, role: 'ai-editor' } },
    } as never);
    expect(updated).toMatchObject({ pilotImportKey: 'pilot-2026-08:card:07' });
  });
});
