import type { Payload } from 'payload';
import { describe, expect, it, vi } from 'vitest';

import {
  assertNoPublishedLegacyCollections,
  migrationMode,
  runContentNamespaceMigration,
  topLevelLegacyCollectionIds,
} from '../../scripts/migrate-content-namespace';

function migrationPayloadStand(input: {
  readonly cards?: readonly Record<string, unknown>[];
  readonly claims?: readonly Record<string, unknown>[];
  readonly collections?: readonly Record<string, unknown>[];
}): { readonly payload: Payload; readonly reads: string[]; readonly updates: unknown[] } {
  const reads: string[] = [];
  const updates: unknown[] = [];
  const byCollection = {
    cards: [...(input.cards ?? [])],
    collections: [...(input.collections ?? [])],
    'content-path-claims': [...(input.claims ?? [])],
  };
  const payload = {
    find: ({ collection }: { collection: keyof typeof byCollection }) => {
      reads.push(collection);
      return Promise.resolve({
        docs: byCollection[collection],
        hasNextPage: false,
      });
    },
    update: (args: unknown) => {
      updates.push(args);
      return Promise.resolve({});
    },
  } as unknown as Payload;
  return { payload, reads, updates };
}

describe('migrate-content-namespace: безопасный режим запуска', () => {
  it('по умолчанию и с --dry-run только планирует; меняет данные лишь --apply', () => {
    expect(migrationMode([])).toBe('dry-run');
    expect(migrationMode(['--dry-run'])).toBe('dry-run');
    expect(migrationMode(['--apply'])).toBe('apply');
    expect(() => migrationMode(['--apply', '--dry-run'])).toThrow(/один режим/i);
    expect(() => migrationMode(['--force'])).toThrow(/неизвест/i);
  });

  it('path lock вычисляет будущий путь и блокирует legacy URL по publishedAt независимо от статуса', () => {
    expect(() =>
      assertNoPublishedLegacyCollections([
        {
          id: 7,
          path: '/podborki/prazdniki/8-marta',
          publishedAt: '2026-03-08T00:00:00.000Z',
          status: 'draft',
          title: '8 марта',
        },
      ]),
    ).toThrow(/7.*8 марта.*\/podborki\/prazdniki\/8-marta.*\/otkrytki\/prazdniki\/8-marta/i);
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

  it('dry-run читает permanent claims и останавливается на foreign owner до update', async () => {
    const stand = migrationPayloadStand({
      cards: [{ id: 10, pathClaimKey: 'card-key', slug: 'prazdniki' }],
      claims: [
        {
          ownerCollection: 'collections',
          ownerKey: 'collections:other-key',
          path: '/otkrytki/prazdniki',
        },
      ],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(runContentNamespaceMigration(stand.payload, 'dry-run')).rejects.toThrow(
      /otkrytki\/prazdniki.*collections:other-key/i,
    );
    expect(stand.reads).toContain('content-path-claims');
    expect(stand.updates).toEqual([]);
    log.mockRestore();
  });

  it('повторный dry-run после partial apply принимает claim того же stable owner key', async () => {
    const stand = migrationPayloadStand({
      cards: [{ id: 10, pathClaimKey: 'card-key', slug: 'piony' }],
      claims: [
        {
          ownerCollection: 'cards',
          ownerKey: 'cards:card-key',
          path: '/otkrytki/piony',
        },
      ],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(runContentNamespaceMigration(stand.payload, 'dry-run')).resolves.toBeUndefined();
    expect(stand.reads).toContain('content-path-claims');
    expect(stand.updates).toEqual([]);
    log.mockRestore();
  });
});
