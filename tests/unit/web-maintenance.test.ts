/**
 * Режим обслуживания: 503 с `Retry-After` (задача Э3-11).
 *
 * Норма: `CLAUDE.md`, раздел «HTTP-статусы» — «Сервис недоступен → 503 +
 * Retry-After». Проверяется чистое решение
 * (`apps/web/src/server/maintenance.ts`), которое зовут ОБА входа: наш сервер
 * (`src/server/front-door.ts`) и middleware Astro (`src/middleware.ts`).
 *
 * Почему это проверяется юнитом, а не только поднятым сервером: главное свойство
 * здесь — «выключено по умолчанию». Проверить его на живом сервере значит
 * доказать, что при незаданной переменной сайт работает, — то есть ровно то
 * состояние, в котором сервер и так гоняется во всех остальных проверках, и
 * отдельного сигнала от него не получить. А дорогая ошибка — обратная: сайт,
 * закрывшийся сам.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RETRY_AFTER_SECONDS,
  MAINTENANCE_ENV_KEY,
  MAINTENANCE_HTML,
  MAINTENANCE_RETRY_AFTER_ENV_KEY,
  maintenanceMode,
} from '../../apps/web/src/server/maintenance.js';

describe('режим обслуживания выключен по умолчанию', () => {
  it('пустое окружение оставляет сайт работать', () => {
    expect(maintenanceMode({}).action).toBe('serve-site');
  });

  it('пустая строка и пробелы — это «выключено», а не «включено»', () => {
    for (const value of ['', '   ', undefined]) {
      expect(maintenanceMode({ [MAINTENANCE_ENV_KEY]: value }).action).toBe('serve-site');
    }
  });

  it('явные значения «выключено» распознаются', () => {
    for (const value of ['off', 'OFF', '0', 'false', 'no']) {
      expect(maintenanceMode({ [MAINTENANCE_ENV_KEY]: value }).action).toBe('serve-site');
    }
  });
});

describe('включённый режим обслуживания', () => {
  it('любое из значений «включено» даёт 503 с Retry-After и телом', () => {
    for (const value of ['on', 'ON', '1', 'true', 'yes']) {
      const decision = maintenanceMode({ [MAINTENANCE_ENV_KEY]: value });
      expect(decision.action).toBe('unavailable');
      if (decision.action !== 'unavailable') {
        throw new Error('Ожидался режим обслуживания.');
      }
      expect(decision.status).toBe(503);
      expect(decision.retryAfterSeconds).toBe(DEFAULT_RETRY_AFTER_SECONDS);
      expect(decision.body).toBe(MAINTENANCE_HTML);
    }
  });

  it('Retry-After берётся из окружения', () => {
    const decision = maintenanceMode({
      [MAINTENANCE_ENV_KEY]: 'on',
      [MAINTENANCE_RETRY_AFTER_ENV_KEY]: '60',
    });
    if (decision.action !== 'unavailable') {
      throw new Error('Ожидался режим обслуживания.');
    }
    expect(decision.retryAfterSeconds).toBe(60);
  });

  it('мусорный Retry-After — отказ, а не молчаливый дефолт', () => {
    // Тот, кто настраивал окно обслуживания, обязан узнать, что значение не
    // применилось: иначе краулер вернётся не тогда, когда ожидалось.
    for (const value of ['0', '-1', '1.5', 'позже', 'NaN']) {
      expect(() =>
        maintenanceMode({
          [MAINTENANCE_ENV_KEY]: 'on',
          [MAINTENANCE_RETRY_AFTER_ENV_KEY]: value,
        }),
      ).toThrow(MAINTENANCE_RETRY_AFTER_ENV_KEY);
    }
  });

  it('непонятное значение выключателя — отказ, а не «считаем, что выключено»', () => {
    // Опасное направление ошибки: администратор считает сайт закрытым и правит
    // базу, а сайт отвечает 200 из полуобновлённых данных.
    for (const value of ['enabled', 'да', 'maybe', 'ON!']) {
      expect(() => maintenanceMode({ [MAINTENANCE_ENV_KEY]: value })).toThrow(
        MAINTENANCE_ENV_KEY,
      );
    }
  });
});

describe('страница 503', () => {
  it('не зависит ни от чего: это константа, а не рендер', () => {
    // Требование задачи: страница обязана отрендериться в аварии, когда БД
    // недоступна и приложение Astro могло не собраться.
    expect(MAINTENANCE_HTML).toContain('<!doctype html>');
    expect(MAINTENANCE_HTML).toContain('lang="ru"');
    expect(MAINTENANCE_HTML).toContain('<h1>');
  });

  it('закрыта от индексации и не обещает несуществующих адресов', () => {
    expect(MAINTENANCE_HTML).toContain('<meta name="robots" content="noindex,nofollow">');
    // Ни canonical, ни ссылок: 503 отвечает по ЛЮБОМУ адресу, и ссылка отсюда
    // ведёт туда же — в тот же 503.
    expect(MAINTENANCE_HTML).not.toContain('rel="canonical"');
    expect(MAINTENANCE_HTML).not.toContain('<a ');
  });

  it('ни одного клиентского скрипта', () => {
    expect(MAINTENANCE_HTML).not.toContain('<script');
  });
});
