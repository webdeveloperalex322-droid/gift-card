import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import type { GeneratedLibraryPreflightReport } from './library-preflight';

const APPROVAL_FILE = '.generated-library-dry-run-approved.json';

interface GeneratedLibraryApproval {
  readonly version: 1;
  readonly actorEmail: string;
  readonly fingerprint: string;
}

export function generatedLibraryApprovalPath(assetRoot: string): string { return resolve(assetRoot, APPROVAL_FILE); }

async function writeAtomically(path: string, value: unknown): Promise<void> {
  const temporary = resolve(dirname(path), `.${basename(path)}.${String(process.pid)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, path);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}

export async function approveGeneratedLibraryDryRun(assetRoot: string, actorEmail: string, report: GeneratedLibraryPreflightReport): Promise<void> {
  if (report.fingerprint === null || report.blockingErrors.length > 0 || report.mutationCount !== 0) {
    throw new Error('Only a clean generated-library dry-run can be approved.');
  }
  await writeAtomically(generatedLibraryApprovalPath(assetRoot), {
    version: 1, actorEmail: actorEmail.trim(), fingerprint: report.fingerprint,
  } satisfies GeneratedLibraryApproval);
}

export async function assertGeneratedLibraryDryRunApproved(assetRoot: string, actorEmail: string, fingerprint: string | null): Promise<void> {
  if (fingerprint === null) throw new Error('Generated-library apply requires a clean dry-run fingerprint.');
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(generatedLibraryApprovalPath(assetRoot), 'utf8')); }
  catch { throw new Error('Generated-library apply requires a prior approved --dry-run.'); }
  const approval = parsed as Partial<GeneratedLibraryApproval>;
  if (approval.version !== 1 || approval.actorEmail !== actorEmail.trim() || approval.fingerprint !== fingerprint) {
    throw new Error('Generated-library dry-run approval is missing or does not match current state; rerun --dry-run.');
  }
}
