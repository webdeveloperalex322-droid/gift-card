import { describe, expect, it } from 'vitest';
import type { Payload } from 'payload';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertGeneratedLibraryActor,
  parseGeneratedLibraryCli,
  requireGeneratedLibraryEnvironment,
  recordOrphanedImage,
  resolveGeneratedLibraryAssetPath,
  setGeneratedCollectionRelatedWithRowLock,
  setGeneratedStatusWithRowLock,
} from '../../scripts/import-generated-library';
import type { User } from '../payload-types';

describe('generated library CLI', () => {
  it('requires exactly one explicit mode', () => {
    expect(() => parseGeneratedLibraryCli([])).toThrow(/explicit mode/u);
    expect(() => parseGeneratedLibraryCli(['--dry-run', '--apply'])).toThrow(/exactly one/u);
    expect(parseGeneratedLibraryCli(['--dry-run'])).toBe('dry-run');
    expect(parseGeneratedLibraryCli(['--apply'])).toBe('apply');
  });

  it('requires an explicit asset root and AI editor email', () => {
    expect(() => requireGeneratedLibraryEnvironment({}, 'D:/workspace')).toThrow(/GENERATED_LIBRARY_ROOT/u);
    expect(() => requireGeneratedLibraryEnvironment({ GENERATED_LIBRARY_ROOT: '.local' }, 'D:/workspace'))
      .toThrow(/AI_EDITOR_EMAIL/u);
    expect(requireGeneratedLibraryEnvironment({
      GENERATED_LIBRARY_ROOT: '.local', AI_EDITOR_EMAIL: 'ai@example.test',
    }, 'D:/workspace')).toEqual({
      assetRoot: 'D:\\workspace\\.local', actorEmail: 'ai@example.test',
    });
  });

  it('rejects an actor who is not ai-editor', () => {
    expect(() => assertGeneratedLibraryActor({ id: 1, email: 'admin@example.test', role: 'admin' }))
      .toThrow(/must have role ai-editor/u);
  });

  it('rejects a symlink or junction whose real asset escapes its package', async () => {
    const root = 'D:\\assets';
    const escaped = 'D:\\outside\\portrait.jpg';
    const fakeRealpath = (path: string) => Promise.resolve(path.endsWith('portrait.jpg') ? escaped : path);
    await expect(resolveGeneratedLibraryAssetPath(root, 'popular-top10-2026-08',
      'popular-top10-2026-08/portrait.jpg', fakeRealpath)).rejects.toThrow(/escapes package/u);
  });

  it('locks a review row and uses one transaction request for locked read and update', async () => {
    const events: string[] = [];
    const requests: unknown[] = [];
    const expected = { id: 21, sourceImportKey: 'generated-library-2026-08:collection:x', path: '/otkrytki/x',
      status: 'draft', robots: 'noindex,follow' };
    const sessions: Record<string, { db: { execute: () => Promise<void> }; resolve: () => Promise<void>; reject: () => Promise<void> }> = {};
    const payload = { db: { name: 'postgres', tableNameMap: new Map([['collections', 'collections']]),
      tables: { collections: { id: 'collections.id' } }, sessions,
      beginTransaction() { events.push('begin'); sessions.tx = { db: { execute: () => { events.push('lock'); return Promise.resolve(); } },
        resolve: () => Promise.resolve(), reject: () => Promise.resolve() }; return Promise.resolve('tx'); },
      commitTransaction() { events.push('commit'); return Promise.resolve(); },
      rollbackTransaction() { events.push('rollback'); return Promise.resolve(); } },
      findByID(input: Record<string, unknown>) { events.push('read'); requests.push(input.req); return Promise.resolve(expected); },
      update(input: Record<string, unknown>) { events.push('update'); requests.push(input.req);
        return Promise.resolve({ ...expected, status: 'review' }); } } as unknown as Payload;
    const actor = { id: 9, email: 'ai@example.test', role: 'ai-editor' } as User;
    const result = await setGeneratedStatusWithRowLock({ actor, collection: 'collections', expected, payload,
      toExisting: (doc) => doc as typeof expected });
    expect(result?.status).toBe('review');
    expect(events).toEqual(['begin', 'lock', 'read', 'update', 'commit']);
    expect(requests[0]).toBe(requests[1]);
  });

  it('persists complete orphan image identity for explicit admin cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'library-orphan-'));
    await recordOrphanedImage(root, { sourceSha256: 'a'.repeat(64), reason: 'card claim conflict',
      image: { id: 42, sourceImportKey: 'generated:image:a', revision: 'abcd1234', keyBase: 'cards/a/x',
        originalKey: 'originals/a/x.jpg', variants: [{ key: 'cards/a/x-640.webp' }] } });
    const records = JSON.parse(await readFile(join(root, 'generated-library-orphan-cleanup.json'), 'utf8')) as Array<{
      sourceSha256: string; reason: string; image: { id: number; originalKey: string };
    }>;
    expect(records[0]).toMatchObject({ sourceSha256: 'a'.repeat(64), reason: 'card claim conflict',
      image: { id: 42, originalKey: 'originals/a/x.jpg' } });
  });

  it('updates related only after a row-locked full snapshot match on the same request', async () => {
    const events: string[] = [];
    const requests: unknown[] = [];
    const timestamp = '2026-09-02T12:00:00.000Z';
    const expected = { id: 21, sourceImportKey: 'generated-library-2026-08:collection:x', path: '/otkrytki/x',
      pathClaimKey: 'claim-x', createdAt: timestamp, updatedAt: timestamp, slug: 'x', nodeKind: 'occasion',
      parentPath: null, relatedPaths: [], title: 'X', h1: 'X', metaDescription: 'X meta', intro: null,
      description: 'X description', status: 'draft', robots: 'noindex,follow' };
    const payloadDoc = { id: 21, sourceImportKey: expected.sourceImportKey, path: expected.path,
      pathClaimKey: expected.pathClaimKey, createdAt: timestamp, updatedAt: timestamp, slug: 'x', nodeKind: 'occasion',
      parent: null, related: [], title: 'X', h1: 'X', metaDescription: 'X meta', intro: null,
      description: 'X description', status: 'draft', robots: 'noindex,follow' };
    const sessions: Record<string, { db: { execute: () => Promise<void> }; resolve: () => Promise<void>; reject: () => Promise<void> }> = {};
    const payload = { db: { name: 'postgres', tableNameMap: new Map([['collections', 'collections']]),
      tables: { collections: { id: 'collections.id' } }, sessions,
      beginTransaction() { events.push('begin'); sessions.related = { db: { execute: () => { events.push('lock'); return Promise.resolve(); } },
        resolve: () => Promise.resolve(), reject: () => Promise.resolve() }; return Promise.resolve('related'); },
      commitTransaction() { events.push('commit'); return Promise.resolve(); },
      rollbackTransaction() { events.push('rollback'); return Promise.resolve(); } },
      findByID(input: Record<string, unknown>) { events.push('read'); requests.push(input.req); return Promise.resolve(payloadDoc); },
      update(input: Record<string, unknown>) { events.push('update'); requests.push(input.req);
        return Promise.resolve({ ...payloadDoc, related: [{ id: 31, path: '/otkrytki/related' }] }); } } as unknown as Payload;
    const actor = { id: 9, email: 'ai@example.test', role: 'ai-editor' } as User;
    const result = await setGeneratedCollectionRelatedWithRowLock({ actor, expected, payload, relatedIds: [31] });
    expect(result?.relatedPaths).toEqual(['/otkrytki/related']);
    expect(events).toEqual(['begin', 'lock', 'read', 'update', 'commit']);
    expect(requests[0]).toBe(requests[1]);
    payloadDoc.title = 'Manual concurrent title';
    events.length = 0;
    const refused = await setGeneratedCollectionRelatedWithRowLock({ actor, expected, payload, relatedIds: [31] });
    expect(refused).toBeNull();
    expect(events).toEqual(['begin', 'lock', 'read', 'commit']);
  });
});
