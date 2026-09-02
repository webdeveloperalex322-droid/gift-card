import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { computePerceptualHash, hammingDistance } from '@otkritka/images';
import { loadManifest, validateManifest } from './manifest.mjs';

const BACKGROUND_DIMENSIONS = { width: 1024, height: 1280 };
const FINAL_DIMENSIONS = { width: 1024, height: 1280 };
const SIMILARITY_THRESHOLD = 14;

function hasPath(path) {
  return access(path, constants.F_OK).then(() => true).catch(() => false);
}

function stageRequirements(stage) {
  if (stage === 'backgrounds') {
    return {
      pathField: 'backgroundPath',
      expectedFormat: 'png',
      dimensions: BACKGROUND_DIMENSIONS,
      exactDimensions: false,
    };
  }
  if (stage === 'finals' || stage === 'accepted') {
    return {
      pathField: 'finalPath',
      expectedFormat: 'jpeg',
      dimensions: FINAL_DIMENSIONS,
      exactDimensions: true,
    };
  }
  throw new Error(`Unknown validation stage: ${stage}.`);
}

function createReport(stage, checkedCount, acceptedCount) {
  return {
    stage,
    checkedCount,
    acceptedCount,
    missingFiles: [],
    formatErrors: [],
    dimensionErrors: [],
    hashErrors: [],
    similarPairs: [],
    autoRejectedIds: [],
    blockingErrors: [],
  };
}

function isDimensionError(metadata, dimensions, exactDimensions) {
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  return exactDimensions
    ? width !== dimensions.width || height !== dimensions.height
    : width < dimensions.width || height < dimensions.height;
}

function addBlockingErrors(report) {
  for (const item of report.missingFiles) report.blockingErrors.push(`Missing file for ${item.id}: ${item.path}.`);
  for (const item of report.formatErrors) report.blockingErrors.push(`Invalid format for ${item.id}: expected ${item.expected}, received ${item.actual}.`);
  for (const item of report.dimensionErrors) report.blockingErrors.push(`Invalid dimensions for ${item.id}: expected ${item.expected}, received ${item.actual}.`);
  for (const item of report.hashErrors) report.blockingErrors.push(`Could not compute pHash for ${item.id}: ${item.message}`);
}

/**
 * Validates all selected pilot image files and reports pHash similarity as a manual-review signal.
 * @param {Array<Record<string, unknown>>} records
 * @param {'backgrounds' | 'finals' | 'accepted'} stage
 */
export async function validatePilot(records, stage) {
  const requirements = stageRequirements(stage);
  const acceptedRecords = records.filter((record) => record?.status === 'accepted');
  const selectedRecords = stage === 'accepted' ? acceptedRecords : records;
  const report = createReport(stage, selectedRecords.length, acceptedRecords.length);
  const hashes = [];

  if (stage === 'accepted' && acceptedRecords.length !== 50) {
    report.blockingErrors.push(`Accepted stage requires exactly 50 accepted records; received ${acceptedRecords.length}.`);
  }

  for (const record of selectedRecords) {
    const id = typeof record?.id === 'string' ? record.id : 'unknown';
    const pathValue = record?.[requirements.pathField];
    if (typeof pathValue !== 'string' || pathValue.length === 0) {
      report.missingFiles.push({ id, path: String(pathValue ?? '') });
      continue;
    }

    const path = resolve(pathValue);
    if (!await hasPath(path)) {
      report.missingFiles.push({ id, path: pathValue });
      continue;
    }

    let metadata;
    try {
      metadata = await sharp(path).metadata();
    } catch {
      report.formatErrors.push({ id, path: pathValue, expected: requirements.expectedFormat, actual: 'unreadable' });
      continue;
    }

    const actualFormat = metadata.format ?? 'unknown';
    if (actualFormat !== requirements.expectedFormat) {
      report.formatErrors.push({ id, path: pathValue, expected: requirements.expectedFormat, actual: actualFormat });
    }
    if (isDimensionError(metadata, requirements.dimensions, requirements.exactDimensions)) {
      report.dimensionErrors.push({
        id,
        path: pathValue,
        expected: requirements.exactDimensions
          ? `${requirements.dimensions.width}x${requirements.dimensions.height}`
          : `at least ${requirements.dimensions.width}x${requirements.dimensions.height}`,
        actual: `${metadata.width ?? 0}x${metadata.height ?? 0}`,
      });
    }

    if (stage !== 'backgrounds') {
      try {
        hashes.push({ id, theme: typeof record?.theme === 'string' ? record.theme : '', hash: await computePerceptualHash(path) });
      } catch (error) {
        report.hashErrors.push({ id, path: pathValue, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  for (let leftIndex = 0; leftIndex < hashes.length; leftIndex += 1) {
    const left = hashes[leftIndex];
    for (const right of hashes.slice(leftIndex + 1)) {
      if (left.theme !== right.theme) continue;
      const distance = hammingDistance(left.hash, right.hash);
      if (distance < SIMILARITY_THRESHOLD) {
        report.similarPairs.push({ left: left.id, right: right.id, theme: left.theme, distance });
      }
    }
  }

  addBlockingErrors(report);
  return report;
}

/** @param {object} report @param {string} path */
export async function writeQaReport(report, path) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}

function parseStage(args) {
  const index = args.indexOf('--stage');
  if (index === -1) return 'finals';
  const stage = args[index + 1];
  if (!stage) throw new Error('--stage requires backgrounds, finals, or accepted.');
  return stage;
}

async function runCli() {
  const records = await loadManifest('content/pilot-2026-08/manifest.json');
  const manifestErrors = validateManifest(records);
  if (manifestErrors.length > 0) throw new Error(manifestErrors.join('\n'));
  const report = await validatePilot(records, parseStage(process.argv.slice(2)));
  await writeQaReport(report, 'content/pilot-2026-08/qa-report.json');
  if (report.blockingErrors.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
