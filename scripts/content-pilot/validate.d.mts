export type ValidationStage = 'backgrounds' | 'finals' | 'accepted';

export interface PilotValidationRecord {
  id?: unknown;
  theme?: unknown;
  status?: unknown;
  backgroundPath?: unknown;
  finalPath?: unknown;
}

export interface QaMissingFile {
  id: string;
  path: string;
}

export interface QaFormatError extends QaMissingFile {
  expected: string;
  actual: string;
}

export interface QaDimensionError extends QaMissingFile {
  expected: string;
  actual: string;
}

export interface QaHashError extends QaMissingFile {
  message: string;
}

export interface QaSimilarPair {
  left: string;
  right: string;
  theme: string;
  distance: number;
}

export interface QaReport {
  stage: ValidationStage;
  checkedCount: number;
  acceptedCount: number;
  missingFiles: QaMissingFile[];
  formatErrors: QaFormatError[];
  dimensionErrors: QaDimensionError[];
  hashErrors: QaHashError[];
  similarPairs: QaSimilarPair[];
  autoRejectedIds: string[];
  blockingErrors: string[];
}

export function validatePilot(
  records: readonly PilotValidationRecord[],
  stage: ValidationStage,
): Promise<QaReport>;
export function writeQaReport(report: QaReport, path: string): Promise<void>;
