import js from '@eslint/js';
import astro from 'eslint-plugin-astro';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      // Локальное хранилище пакетов pnpm — линтовать его так же бессмысленно,
      // как node_modules.
      '**/.pnpm-store/**',
      // Рабочие каталоги git worktree: внутри лежат ПОЛНЫЕ копии проекта, и
      // обход их исходников кладёт прогон по памяти. Проверять их отсюда не
      // нужно и вредно — у каждой копии свой прогон. Пропуск был незаметен,
      // потому что внутри самого worktree этого каталога нет: падало только в
      // основном чекауте.
      '**/.claude/worktrees/**',
      '**/.worktrees/**',
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
    // `.mts` перечислен явно: шаблон `**/*.ts` его НЕ покрывает, а без
    // упоминания файл не подходит ни под один блок конфига и `eslint .`
    // молча его пропускает. Такой файл в проекте есть — точка входа
    // собранного сервера apps/web (`src/server/entry.mts`): только из `.mts`
    // tsc даёт на выходе `.mjs`, а имя `dist/server/entry.mjs` — контракт
    // сборки.
    files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
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
    // Гарнизон живых API-тестов (`apps/cms/src/testing/**`) лежит в `src`
    // приложения — иначе его не проверял бы `pnpm --filter @otkritka/cms check`.
    // Плата за это: он разрешается из продуктового кода, а внутри него есть
    // `readStored` и `removeContent`, ходящие с `overrideAccess: true`, то есть
    // В ОБХОД всего access control. Один такой импорт в хуке коллекции — и
    // защита обойдена изнутри, причём сборкой это не заметится.
    //
    // Правило базовое (`no-restricted-imports`), а не новый плагин зон: цель —
    // ровно один запрет, и заводить ради него инфраструктуру дороже, чем он
    // стоит. Каталог `tests/api` из блока исключён: это его единственный
    // законный потребитель.
    files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
    ignores: ['tests/api/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/testing/api-harness', '**/testing/api-fixtures', '**/src/testing/*'],
              message:
                'apps/cms/src/testing/** — гарнизон тестов: он ходит с overrideAccess: true, ' +
                'в обход access control. Импортировать его вправе только tests/api/**. ' +
                'Продуктовому коду нужен обычный Local API с проверкой прав.',
            },
          ],
        },
      ],
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
        // Buffer нужен смоуку отдачи файлов (apps/web/scripts/smoke-media.mjs):
        // он сравнивает БАЙТЫ ответа с байтами файла, а не текст.
        Buffer: 'readonly',
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
