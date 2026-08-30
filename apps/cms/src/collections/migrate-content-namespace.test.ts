import { describe, expect, it } from 'vitest';

import {
  assertNoPublishedLegacyCollections,
  migrationMode,
  topLevelLegacyCollectionIds,
} from '../../scripts/migrate-content-namespace';

describe('migrate-content-namespace: безопасный режим запуска', () => {
  it('по умолчанию и с --dry-run только планирует; меняет данные лишь --apply', () => {
    expect(migrationMode([])).toBe('dry-run');
    expect(migrationMode(['--dry-run'])).toBe('dry-run');
    expect(migrationMode(['--apply'])).toBe('apply');
    expect(() => migrationMode(['--apply', '--dry-run'])).toThrow(/один режим/i);
    expect(() => migrationMode(['--force'])).toThrow(/неизвест/i);
  });

  it('останавливается и перечисляет опубликованные URL /podborki', () => {
    expect(() =>
      assertNoPublishedLegacyCollections([
        {
          id: 7,
          path: '/podborki/prazdniki/8-marta',
          status: 'published',
          title: '8 марта',
        },
      ]),
    ).toThrow(/7.*8 марта.*\/podborki\/prazdniki\/8-marta/i);
  });

  it('для пересборки выбирает только draft/review верхнего уровня старого namespace', () => {
    expect(
      topLevelLegacyCollectionIds([
        { id: 1, parent: null, path: '/podborki/prazdniki', status: 'draft' },
        { id: 2, path: '/podborki/adresaty', status: 'review' },
        { id: 3, parent: 1, path: '/podborki/prazdniki/8-marta', status: 'draft' },
        { id: 4, parent: null, path: '/otkrytki/uzhe', status: 'draft' },
        { id: 5, parent: null, path: '/podborki/opublikovano', status: 'published' },
      ]),
    ).toEqual([1, 2]);
  });
});
