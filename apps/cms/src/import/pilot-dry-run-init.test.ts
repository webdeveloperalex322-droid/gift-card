import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  initializePilotPayloadDryRun,
  resolvePilotWorkspaceRoot,
} from '../../scripts/import-pilot-content';

const ENV_KEYS = [
  'DATABASE_URL',
  'PAYLOAD_ADMIN_PATH',
  'PAYLOAD_DB_DISABLE_CREATE',
  'PAYLOAD_DB_PUSH',
  'PAYLOAD_DROP_DATABASE',
  'PAYLOAD_SECRET',
] as const;

const previousEnvironment = new Map<string, string | undefined>();

beforeAll(() => {
  for (const key of ENV_KEYS) previousEnvironment.set(key, process.env[key]);
  process.env.DATABASE_URL = 'postgres://pilot-readonly:pilot-readonly@127.0.0.1:1/pilot-readonly';
  process.env.PAYLOAD_ADMIN_PATH = '/admin';
  process.env.PAYLOAD_SECRET = 'pilot-readonly-test-secret-with-enough-entropy';
  delete process.env.PAYLOAD_DROP_DATABASE;
});

afterAll(() => {
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('real Payload dry-run initialization boundary', () => {
  it('disables type/import-map generation, database create/push, DB connect, and onInit writes', async () => {
    const root = resolvePilotWorkspaceRoot();
    const generatedPaths = [
      join(root, 'apps/cms/src/payload-types.ts'),
      join(root, 'apps/cms/src/app/(payload)/admin/importMap.js'),
    ];
    const before = await Promise.all(generatedPaths.map((path) => readFile(path)));

    const payload = await initializePilotPayloadDryRun({
      disableDBConnect: true,
      key: `pilot-dry-run-test-${Date.now()}`,
    });

    const after = await Promise.all(generatedPaths.map((path) => readFile(path)));
    expect(after).toEqual(before);
    expect(payload.config.typescript.autoGenerate).toBe(false);
    expect(payload.config.admin.importMap.autoGenerate).toBe(false);
    expect(payload.db.push).toBe(false);
    expect(payload.db.disableCreateDatabase).toBe(true);
    expect(payload.db.pool).toBeUndefined();
  // Importing the complete Payload config is CPU-heavy under the workspace's
  // parallel Vitest run (90+ files). Focused runs take ~5 s, while the full
  // suite can exceed 15 s from worker contention without changing behavior.
  }, 30_000);
});
