import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Алиасы на src, а не на dist: `pnpm test` должен работать без предварительной
// сборки. Типы при этом берутся из dist (см. tsconfig-ссылки), поэтому
// `pnpm check` остаётся обязательной частью verify.
const resolvePath = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const alias = {
  // Псевдоним, под которым маршруты Payload находят конфиг. В приложении
  // его объявляет `withPayload` (webpack/turbopack) и apps/cms/tsconfig.json;
  // живые API-тесты (tests/api) поднимают ТЕ ЖЕ файлы маршрутов вне Next,
  // поэтому тот же псевдоним нужен и здесь.
  '@payload-config': resolvePath('./apps/cms/src/payload.config.ts'),
  // Подпуть объявлен ДО корневого и это обязательно: строковый алиас Vite
  // сопоставляется по ПРЕФИКСУ, поэтому корневой алиас превратил бы
  // «@otkritka/images/media» в «.../src/index.ts/media». Порядок ключей
  // объекта сохраняется, первое совпадение выигрывает.
  '@otkritka/shared': resolvePath('./packages/shared/src/index.ts'),
  '@otkritka/images/media': resolvePath('./packages/images/src/media.ts'),
  '@otkritka/images': resolvePath('./packages/images/src/index.ts'),
};

/*
 * ДВА ПРОЕКТА, А НЕ ОДИН НАБОР ПОСЛАБЛЕНИЙ НА ВСЁ.
 *
 * Живому набору tests/api нужны длинные таймауты и запрет параллельного запуска
 * файлов: он ходит по настоящим REST и GraphQL Payload на живой базе, все его
 * файлы делят один инстанс и один пул подключений, а первый запрос ещё и
 * накатывает схему. Чистым тестам (их около двух тысяч) это не нужно и вредно:
 * с общим `testTimeout: 60s` зависший юнит-тест висел бы минуту вместо секунды,
 * а с общим `fileParallelism: false` весь прогон шёл бы в один поток.
 *
 * `fileParallelism` задать на уровне проекта нельзя — Vitest относит его к
 * NonProjectOptions (проверено по типам, `ProjectConfig` в vitest/dist). Тот же
 * эффект внутри проекта даёт `poolOptions.forks.singleFork`: все файлы проекта
 * выполняются последовательно в одном форке. Чистые тесты при этом остаются
 * параллельными — базы они не касаются (единственный тест, упоминающий
 * DATABASE_URL, проверяет текст ошибки, а не подключение).
 */
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          environment: 'node',
          // tests/seo/ гоняется Playwright'ом через `pnpm test:seo`, не Vitest'ом.
          include: [
            'tests/unit/**/*.test.ts',
            'packages/*/src/**/*.test.ts',
            'apps/*/src/**/*.test.ts',
          ],
          name: 'unit',
        },
      },
      {
        resolve: { alias },
        test: {
          /*
           * ПРЕДЕЛ ЧАСТОТЫ ДЛЯ НАБОРА ПОДНЯТ, И ЭТО НЕ ПОСЛАБЛЕНИЕ ПРАВИЛА.
           *
           * Все файлы проекта идут ПОСЛЕДОВАТЕЛЬНО В ОДНОМ ФОРКЕ (см. ниже), то
           * есть делят один процесс, а значит и одни счётчики бакетов
           * (apps/cms/src/http/api-rate-limit.ts). Под боевыми значениями Ч-14
           * весь набор располагал бы общим бюджетом в 120 запросов на ключ, и
           * каждый новый сценарий откусывал бы от него молча: первым покраснел
           * бы не тот тест, который добавили, а ЧУЖОЙ — ответом 429, никак не
           * связанным с проверяемым им правилом. Полагаться на разовый замер
           * «сейчас запас есть» здесь нельзя: замер стареет в тот момент, когда
           * кто-то допишет цикл в существующий файл.
           *
           * Значения заданы ТЕМИ ЖЕ переменными, что и в бою, — своего
           * «тестового режима» у ограничения нет, выключателя у него тоже нет
           * (ноль отвергается). Проверку самого предела это не ослабляет:
           * `tests/api/rate-limit.test.ts` сужает окно до единиц запросов сам и
           * возвращает эти значения в `afterAll`, поэтому 429 в наборе
           * появляется там и только там, где он и есть предмет проверки.
           *
           * Переменные окружения приоритетнее корневого `.env`
           * (`process.loadEnvFile` не перезаписывает уже заданные значения),
           * поэтому локальный `API_RATE_LIMIT_PER_MINUTE=60` в `.env`
           * разработчика набор не затрагивает.
           */
          env: {
            API_RATE_LIMIT_BURST: '20000',
            API_RATE_LIMIT_PER_MINUTE: '20000',
            API_RATE_LIMIT_WINDOW_SECONDS: '60',
          },
          environment: 'node',
          // `beforeAll` поднимает Payload и, при пустой базе, накатывает схему.
          hookTimeout: 180_000,
          include: ['tests/api/**/*.test.ts'],
          name: 'api',
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 60_000,
        },
      },
    ],
  },
});
