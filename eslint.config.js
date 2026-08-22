import js from '@eslint/js';
import astro from 'eslint-plugin-astro';
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
  // Шаблоны Astro (apps/web). Файлы .astro разбирает astro-eslint-parser:
  // без него eslint видит в них синтаксическую ошибку на первой же строке
  // frontmatter, и шаблоны просто не линтуются — то есть требование «eslint
  // зелёный на .astro» выполнялось бы формально, ничего не проверяя.
  //
  // Типизированных правил (recommendedTypeChecked) здесь НЕТ намеренно: они
  // требуют, чтобы файл входил в программу TypeScript, а .astro в неё входит
  // только через языковой сервер Astro. Проверку типов шаблонов делает
  // `astro check` (скрипт check в apps/web/package.json, входит в корневой
  // `pnpm check`) — она сильнее, чем типизированные правила eslint, и в отличие
  // от них понимает `Astro.props`.
  ...astro.configs['flat/recommended'],
  {
    // Конфиги и служебные скрипты: обычный JS без информации о типах.
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        // Node >= 22: глобальные fetch/Response и таймеры. Нужны служебным
        // скриптам, которые ходят по поднятому серверу
        // (apps/web/scripts/smoke-trailing-slash.mjs).
        fetch: 'readonly',
        process: 'readonly',
        Response: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
        __dirname: 'readonly',
      },
    },
  },
);
