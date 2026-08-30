import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Алиасы на src, а не на dist: `pnpm test` должен работать без предварительной
// сборки. Типы при этом берутся из dist (см. tsconfig-ссылки), поэтому
// `pnpm check` остаётся обязательной частью verify.
const resolvePath = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@otkritka/shared': resolvePath('./packages/shared/src/index.ts'),
      // Подпуть объявлен ДО корневого и это обязательно: строковый алиас Vite
      // сопоставляется по ПРЕФИКСУ, поэтому корневой алиас превратил бы
      // «@otkritka/images/media» в «.../src/index.ts/media». Порядок ключей
      // объекта сохраняется, первое совпадение выигрывает.
      '@otkritka/images/media': resolvePath('./packages/images/src/media.ts'),
      '@otkritka/images': resolvePath('./packages/images/src/index.ts'),
    },
  },
  test: {
    // tests/seo/ гоняется Playwright'ом через `pnpm test:seo`, не Vitest'ом.
    include: [
      'tests/unit/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
    ],
    environment: 'node',
  },
});
