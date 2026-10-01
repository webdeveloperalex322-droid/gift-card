import { describe, expect, it } from 'vitest';

import { cleanupMode } from './cleanup-mode';

describe('cleanupMode', () => {
  it('без аргументов — dry-run', () => {
    expect(cleanupMode([])).toBe('dry-run');
  });

  it('--dry-run — dry-run', () => {
    expect(cleanupMode(['--dry-run'])).toBe('dry-run');
  });

  it('--apply — apply', () => {
    expect(cleanupMode(['--apply'])).toBe('apply');
  });

  it('неизвестный аргумент отклоняется, а не трактуется как dry-run или apply', () => {
    expect(() => cleanupMode(['--force'])).toThrow(/Неизвестные аргументы/);
  });

  it('--apply вместе с другим аргументом отклоняется', () => {
    expect(() => cleanupMode(['--apply', '--dry-run'])).toThrow(/Неизвестные аргументы/);
  });
});
