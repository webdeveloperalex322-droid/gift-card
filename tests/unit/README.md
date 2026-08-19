# tests/unit — Vitest

Запуск: `pnpm test`. Один тест: `pnpm test -t "часть имени теста"`.
Один файл: `pnpm exec vitest run tests/unit/workspace.test.ts`.

Юнит-тесты пишутся до кода (TDD). Тесты пакетов могут лежать рядом с исходником
(`packages/*/src/**/*.test.ts`) — Vitest подхватывает оба расположения.
