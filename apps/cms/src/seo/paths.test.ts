/**
 * Пути записей контента и валидация slug на стороне CMS (задачи Э1-04, Э1-06).
 *
 * Проверяется не транслитерация и не форма slug — это `@otkritka/shared` и его
 * тесты. Здесь проверяется, что CMS зовёт общие правила и делает это по
 * ИТОГОВОМУ пути записи: slug, безупречный по форме, может занять путь,
 * зарезервированный под служебный маршрут.
 */
import { describe, expect, it } from 'vitest';

import {
  CARD_PATH_PREFIX,
  COLLECTION_PATH_PREFIX,
  buildCardPath,
  validateContentSlug,
} from './paths';

const env = { PAYLOAD_ADMIN_PATH: '/admin' } as const;

describe('пространства имён (решение человека 2026-08-22)', () => {
  it('карточки живут под /otkrytki, подборки — под /podborki', () => {
    // Пространства разведены: коллизия «карточка против подборки» невозможна
    // структурно, а не за счёт проверки уникальности.
    expect(CARD_PATH_PREFIX).toBe('/otkrytki');
    expect(COLLECTION_PATH_PREFIX).toBe('/podborki');
  });

  it('канонический путь карточки — /otkrytki/<slug>', () => {
    expect(buildCardPath('otkrytka-mame-na-8-marta')).toBe('/otkrytki/otkrytka-mame-na-8-marta');
  });
});

describe('validateContentSlug: допустимый slug', () => {
  it('принимает slug по правилам проекта', () => {
    expect(validateContentSlug('otkrytka-mame-na-8-marta', { prefix: CARD_PATH_PREFIX, env })).toBe(
      true,
    );
  });
});

describe('validateContentSlug: отказы по форме (делегируются в shared)', () => {
  it('пустое значение', () => {
    expect(validateContentSlug('', { prefix: CARD_PATH_PREFIX, env })).toEqual(expect.any(String));
    expect(validateContentSlug(undefined, { prefix: CARD_PATH_PREFIX, env })).toEqual(
      expect.any(String),
    );
    expect(validateContentSlug('   ', { prefix: CARD_PATH_PREFIX, env })).toEqual(
      expect.any(String),
    );
  });

  it('кириллица, верхний регистр, пробелы, подчёркивание, слеш', () => {
    for (const value of [
      'Открытка',
      'Otkrytka',
      'otkrytka mame',
      'otkrytka_mame',
      'otkrytki/mame',
      'otkrytka?utm=1',
    ]) {
      expect(validateContentSlug(value, { prefix: CARD_PATH_PREFIX, env })).toEqual(
        expect.any(String),
      );
    }
  });

  it('slug длиннее нормы (Ч-26) и slug из одних цифр (Ч-27)', () => {
    expect(validateContentSlug('a'.repeat(81), { prefix: CARD_PATH_PREFIX, env })).toEqual(
      expect.any(String),
    );
    expect(validateContentSlug('2026', { prefix: CARD_PATH_PREFIX, env })).toEqual(
      expect.any(String),
    );
  });
});

describe('validateContentSlug: отказы по реестру маршрутов', () => {
  it('сегмент page запрещён: он занят пагинацией /page/N', () => {
    const result = validateContentSlug('page', { prefix: CARD_PATH_PREFIX, env });
    expect(result).toEqual(expect.any(String));
    expect(String(result)).toContain('page');
  });

  it('нестандартный PAYLOAD_ADMIN_PATH участвует в проверке', () => {
    // Путь админки не записан строкой, а вычисляется из окружения. Если он
    // настроен внутрь контейнера карточек, slug, совпадающий с ним, обязан
    // отклоняться — иначе запись заняла бы адрес админки.
    const env = { PAYLOAD_ADMIN_PATH: '/otkrytki/upravlenie' };
    expect(validateContentSlug('upravlenie', { prefix: CARD_PATH_PREFIX, env })).toEqual(
      expect.any(String),
    );
    expect(validateContentSlug('mame', { prefix: CARD_PATH_PREFIX, env })).toBe(true);
  });

  it('незаданный PAYLOAD_ADMIN_PATH даёт внятный отказ, а не падение', () => {
    const result = validateContentSlug('mame', { prefix: CARD_PATH_PREFIX, env: {} });
    expect(result).toEqual(expect.any(String));
    expect(String(result)).toContain('PAYLOAD_ADMIN_PATH');
  });
});

/**
 * Год в адресе (условие C3, блокирующая находка ревизии от 2026-08-22).
 *
 * Здесь проверяется ВКЛЮЧАТЕЛЬ правила у валидатора поля: сам предикат живёт в
 * `@otkritka/shared` и покрыт там, а авторитетная проверка карточки стоит в
 * хуке (`collections/content-hooks.ts`) — валидацию поля Payload умеет
 * пропускать.
 */
describe('validateContentSlug: год в адресе', () => {
  it('с forbidYear год отклоняется, а отказ называет год', () => {
    const result = validateContentSlug('novyy-god-2027', {
      env,
      forbidYear: true,
      prefix: CARD_PATH_PREFIX,
    });
    expect(result).toEqual(expect.any(String));
    expect(String(result)).toContain('2027');
    expect(String(result)).toContain('/otkrytki/novyy-god-2027');
  });

  it('без forbidYear правило не применяется: область задаёт вызывающий', () => {
    // У подборок область применения зависит от вида узла, поэтому включатель
    // здесь выключен, а правило применяет `collection-path.ts`.
    expect(
      validateContentSlug('novyy-god-2027', { env, prefix: COLLECTION_PATH_PREFIX }),
    ).toBe(true);
  });

  it('даты праздников проходят и с включённым правилом', () => {
    for (const slug of ['8-marta', '23-fevralya', '1-sentyabrya', 'otkrytka-1920x1080']) {
      expect(
        validateContentSlug(slug, { env, forbidYear: true, prefix: CARD_PATH_PREFIX }),
        slug,
      ).toBe(true);
    }
  });
});
