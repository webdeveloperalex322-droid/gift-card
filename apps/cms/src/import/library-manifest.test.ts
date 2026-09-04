/* eslint-disable @typescript-eslint/require-await -- Byte-reader fakes implement an async filesystem boundary. */
import { describe, expect, it } from 'vitest';

import {
  GENERATED_LIBRARY_DEFAULT_CAMPAIGN,
  UPCOMING_HOLIDAYS_2026_09_CAMPAIGN,
  planGeneratedLibrary,
} from './library-manifest';

const bytes = new Map<string, Buffer>([
  ['pilot.png', Buffer.from('pilot-shared')],
  ['popular-pilot.png', Buffer.from('pilot-shared')],
  ['popular.png', Buffer.from('popular')],
  ['soviet.png', Buffer.from('soviet')],
]);

function row(id: string, theme: string, backgroundPath: string, finalPath: string) {
  return { id, theme, backgroundPath, finalPath, headline: `Headline ${id}`, wish: `Wish ${id}`, alt: `Alt ${id}` };
}

describe('generated library manifest planner', () => {
  it('collapses repeated sources and keeps pilot then popular package priority', async () => {
    const plan = await planGeneratedLibrary({
      packages: [
        { name: 'soviet-holidays-2026-08', rows: [row('s1', 'Новый год', 'soviet.png', 'soviet.jpg')] },
        { name: 'popular-top10-2026-08', rows: [
          row('t2', 'Новый год', 'soviet.png', 'popular-soviet.jpg'),
          row('t1', 'День рождения женщине', 'popular-pilot.png', 'popular-pilot.jpg'),
          row('t3', 'Новый год', 'popular.png', 'popular.jpg'),
        ] },
        { name: 'pilot-2026-08', rows: [row('01', 'День рождения женщине', 'pilot.png', 'pilot.jpg')] },
        { name: 'popular-next10-2026-08', rows: [] },
      ],
      readBytes: async (path) => bytes.get(path) ?? Buffer.from(path),
      expected: { sourceRows: 5, uniqueSources: 3, pilotRows: 1, pilotRepeatedOutside: 1, sovietRepeatedInPopular: 1, creationCandidates: 2 },
    });

    expect(plan.uniqueSourceCount).toBe(3);
    expect(plan.creationCandidates).toHaveLength(2);
    expect(plan.aliases).toEqual(expect.arrayContaining([
      expect.objectContaining({ package: 'popular-top10-2026-08', representativePackage: 'pilot-2026-08' }),
      expect.objectContaining({ package: 'soviet-holidays-2026-08', representativePackage: 'popular-top10-2026-08' }),
    ]));
    expect(plan.groups.map((group) => group.representative.package)).toEqual([
      'pilot-2026-08',
      'popular-top10-2026-08',
      'popular-top10-2026-08',
    ]);
  });

  it('selects a representative independently of package input ordering', async () => {
    const packages = [
      { name: 'pilot-2026-08' as const, rows: [row('01', 'Новый год', 'pilot.png', 'pilot.jpg')] },
      { name: 'popular-top10-2026-08' as const, rows: [row('02', 'Новый год', 'popular-pilot.png', 'popular.jpg')] },
      { name: 'popular-next10-2026-08' as const, rows: [] },
      { name: 'soviet-holidays-2026-08' as const, rows: [] },
    ];
    const input = {
      readBytes: async (path: string) => bytes.get(path) ?? Buffer.from(path),
      expected: { sourceRows: 2, uniqueSources: 1, pilotRows: 1, pilotRepeatedOutside: 1, sovietRepeatedInPopular: 0, creationCandidates: 0 },
    };

    const first = await planGeneratedLibrary({ ...input, packages });
    const second = await planGeneratedLibrary({ ...input, packages: [...packages].reverse() });
    expect(first.groups[0]?.representative.package).toBe('pilot-2026-08');
    expect(second.groups[0]?.representative.package).toBe('pilot-2026-08');
  });

  it('fails closed when declared library invariants drift', async () => {
    await expect(planGeneratedLibrary({
      packages: [
        { name: 'pilot-2026-08', rows: [row('01', 'Новый год', 'pilot.png', 'pilot.jpg')] },
        { name: 'popular-top10-2026-08', rows: [] },
        { name: 'popular-next10-2026-08', rows: [] },
        { name: 'soviet-holidays-2026-08', rows: [] },
      ],
      readBytes: async (path) => bytes.get(path) ?? Buffer.from(path),
      expected: { sourceRows: 1150, uniqueSources: 1021, pilotRows: 50, pilotRepeatedOutside: 49, sovietRepeatedInPopular: 80, creationCandidates: 971 },
    })).rejects.toThrow(/source rows: expected 1150, received 1/u);
  });

  it('hashes source files sequentially instead of retaining the whole library in flight', async () => {
    let active = 0;
    let maximum = 0;
    const sourceRows = ['one', 'two', 'three'].map((id) => row(id, 'Новый год', `${id}.png`, `${id}.jpg`));
    await planGeneratedLibrary({
      packages: [
        { name: 'pilot-2026-08', rows: [] },
        { name: 'popular-top10-2026-08', rows: sourceRows },
        { name: 'popular-next10-2026-08', rows: [] },
        { name: 'soviet-holidays-2026-08', rows: [] },
      ],
      readBytes: async (path) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return Buffer.from(path);
      },
      expected: { sourceRows: 3, uniqueSources: 3, pilotRows: 0, pilotRepeatedOutside: 0, sovietRepeatedInPopular: 0, creationCandidates: 3 },
    });
    expect(maximum).toBe(1);
  });

  it('plans the isolated upcoming-holidays campaign without weakening the August package requirement', async () => {
    const rows = Array.from({ length: 212 }, (_, index) => row(
      `upcoming-${String(index + 1)}`,
      'День воспитателя',
      `upcoming-${String(index + 1)}.png`,
      `upcoming-${String(index + 1)}.jpg`,
    ));
    const input = {
      packages: [{ name: 'upcoming-holidays-2026-09' as const, rows }],
      readBytes: async (path: string) => Buffer.from(path),
      expected: UPCOMING_HOLIDAYS_2026_09_CAMPAIGN.expected,
    };

    await expect(planGeneratedLibrary(input)).rejects.toThrow(/Missing generated library packages/u);
    const plan = await planGeneratedLibrary({ ...input, campaign: UPCOMING_HOLIDAYS_2026_09_CAMPAIGN });

    expect(UPCOMING_HOLIDAYS_2026_09_CAMPAIGN.packageNames).toEqual(['upcoming-holidays-2026-09']);
    expect(UPCOMING_HOLIDAYS_2026_09_CAMPAIGN.expected).toEqual({
      sourceRows: 212,
      uniqueSources: 212,
      pilotRows: 0,
      pilotRepeatedOutside: 0,
      sovietRepeatedInPopular: 0,
      creationCandidates: 212,
    });
    expect(plan.creationCandidates).toHaveLength(212);
    expect(GENERATED_LIBRARY_DEFAULT_CAMPAIGN.packageNames).toHaveLength(4);
  });
});
