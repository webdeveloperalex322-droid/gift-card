import { describe, expect, it } from 'vitest';

import {
  assertGeneratedLibraryActor,
  parseGeneratedLibraryCli,
  requireGeneratedLibraryEnvironment,
  resolveGeneratedLibraryAssetPath,
} from '../../scripts/import-generated-library';

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
});
