export type CardStatus = 'planned' | 'generated' | 'accepted' | 'rejected';
export type TextTone = 'dark' | 'light';

export interface CardRecord {
  id: string;
  theme: string;
  fileName: string;
  headline: string;
  wish: string;
  alt: string;
  scenePrompt: string;
  commonPrompt: string;
  textTone: TextTone;
  status: CardStatus;
  backgroundPath: string;
  finalPath: string;
}

export function loadManifest(path: string): Promise<CardRecord[]>;
export function validateManifest(records: unknown): string[];
export function isValidManifest(records: unknown): records is CardRecord[];
export function writeManifestCsv(records: readonly CardRecord[], path: string): Promise<void>;
