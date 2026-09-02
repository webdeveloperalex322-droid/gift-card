import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  loadManifest,
  validateManifest,
} from '../../scripts/content-pilot/manifest.mjs';
import { validatePilot } from '../../scripts/content-pilot/validate.mjs';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('content pilot manifest', () => {
  it('contains exactly 50 unique approved card definitions', async () => {
    const records = await loadManifest('content/pilot-2026-08/manifest.json');
    expect(records).toHaveLength(50);
    expect(new Set(records.map((item) => item.id)).size).toBe(50);
    expect(new Set(records.map((item) => item.fileName)).size).toBe(50);
    expect(records.every((item) => item.status === 'accepted')).toBe(true);
    expect(validateManifest(records)).toEqual([]);
  });

  it('contains five records for each of ten themes', async () => {
    const records = await loadManifest('content/pilot-2026-08/manifest.json');
    const counts = records.reduce<Record<string, number>>((result, item) => {
      result[item.theme] = (result[item.theme] ?? 0) + 1;
      return result;
    }, {});
    expect(Object.keys(counts)).toHaveLength(10);
    expect(Object.values(counts)).toEqual(Array(10).fill(5));
  });

  it('keeps the approved copy and prompts unchanged', async () => {
    const records = await loadManifest('content/pilot-2026-08/manifest.json');
    const checksum = createHash('sha256').update(JSON.stringify(records)).digest('hex');
    expect(checksum).toBe('2e9e012cd70f9b7cfe8ad3199a9dd48b8adc319b304c0e59fc94b4a985a129a2');
  });

  it('rejects unvalidated JSON with an unsupported text tone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otkritka-pilot-manifest-'));
    temporaryPaths.push(directory);
    const records = await loadManifest('content/pilot-2026-08/manifest.json');
    const malformed = structuredClone(records).map<Record<string, unknown>>((record) => ({ ...record }));
    const [first] = malformed;
    if (!first) throw new Error('Expected a pilot record.');
    first.textTone = 'blue';
    const manifestPath = join(directory, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(malformed), 'utf8');

    await expect(loadManifest(manifestPath)).rejects.toThrow('Invalid text tone for 01.');
  });

  it('returns errors for malformed or incomplete records', async () => {
    expect(validateManifest([{ id: '01' }])).not.toEqual([]);
    expect(validateManifest([null])).not.toEqual([]);
    const records = await loadManifest('content/pilot-2026-08/manifest.json');
    const incomplete = structuredClone(records).map<Record<string, unknown>>((record) => ({ ...record }));
    const [first, second, third, fourth] = incomplete;
    if (!first || !second || !third || !fourth) throw new Error('Expected four pilot records.');
    delete first.textTone;
    delete second.backgroundPath;
    delete third.finalPath;
    fourth.fileName = null;
    expect(validateManifest(incomplete)).toEqual(expect.arrayContaining([
      'Missing textTone for 01.',
      'Missing backgroundPath for 02.',
      'Missing finalPath for 03.',
      'Invalid file name for 04.',
    ]));
  });
});

describe('content pilot validation', () => {
  it('builds the images package before the public validation command', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['content:pilot:validate'])
      .toBe('tsc -b --force packages/images && node scripts/content-pilot/validate.mjs');
  });

  it('requires PNG backgrounds at least 1024 by 1280 pixels', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otkritka-pilot-background-validation-'));
    temporaryPaths.push(directory);
    const undersized = join(directory, 'undersized.png');
    const wrongFormat = join(directory, 'wrong-format.jpg');
    await sharp({
      create: { width: 1023, height: 1280, channels: 3, background: '#efe0d2' },
    }).png().toFile(undersized);
    await sharp({
      create: { width: 1024, height: 1280, channels: 3, background: '#efe0d2' },
    }).jpeg().toFile(wrongFormat);

    const report = await validatePilot([
      { id: '01', theme: 'Тема', status: 'generated', backgroundPath: undersized },
      { id: '02', theme: 'Тема', status: 'generated', backgroundPath: wrongFormat },
    ], 'backgrounds');

    expect(report.dimensionErrors).toContainEqual(expect.objectContaining({ id: '01' }));
    expect(report.formatErrors).toContainEqual(expect.objectContaining({ id: '02', actual: 'jpeg' }));
  });

  it('flags dimensions and close perceptual hashes without auto-rejecting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otkritka-pilot-validation-'));
    temporaryPaths.push(directory);
    const correctFinal = join(directory, 'correct.jpg');
    const narrowFinal = join(directory, 'narrow.jpg');
    const duplicateFinal = join(directory, 'duplicate.jpg');
    const source = await sharp({
      create: { width: 1024, height: 1280, channels: 3, background: '#2f5f84' },
    }).jpeg().toBuffer();
    await writeFile(correctFinal, source);
    await writeFile(duplicateFinal, source);
    await sharp({
      create: { width: 1023, height: 1280, channels: 3, background: '#bf8b6e' },
    }).jpeg().toFile(narrowFinal);
    const fixtures = [
      { id: '01', theme: 'Тема A', status: 'generated', finalPath: correctFinal },
      { id: '02', theme: 'Тема A', status: 'generated', finalPath: narrowFinal },
      { id: '03', theme: 'Тема B', status: 'generated', finalPath: correctFinal },
      { id: '04', theme: 'Тема B', status: 'generated', finalPath: duplicateFinal },
    ];

    const report = await validatePilot(fixtures, 'finals');

    expect(report.dimensionErrors).toContainEqual(expect.objectContaining({ id: '02' }));
    const similarPair = report.similarPairs.find(
      (pair) => pair.left === '03' && pair.right === '04',
    );
    expect(similarPair).toBeDefined();
    expect(similarPair?.distance).toBeTypeOf('number');
    expect(report.autoRejectedIds).toEqual([]);
  });

  it('requires exactly fifty accepted records at the accepted stage', async () => {
    const report = await validatePilot([
      { id: '01', theme: 'Тема', status: 'accepted', finalPath: join(tmpdir(), 'missing.jpg') },
    ], 'accepted');

    expect(report.acceptedCount).toBe(1);
    expect(report.blockingErrors).toContain('Accepted stage requires exactly 50 accepted records; received 1.');
  });
});
