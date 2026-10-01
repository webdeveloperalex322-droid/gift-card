import { createHash } from 'node:crypto';

export const GENERATED_LIBRARY_PACKAGES = [
  'pilot-2026-08',
  'popular-top10-2026-08',
  'popular-next10-2026-08',
  'soviet-holidays-2026-08',
] as const;

export const UPCOMING_HOLIDAYS_2026_09_PACKAGES = ['upcoming-holidays-2026-09'] as const;

export type GeneratedLibraryPackageName =
  | typeof GENERATED_LIBRARY_PACKAGES[number]
  | typeof UPCOMING_HOLIDAYS_2026_09_PACKAGES[number];

export interface GeneratedManifestRowInput {
  readonly id: string;
  readonly theme: string;
  readonly backgroundPath: string;
  readonly finalPath: string;
  readonly squarePath?: string;
  readonly fileName?: string;
  readonly headline: string;
  readonly wish: string;
  readonly alt: string;
  readonly [key: string]: unknown;
}

export interface GeneratedManifestPackage {
  readonly name: GeneratedLibraryPackageName;
  readonly rows: readonly GeneratedManifestRowInput[];
}

export interface GeneratedLibraryExpectedCounts {
  readonly sourceRows: number;
  readonly uniqueSources: number;
  readonly pilotRows: number;
  readonly pilotRepeatedOutside: number;
  readonly sovietRepeatedInPopular: number;
  readonly creationCandidates: number;
}

export interface GeneratedLibraryCampaign {
  readonly name: 'generated-library-2026-08' | 'upcoming-holidays-2026-09';
  readonly packageNames: readonly GeneratedLibraryPackageName[];
  readonly expected: GeneratedLibraryExpectedCounts;
  readonly approvalFile: string;
  readonly reportFile: string;
  readonly requiresSquarePath: boolean;
}

export const GENERATED_LIBRARY_DEFAULT_CAMPAIGN: GeneratedLibraryCampaign = {
  name: 'generated-library-2026-08',
  packageNames: GENERATED_LIBRARY_PACKAGES,
  expected: {
    sourceRows: 1150,
    uniqueSources: 1021,
    pilotRows: 50,
    pilotRepeatedOutside: 49,
    sovietRepeatedInPopular: 80,
    creationCandidates: 971,
  },
  approvalFile: '.generated-library-dry-run-approved.json',
  reportFile: 'generated-library-import-report.json',
  requiresSquarePath: false,
};

export const UPCOMING_HOLIDAYS_2026_09_CAMPAIGN: GeneratedLibraryCampaign = {
  name: 'upcoming-holidays-2026-09',
  packageNames: UPCOMING_HOLIDAYS_2026_09_PACKAGES,
  expected: {
    sourceRows: 212,
    uniqueSources: 212,
    pilotRows: 0,
    pilotRepeatedOutside: 0,
    sovietRepeatedInPopular: 0,
    creationCandidates: 212,
  },
  approvalFile: '.upcoming-holidays-2026-09-dry-run-approved.json',
  reportFile: 'upcoming-holidays-2026-09-import-report.json',
  requiresSquarePath: true,
};

export const GENERATED_LIBRARY_CAMPAIGNS = [
  GENERATED_LIBRARY_DEFAULT_CAMPAIGN,
  UPCOMING_HOLIDAYS_2026_09_CAMPAIGN,
] as const;

export function generatedLibraryCampaignForName(name: string): GeneratedLibraryCampaign {
  const campaign = GENERATED_LIBRARY_CAMPAIGNS.find((candidate) => candidate.name === name);
  if (campaign === undefined) throw new Error(`Unknown generated-library campaign: ${name}.`);
  return campaign;
}

export interface GeneratedLibraryInput {
  readonly packages: readonly GeneratedManifestPackage[];
  readonly readBytes: (path: string) => Promise<Uint8Array>;
  readonly expected: GeneratedLibraryExpectedCounts;
  readonly campaign?: GeneratedLibraryCampaign;
}

export interface NormalizedGeneratedManifestRow extends GeneratedManifestRowInput {
  readonly package: GeneratedLibraryPackageName;
  readonly manifestOrder: number;
  readonly sourceSha256: string;
}

export interface GeneratedLibraryAlias {
  readonly package: GeneratedLibraryPackageName;
  readonly id: string;
  readonly sourceSha256: string;
  readonly representativePackage: GeneratedLibraryPackageName;
  readonly representativeId: string;
}

export interface GeneratedLibraryGroup {
  readonly sourceSha256: string;
  readonly representative: NormalizedGeneratedManifestRow;
  readonly rows: readonly NormalizedGeneratedManifestRow[];
}

export interface GeneratedLibraryPlan {
  readonly rows: readonly NormalizedGeneratedManifestRow[];
  readonly groups: readonly GeneratedLibraryGroup[];
  readonly aliases: readonly GeneratedLibraryAlias[];
  readonly creationCandidates: readonly GeneratedLibraryGroup[];
  readonly sourceRowCount: number;
  readonly uniqueSourceCount: number;
  readonly pilotRowCount: number;
  readonly pilotRepeatedOutsideCount: number;
  readonly sovietRepeatedInPopularCount: number;
}

const PRIORITY: Readonly<Record<GeneratedLibraryPackageName, number>> = {
  'pilot-2026-08': 0,
  'popular-top10-2026-08': 1,
  'popular-next10-2026-08': 2,
  'soviet-holidays-2026-08': 3,
  'upcoming-holidays-2026-09': 4,
};

function compareRows(left: NormalizedGeneratedManifestRow, right: NormalizedGeneratedManifestRow): number {
  return PRIORITY[left.package] - PRIORITY[right.package] || left.manifestOrder - right.manifestOrder;
}

function assertCounts(actual: GeneratedLibraryExpectedCounts, expected: GeneratedLibraryExpectedCounts): void {
  const labels: ReadonlyArray<[keyof GeneratedLibraryExpectedCounts, string]> = [
    ['sourceRows', 'source rows'],
    ['uniqueSources', 'unique sources'],
    ['pilotRows', 'pilot rows'],
    ['pilotRepeatedOutside', 'pilot sources repeated outside pilot'],
    ['sovietRepeatedInPopular', 'Soviet sources repeated in popular packages'],
    ['creationCandidates', 'creation candidates'],
  ];
  const errors = labels.flatMap(([key, label]) => actual[key] === expected[key]
    ? []
    : [`${label}: expected ${String(expected[key])}, received ${String(actual[key])}`]);
  if (errors.length > 0) throw new Error(`Generated library invariant drift: ${errors.join('; ')}.`);
}

function isPopular(name: GeneratedLibraryPackageName): boolean {
  return name === 'popular-top10-2026-08' || name === 'popular-next10-2026-08';
}

export async function planGeneratedLibrary(input: GeneratedLibraryInput): Promise<GeneratedLibraryPlan> {
  const campaign = input.campaign ?? GENERATED_LIBRARY_DEFAULT_CAMPAIGN;
  const packageCounts = new Map<GeneratedLibraryPackageName, number>();
  for (const { name } of input.packages) packageCounts.set(name, (packageCounts.get(name) ?? 0) + 1);
  const packageNames = new Set(packageCounts.keys());
  const missing = campaign.packageNames.filter((name) => !packageNames.has(name));
  const unexpected = [...packageNames].filter((name) => !campaign.packageNames.includes(name));
  const duplicates = [...packageCounts.entries()].filter(([, count]) => count > 1).map(([name]) => name);
  const packageErrors = [
    ...(missing.length === 0 ? [] : [`missing package: ${missing.join(', ')}`]),
    ...(unexpected.length === 0 ? [] : [`unexpected package: ${unexpected.join(', ')}`]),
    ...(duplicates.length === 0 ? [] : [`duplicate package: ${duplicates.join(', ')}`]),
  ];
  if (packageErrors.length > 0) {
    throw new Error(`Generated library campaign ${campaign.name} package set must match exactly: ${packageErrors.join('; ')}.`);
  }
  if (campaign.requiresSquarePath) {
    const missingSquares = input.packages.flatMap(({ name, rows }) => rows.flatMap((row) =>
      typeof row.squarePath === 'string' && row.squarePath.trim() !== '' ? [] : [`${name}:${row.id}`]));
    if (missingSquares.length > 0) {
      throw new Error(`Generated library campaign ${campaign.name} requires a valid squarePath for every row: ${missingSquares.join(', ')}.`);
    }
  }

  const rowsWithoutHashes = input.packages.flatMap(({ name, rows }) => rows.map((row, manifestOrder) => ({
    ...row,
    package: name,
    manifestOrder,
  })));
  const rows: NormalizedGeneratedManifestRow[] = [];
  for (const row of rowsWithoutHashes) {
    const bytes = await input.readBytes(row.backgroundPath);
    rows.push({
      ...row,
      sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const byHash = new Map<string, NormalizedGeneratedManifestRow[]>();
  for (const row of rows) {
    const group = byHash.get(row.sourceSha256) ?? [];
    group.push(row);
    byHash.set(row.sourceSha256, group);
  }

  const groups = [...byHash.entries()].map(([sourceSha256, members]) => {
    const sorted = [...members].sort(compareRows);
    return { sourceSha256, representative: sorted[0]!, rows: sorted };
  }).sort((left, right) => compareRows(left.representative, right.representative));
  const aliases = groups.flatMap((group) => group.rows.slice(1).map((row) => ({
    package: row.package,
    id: row.id,
    sourceSha256: group.sourceSha256,
    representativePackage: group.representative.package,
    representativeId: group.representative.id,
  })));
  const creationCandidates = groups.filter((group) => group.representative.package !== 'pilot-2026-08');
  const pilotRepeatedOutsideCount = groups.filter((group) =>
    group.rows.some((row) => row.package === 'pilot-2026-08') &&
    group.rows.some((row) => row.package !== 'pilot-2026-08')).length;
  const sovietRepeatedInPopularCount = groups.filter((group) =>
    group.rows.some((row) => row.package === 'soviet-holidays-2026-08') &&
    group.rows.some((row) => isPopular(row.package))).length;
  const actual = {
    sourceRows: rows.length,
    uniqueSources: groups.length,
    pilotRows: rows.filter((row) => row.package === 'pilot-2026-08').length,
    pilotRepeatedOutside: pilotRepeatedOutsideCount,
    sovietRepeatedInPopular: sovietRepeatedInPopularCount,
    creationCandidates: creationCandidates.length,
  };
  assertCounts(actual, input.expected);

  return {
    rows,
    groups,
    aliases,
    creationCandidates,
    sourceRowCount: actual.sourceRows,
    uniqueSourceCount: actual.uniqueSources,
    pilotRowCount: actual.pilotRows,
    pilotRepeatedOutsideCount,
    sovietRepeatedInPopularCount,
  };
}
