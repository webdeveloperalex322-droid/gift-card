import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { UPCOMING_HOLIDAYS_2026_09_CAMPAIGN } from './library-manifest';
import { approveGeneratedLibraryDryRun, assertGeneratedLibraryDryRunApproved } from './library-approval';
import type { GeneratedLibraryPreflightReport } from './library-preflight';

const report = { mode: 'dry-run', mutationCount: 0, blockingErrors: [], fingerprint: 'a'.repeat(64) } as unknown as GeneratedLibraryPreflightReport;

describe('generated-library dry-run approval', () => {
  it('blocks apply without a prior matching approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'library-approval-'));
    await expect(assertGeneratedLibraryDryRunApproved(root, 'ai@example.test', report.fingerprint)).rejects.toThrow(/prior approved/u);
    await approveGeneratedLibraryDryRun(root, 'ai@example.test', report);
    await expect(assertGeneratedLibraryDryRunApproved(root, 'ai@example.test', 'b'.repeat(64))).rejects.toThrow(/does not match/u);
    await expect(assertGeneratedLibraryDryRunApproved(root, 'ai@example.test', report.fingerprint)).resolves.toBeUndefined();
  });

  it('does not let an August approval authorize the upcoming-holidays campaign', async () => {
    const root = await mkdtemp(join(tmpdir(), 'library-upcoming-approval-'));
    await approveGeneratedLibraryDryRun(root, 'ai@example.test', report);

    await expect(assertGeneratedLibraryDryRunApproved(
      root, 'ai@example.test', report.fingerprint, UPCOMING_HOLIDAYS_2026_09_CAMPAIGN,
    )).rejects.toThrow(/prior approved/u);

    await approveGeneratedLibraryDryRun(root, 'ai@example.test', report, UPCOMING_HOLIDAYS_2026_09_CAMPAIGN);
    await expect(assertGeneratedLibraryDryRunApproved(
      root, 'ai@example.test', report.fingerprint, UPCOMING_HOLIDAYS_2026_09_CAMPAIGN,
    )).resolves.toBeUndefined();
  });
});
