/**
 * Режим разовой уборки остатков API-тестов (`scripts/cleanup-api-test-residue.ts`).
 *
 * Вынесен из скрипта в `src/`, чтобы быть покрытым юнит-тестом: dry-run по
 * умолчанию — единственная защита от случайного удаления при запуске без флагов.
 * Неизвестный аргумент отклоняется, а не трактуется как один из режимов.
 */
export type CleanupMode = 'apply' | 'dry-run';

export function cleanupMode(args: readonly string[]): CleanupMode {
  if (args.length === 0 || (args.length === 1 && args[0] === '--dry-run')) {
    return 'dry-run';
  }
  if (args.length === 1 && args[0] === '--apply') {
    return 'apply';
  }
  throw new Error(
    `Неизвестные аргументы уборки: ${args.join(' ') || '—'}. Допустимо --dry-run или --apply.`,
  );
}
