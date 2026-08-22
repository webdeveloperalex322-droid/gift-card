import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.astro/**',
      // Сборочный вывод Next.js (apps/cms) и его сгенерированные объявления:
      // это не исходники, линтовать их бессмысленно, а часть файлов вообще не
      // входит ни в один tsconfig-проект.
      '**/.next/**',
      '**/next-env.d.ts',
      '**/*.tsbuildinfo',
    ],
  },
  js.configs.recommended,
  {
    // Типизированные правила — только для TypeScript, который входит в проекты
    // из tsconfig.json. vitest.config.ts лежит вне них, поэтому разрешён явно.
    // `.tsx` включён вместе с `.ts`: маршруты админки Payload в apps/cms —
    // компоненты React, и без этого шаблона они не линтовались бы вовсе.
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Правило CLAUDE.md: TypeScript strict, без any.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Конфиги и служебные скрипты: обычный JS без информации о типах.
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        __dirname: 'readonly',
      },
    },
  },
);
