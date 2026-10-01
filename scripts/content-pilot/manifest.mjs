import { readFile, writeFile } from 'node:fs/promises';

const filenamePattern = /^[a-z0-9-]+\.jpg$/;
const statuses = new Set(['planned', 'generated', 'accepted', 'rejected']);
const textTones = new Set(['dark', 'light']);

/**
 * @typedef {{
 *   id: string,
 *   theme: string,
 *   fileName: string,
 *   headline: string,
 *   wish: string,
 *   alt: string,
 *   scenePrompt: string,
 *   commonPrompt: string,
 *   textTone: 'dark' | 'light',
 *   status: 'planned' | 'generated' | 'accepted' | 'rejected',
 *   backgroundPath: string,
 *   finalPath: string
 * }} CardRecord
 */

/** @param {string} path @returns {Promise<CardRecord[]>} */
export async function loadManifest(path) {
  /** @type {unknown} */
  const records = JSON.parse(await readFile(path, 'utf8'));
  if (!isValidManifest(records)) throw new Error(validateManifest(records).join('\n'));
  return records;
}

/** @param {unknown} records */
export function validateManifest(records) {
  const errors = [];
  if (!Array.isArray(records) || records.length !== 50) {
    errors.push('Manifest must contain exactly 50 records.');
    return errors;
  }

  const ids = records.map((record) => record?.id);
  const expectedIds = Array.from({ length: 50 }, (_, index) => String(index + 1).padStart(2, '0'));
  if (new Set(ids).size !== 50 || expectedIds.some((id) => !ids.includes(id))) {
    errors.push('Manifest IDs must be unique and range from 01 through 50.');
  }

  const names = records.map((record) => record?.fileName);
  if (new Set(names).size !== 50) errors.push('Manifest file names must be unique.');
  for (const record of records) {
    if (record === null || typeof record !== 'object') {
      errors.push('Manifest records must be objects.');
      continue;
    }
    const id = typeof record.id === 'string' ? record.id : 'unknown';
    if (typeof record.fileName !== 'string' || !filenamePattern.test(record.fileName) || record.fileName.length > 68) {
      errors.push(`Invalid file name for ${id}.`);
    }
    for (const field of ['theme', 'headline', 'wish', 'alt', 'scenePrompt', 'commonPrompt', 'textTone', 'backgroundPath', 'finalPath']) {
      if (typeof record[field] !== 'string' || record[field].trim() === '') {
        errors.push(`Missing ${field} for ${id}.`);
      }
    }
    if (!textTones.has(record.textTone)) errors.push(`Invalid text tone for ${id}.`);
    if (!statuses.has(record.status)) errors.push(`Invalid status for ${id}.`);
  }

  const themeCounts = records.reduce((counts, record) => {
    const theme = record?.theme;
    counts.set(theme, (counts.get(theme) ?? 0) + 1);
    return counts;
  }, new Map());
  if (themeCounts.size !== 10 || [...themeCounts.values()].some((count) => count !== 5)) {
    errors.push('Manifest must contain five records for each of ten themes.');
  }
  return errors;
}

/** @param {unknown} records @returns {records is CardRecord[]} */
export function isValidManifest(records) {
  return validateManifest(records).length === 0;
}

/** @param {CardRecord[]} records @param {string} path */
export async function writeManifestCsv(records, path) {
  const headers = ['id', 'theme', 'fileName', 'headline', 'wish', 'alt', 'scenePrompt', 'commonPrompt', 'textTone', 'status', 'backgroundPath', 'finalPath'];
  const escape = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const csv = [headers, ...records.map((record) => headers.map((header) => escape(record[header])).join(','))]
    .map((row) => Array.isArray(row) ? row.map(escape).join(',') : row)
    .join('\r\n') + '\r\n';
  await writeFile(path, csv, 'utf8');
}

if (process.argv.includes('--write-csv')) {
  const manifestPath = 'content/pilot-2026-08/manifest.json';
  const records = await loadManifest(manifestPath);
  const errors = validateManifest(records);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  await writeManifestCsv(records, 'content/pilot-2026-08/manifest.csv');
}
