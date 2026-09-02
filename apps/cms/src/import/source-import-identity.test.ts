import { describe, expect, it } from 'vitest';

import {
  assignTrustedSourceImportKey,
  sourceCardImportKey,
  sourceCollectionImportKey,
  sourceImageImportKey,
  trustedSourceImportContext,
} from './source-import-identity';

const SHA = 'a'.repeat(64);

describe('generated-library source import identity', () => {
  it('builds full-hash keys for cards and images and a closed collection key', () => {
    expect(sourceCardImportKey(SHA)).toBe(`generated-library-2026-08:card:${SHA}`);
    expect(sourceImageImportKey(SHA)).toBe(`generated-library-2026-08:image:${SHA}`);
    expect(sourceCollectionImportKey('paskha')).toBe('generated-library-2026-08:collection:paskha');
    expect(() => sourceCardImportKey('abc')).toThrow(/SHA-256/u);
  });

  it('strips an import key supplied without trusted local context', async () => {
    const hook = assignTrustedSourceImportKey();
    const result: unknown = await hook({
      data: { sourceImportKey: sourceCardImportKey(SHA) },
      operation: 'create',
      req: { context: {}, user: { id: 17, role: 'ai-editor' } },
    } as never);
    expect(result).not.toHaveProperty('sourceImportKey');
  });

  it('accepts a valid key only when context is bound to the same ai-editor', async () => {
    const hook = assignTrustedSourceImportKey();
    const key = sourceCardImportKey(SHA);
    const result: unknown = await hook({
      data: {},
      operation: 'create',
      req: { context: trustedSourceImportContext(key, 17), user: { id: 17, role: 'ai-editor' } },
    } as never);
    expect(result).toMatchObject({ sourceImportKey: key });

    const wrongActor: unknown = await hook({
      data: {}, operation: 'create',
      req: { context: trustedSourceImportContext(key, 18), user: { id: 17, role: 'ai-editor' } },
    } as never);
    expect(wrongActor).not.toHaveProperty('sourceImportKey');
  });

  it('keeps an existing source key immutable even when replacement context is trusted', async () => {
    const hook = assignTrustedSourceImportKey();
    const key = sourceCardImportKey(SHA);
    const result: unknown = await hook({
      data: { sourceImportKey: sourceCardImportKey('b'.repeat(64)) },
      operation: 'update', originalDoc: { sourceImportKey: key },
      req: { context: trustedSourceImportContext(sourceCardImportKey('b'.repeat(64)), 17), user: { id: 17, role: 'ai-editor' } },
    } as never);
    expect(result).toMatchObject({ sourceImportKey: key });
  });
});
