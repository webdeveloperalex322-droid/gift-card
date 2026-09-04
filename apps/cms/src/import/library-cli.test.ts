import { describe, expect, it } from 'vitest';
import type { Payload } from 'payload';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertGeneratedLibraryActor,
  createPayloadGeneratedLibraryStore,
  parseGeneratedLibraryCli,
  parseGeneratedLibraryImportCli,
  requireGeneratedLibraryEnvironment,
  recordOrphanedImage,
  resolveGeneratedLibraryAssetPath,
  setGeneratedCollectionRelatedWithRowLock,
  setGeneratedStatusWithRowLock,
} from '../../scripts/import-generated-library';
import type { GeneratedCardSeed } from './library-seeds';
import type { User } from '../payload-types';

describe('generated library CLI', () => {
  it('requires exactly one explicit mode', () => {
    expect(() => parseGeneratedLibraryCli([])).toThrow(/explicit mode/u);
    expect(() => parseGeneratedLibraryCli(['--dry-run', '--apply'])).toThrow(/exactly one/u);
    expect(parseGeneratedLibraryCli(['--dry-run'])).toBe('dry-run');
    expect(parseGeneratedLibraryCli(['--apply'])).toBe('apply');
  });

  it('selects the isolated upcoming package, approval, and report configuration', () => {
    const upcoming = parseGeneratedLibraryImportCli(['--campaign', 'upcoming-holidays-2026-09', '--dry-run']);
    const august = parseGeneratedLibraryImportCli(['--apply']);

    expect(upcoming).toMatchObject({
      mode: 'dry-run',
      campaign: {
        packageNames: ['upcoming-holidays-2026-09'],
        approvalFile: '.upcoming-holidays-2026-09-dry-run-approved.json',
        reportFile: 'upcoming-holidays-2026-09-import-report.json',
      },
    });
    expect(august).toMatchObject({
      mode: 'apply',
      campaign: {
        packageNames: ['pilot-2026-08', 'popular-top10-2026-08', 'popular-next10-2026-08', 'soviet-holidays-2026-08'],
        approvalFile: '.generated-library-dry-run-approved.json',
        reportFile: 'generated-library-import-report.json',
      },
    });
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

  it('reads protected image storage fields internally without bypassing the ai-editor upload mutation', async () => {
    const sourceSha256 = 'a'.repeat(64);
    const image = {
      id: 42,
      sourceImportKey: `generated-library-2026-08:image:${sourceSha256}`,
      revision: 'abcd1234',
      keyBase: 'cards/abcd1234/test-image',
      originalKey: 'originals/0123456789abcdef0123456789abcdef.jpg',
      variants: [{ key: 'cards/abcd1234/test-image-640.webp' }],
    };
    const actor = { id: 9, email: 'ai@example.test', role: 'ai-editor' } as User;
    const creates: Array<Record<string, unknown>> = [];
    const payload = {
      find(input: Record<string, unknown>) {
        if (input.collection === 'users') return Promise.resolve({ docs: [actor] });
        if (input.collection === 'card-images') {
          return Promise.resolve({ docs: [input.overrideAccess === true ? image : { ...image, originalKey: undefined }] });
        }
        return Promise.resolve({ docs: [] });
      },
      findByID(input: Record<string, unknown>) {
        return Promise.resolve(input.overrideAccess === true ? image : { ...image, originalKey: undefined });
      },
      create(input: Record<string, unknown>) {
        creates.push(input);
        return Promise.resolve({ ...image, originalKey: undefined });
      },
    } as unknown as Payload;
    const store = createPayloadGeneratedLibraryStore(payload, actor.email);
    await store.findActor(actor.email);

    const existing = await store.findImageBySourceKey(image.sourceImportKey);
    expect(existing?.originalKey).toBe(image.originalKey);

    const seed: GeneratedCardSeed = {
      sourceSha256,
      sourceFile: 'portrait.jpg',
      sourcePng: 'source.png',
      squareFile: 'square.jpg',
      slug: 'test-card',
      title: 'Test card',
      h1: 'Test card',
      metaDescription: 'Test card meta description',
      alt: 'Test image',
      caption: 'Test caption',
      description: 'Test description',
      usageTerms: '',
      collectionPath: '/otkrytki/prazdniki/test',
      status: 'draft',
      robots: 'noindex,follow',
    };
    const created = await store.createImage(seed, Buffer.from('jpeg'));
    expect(created.originalKey).toBe(image.originalKey);
    expect(creates).toHaveLength(1);
    expect(creates[0]?.overrideAccess).toBe(false);
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
