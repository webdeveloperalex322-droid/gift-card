import { describe, expect, it } from 'vitest';

import {
  MCP_ALLOWED_ORIGINS_ENV_KEY,
  MCP_AUTH_FAILURE_LIMIT_ENV_KEY,
  MCP_AUTH_FAILURE_WINDOW_ENV_KEY,
  MCP_DEFAULTS,
  MCP_ENABLED_ENV_KEY,
  isOriginAllowed,
  resolveMcpConfig,
} from './config';

describe('resolveMcpConfig', () => {
  it('без настройки ручка выключена', () => {
    expect(resolveMcpConfig({}).enabled).toBe(false);
  });

  it('включается только явным true', () => {
    expect(resolveMcpConfig({ [MCP_ENABLED_ENV_KEY]: 'true' }).enabled).toBe(true);
    expect(resolveMcpConfig({ [MCP_ENABLED_ENV_KEY]: 'false' }).enabled).toBe(false);
  });

  it('отвергает значение 1 вместо true, а не приводит его молча', () => {
    expect(() => resolveMcpConfig({ [MCP_ENABLED_ENV_KEY]: '1' })).toThrow(
      /принимает только «true» или «false»/,
    );
  });

  it('подставляет утверждённые значения лимита попыток при пустых переменных', () => {
    const config = resolveMcpConfig({});
    expect(config.failureLimit).toBe(MCP_DEFAULTS.failureLimit);
    expect(config.failureWindowSeconds).toBe(MCP_DEFAULTS.failureWindowSeconds);
  });

  it('отвергает нулевой лимит попыток: выключателя у защиты нет', () => {
    expect(() => resolveMcpConfig({ [MCP_AUTH_FAILURE_LIMIT_ENV_KEY]: '0' })).toThrow(
      /целым числом от 1/,
    );
  });

  it('отвергает мусорное окно', () => {
    expect(() => resolveMcpConfig({ [MCP_AUTH_FAILURE_WINDOW_ENV_KEY]: 'abc' })).toThrow(
      /целым числом от 1/,
    );
  });

  it('разбирает белый список Origin, снимая пробелы', () => {
    expect(
      resolveMcpConfig({ [MCP_ALLOWED_ORIGINS_ENV_KEY]: ' https://a.test , https://b.test ' })
        .allowedOrigins,
    ).toEqual(['https://a.test', 'https://b.test']);
  });

  it('пустая переменная даёт пустой список, а не отсутствие проверки', () => {
    expect(resolveMcpConfig({ [MCP_ALLOWED_ORIGINS_ENV_KEY]: '' }).allowedOrigins).toEqual([]);
  });
});

describe('isOriginAllowed', () => {
  it('запрос без Origin допустим: так ходят серверные клиенты', () => {
    expect(isOriginAllowed(null, [])).toBe(true);
    expect(isOriginAllowed('', [])).toBe(true);
  });

  it('при пустом списке любой присланный Origin отвергается', () => {
    expect(isOriginAllowed('https://evil.test', [])).toBe(false);
  });

  it('пропускает только точное совпадение', () => {
    expect(isOriginAllowed('https://a.test', ['https://a.test'])).toBe(true);
    expect(isOriginAllowed('https://a.test.evil.test', ['https://a.test'])).toBe(false);
  });
});
