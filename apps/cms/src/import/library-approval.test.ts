import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
});
