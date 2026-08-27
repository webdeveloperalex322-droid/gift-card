import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { finishSmoke } from './smoke-exit';

/** Каталог смоуков на живой базе — того самого кода, который запускает `payload run`. */
const SCRIPTS_DIR = fileURLToPath(new URL('../../scripts/', import.meta.url));

function smokeSources(): readonly { readonly name: string; readonly text: string }[] {
  return readdirSync(SCRIPTS_DIR)
    .filter((name) => name.startsWith('smoke-') && name.endsWith('.ts'))
    .map((name) => ({ name, text: readFileSync(`${SCRIPTS_DIR}${name}`, 'utf8') }));
}

/** Подмена `process.exit`: настоящий выход убил бы прогон тестов. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

async function callAndCatchExit(failedCount: number): Promise<number | undefined> {
  // Сигнатура `process.exit` шире, чем нужно смоуку (`string | number | null`),
  // поэтому аргумент приводится к числу здесь, а не типом.
  const spy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
    throw new ExitCalled(typeof code === 'number' ? code : undefined);
  });
  try {
    await finishSmoke(failedCount);
    throw new Error('finishSmoke вернул управление, хотя обязан завершить процесс');
  } catch (error) {
    if (error instanceof ExitCalled) {
      return error.code;
    }
    throw error;
  } finally {
    spy.mockRestore();
  }
}

describe('finishSmoke', () => {
  it('провал завершает процесс кодом 1', async () => {
    await expect(callAndCatchExit(3)).resolves.toBe(1);
  });

  it('успех завершает процесс кодом 0', async () => {
    await expect(callAndCatchExit(0)).resolves.toBe(0);
  });

  // Смысл всей функции: `payload run` после скрипта безусловно делает
  // `process.exit(0)` и затирает `process.exitCode`. Поэтому провал обязан
  // выходить САМ, а не оставлять поле следующему коду.
  it('не полагается на process.exitCode', async () => {
    const before = process.exitCode;
    await expect(callAndCatchExit(1)).resolves.toBe(1);
    expect(process.exitCode).toBe(before);
  });
});

describe('смоуки на живой базе', () => {
  it('ни один не выставляет process.exitCode — payload run его затирает', () => {
    const offenders = smokeSources()
      .filter(({ text }) => /process\s*\.\s*exitCode\s*=/.test(text))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it('каждый завершается через finishSmoke, а не молча', () => {
    const silent = smokeSources()
      .filter(({ text }) => !text.includes('finishSmoke('))
      .map(({ name }) => name);
    expect(silent).toEqual([]);
  });

  it('в каталоге есть смоуки — иначе проверки выше зелены на пустом списке', () => {
    expect(smokeSources().length).toBeGreaterThanOrEqual(3);
  });
});
