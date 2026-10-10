import * as migration_20261009_165231_baseline from './20261009_165231_baseline';

export const migrations = [
  {
    up: migration_20261009_165231_baseline.up,
    down: migration_20261009_165231_baseline.down,
    name: '20261009_165231_baseline'
  },
];
