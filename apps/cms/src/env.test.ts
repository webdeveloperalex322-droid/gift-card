/**
 * Юнит-тесты слоя окружения Payload (задача Э1-02, TDD: тест написан до кода).
 *
 * Проверяется ровно то, что при ошибке даёт тихий, а не громкий отказ:
 *   - путь админки читается из `PAYLOAD_ADMIN_PATH` и НЕ имеет значения по
 *     умолчанию — ровно как в реестре зарезервированных маршрутов
 *     (`packages/shared/src/reserved-routes.ts`). Дефолт в одном из двух мест
 *     означал бы, что админка живёт по одному пути, а зарезервирован другой, и
 *     подборка тихо заняла бы адрес админки;
 *   - мусорное значение валит запуск с внятной ошибкой, а не нормализуется молча;
 *   - обязательная переменная без значения валит запуск, а не даёт Payload
 *     подняться с пустым секретом или без строки подключения.
 */
import { describe, expect, it } from 'vitest';

import { parseAdminPath } from '@otkritka/shared';

import {
  DB_PUSH_ENV_KEY,
  ENV_EXAMPLE_ADMIN_PATH,
  adminPathRewrites,
  databasePush,
  requireEnv,
  resolveAdminPath,
} from './env.mjs';

describe('resolveAdminPath', () => {
  it('без значения валит запуск: дефолта нет намеренно', () => {
    expect(() => resolveAdminPath(undefined)).toThrow(/PAYLOAD_ADMIN_PATH/);
    expect(() => resolveAdminPath('')).toThrow(/PAYLOAD_ADMIN_PATH/);
    expect(() => resolveAdminPath('   ')).toThrow(/PAYLOAD_ADMIN_PATH/);
  });

  it('значение из .env.example проходит и остаётся собой', () => {
    expect(ENV_EXAMPLE_ADMIN_PATH).toBe('/admin');
    expect(resolveAdminPath(ENV_EXAMPLE_ADMIN_PATH)).toBe('/admin');
  });

  it('пропускает корректный путь без изменений', () => {
    expect(resolveAdminPath('/upravlenie')).toBe('/upravlenie');
    expect(resolveAdminPath('/cms/upravlenie')).toBe('/cms/upravlenie');
  });

  it('нормализует слеши так же, как реестр в packages/shared', () => {
    // Решение Ч-21: канонический вид маршрута — без завершающего слеша.
    // Нормализация — забота кода, а не автора .env.
    expect(resolveAdminPath('/admin/')).toBe('/admin');
    expect(resolveAdminPath('admin')).toBe('/admin');
    expect(resolveAdminPath('  /upravlenie/  ')).toBe('/upravlenie');
    expect(resolveAdminPath('//admin//panel//')).toBe('/admin/panel');
  });

  it('отклоняет сегменты, не проходящие правила slug', () => {
    // Правила URL из CLAUDE.md: нижний регистр, латиница, дефисы, без
    // пробелов, подчёркиваний и параметров.
    for (const bad of [
      '/Admin',
      '/admin panel',
      '/admin_panel',
      '/админка',
      '/admin?x=1',
      '/admin#hash',
      '/',
    ]) {
      expect(() => resolveAdminPath(bad), bad).toThrow(/PAYLOAD_ADMIN_PATH/);
    }
  });

  it('отклоняет сегмент page на любой позиции', () => {
    // Сегмент `page` зарезервирован под пагинацию /page/N.
    expect(() => resolveAdminPath('/page')).toThrow(/page/);
    expect(() => resolveAdminPath('/cms/page')).toThrow(/page/);
  });

  it('совпадает с разбором реестра ЗНАЧЕНИЕМ В ЗНАЧЕНИЕ: разбор один', () => {
    // Находка ревизии от 2026-08-22: разбор PAYLOAD_ADMIN_PATH был написан
    // дважды — здесь и в packages/shared — и правила разошлись (сегмент `page`
    // отклоняла только копия из env.mjs), а теста на совпадение не было. Из
    // одного значения выводятся и адрес админки, и его резерв: разойтись им
    // нельзя. Теперь `resolveAdminPath` — обёртка над `parseAdminPath`, и этот
    // тест краснеет, если кто-то снова размножит правила.
    const accepted = ['/admin', 'admin', '/admin/', '//admin//panel//', '  /upravlenie/  '];
    for (const raw of accepted) {
      expect(resolveAdminPath(raw), raw).toBe(parseAdminPath(raw));
    }

    const rejected = [
      undefined,
      '',
      '   ',
      '/',
      '/Admin',
      '/admin panel',
      '/admin_panel',
      '/админка',
      '/admin?x=1',
      '/admin#hash',
      '/admin/../root',
      '/page',
      '/cms/page',
    ];
    for (const raw of rejected) {
      let fromEnv: string | null = null;
      let fromShared: string | null = null;
      try {
        fromEnv = String(resolveAdminPath(raw));
      } catch (error) {
        fromEnv = error instanceof Error ? error.message : String(error);
      }
      try {
        fromShared = String(parseAdminPath(raw));
      } catch (error) {
        fromShared = error instanceof Error ? error.message : String(error);
      }
      expect(fromEnv, String(raw)).toBe(fromShared);
      expect(fromEnv, String(raw)).toContain('PAYLOAD_ADMIN_PATH');
    }
  });
});

describe('adminPathRewrites', () => {
  it('для физического пути /admin ничего не переписывает', () => {
    // Физический маршрут Next совпадает с настроенным — переписывать нечего.
    expect(adminPathRewrites('/admin')).toEqual({ redirects: [], rewrites: [] });
  });

  it('для нестандартного пути отдаёт rewrite на физический /admin и redirect с /admin', () => {
    const { redirects, rewrites } = adminPathRewrites('/upravlenie');

    // Запрос на настроенный путь обслуживается физическим маршрутом Next.
    expect(rewrites).toEqual([
      { destination: '/admin/:segments*', source: '/upravlenie/:segments*' },
    ]);

    // Физический /admin не остаётся вторым живым адресом той же админки.
    expect(redirects).toEqual([
      {
        destination: '/upravlenie/:segments*',
        permanent: false,
        source: '/admin/:segments*',
      },
    ]);
  });

  it('работает для многосегментного пути', () => {
    const { redirects, rewrites } = adminPathRewrites('/cms/upravlenie');
    expect(rewrites[0]?.source).toBe('/cms/upravlenie/:segments*');
    expect(rewrites[0]?.destination).toBe('/admin/:segments*');
    expect(redirects[0]?.destination).toBe('/cms/upravlenie/:segments*');
  });
});

describe('requireEnv', () => {
  it('возвращает заданное значение', () => {
    expect(requireEnv('PROBE_REQUIRED', { PROBE_REQUIRED: 'value' })).toBe('value');
  });

  it('валит запуск с именем переменной в сообщении', () => {
    expect(() => requireEnv('DATABASE_URL', {})).toThrow(/DATABASE_URL/);
    expect(() => requireEnv('PAYLOAD_SECRET', { PAYLOAD_SECRET: '' })).toThrow(
      /PAYLOAD_SECRET/,
    );
    expect(() => requireEnv('PAYLOAD_SECRET', { PAYLOAD_SECRET: '   ' })).toThrow(
      /PAYLOAD_SECRET/,
    );
  });
});

describe('databasePush', () => {
  it('по умолчанию схема накатывается: миграций в проекте пока нет', () => {
    expect(databasePush({})).toBe(true);
    expect(databasePush({ [DB_PUSH_ENV_KEY]: '' })).toBe(true);
    expect(databasePush({ [DB_PUSH_ENV_KEY]: '  ' })).toBe(true);
  });

  it('выключается явно — этим стенд собранного apps/web обходит drizzle-kit', () => {
    // Находка url-guard: при включённом push собранный сервер apps/web падает на
    // первом запросе к базе с «Cannot find module 'drizzle-kit/api'».
    expect(databasePush({ [DB_PUSH_ENV_KEY]: 'false' })).toBe(false);
    expect(databasePush({ [DB_PUSH_ENV_KEY]: '0' })).toBe(false);
    expect(databasePush({ [DB_PUSH_ENV_KEY]: 'OFF' })).toBe(false);
    expect(databasePush({ [DB_PUSH_ENV_KEY]: 'true' })).toBe(true);
  });

  it('непонятное значение — ошибка, а не молчаливое «накатывать»', () => {
    expect(() => databasePush({ [DB_PUSH_ENV_KEY]: 'нет' })).toThrow(DB_PUSH_ENV_KEY);
  });
});
