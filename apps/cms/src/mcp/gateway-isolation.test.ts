/**
 * Страж изоляции шлюза.
 *
 * Решение Ч-35e разместило MCP на Local API, у которого `overrideAccess` по
 * умолчанию равен `true`. Единственное, что отделяет внешнюю LLM от прав мимо
 * access control, — это дисциплина «к Payload обращается только `gateway.ts`».
 * Дисциплина, записанная в комментарии, нарушается первой правкой; записанная
 * в тест — не нарушается.
 *
 * Поэтому тест читает ВСЕ файлы слоя и падает на любом упоминании Payload вне
 * шлюза. Исключений ровно три, и каждое названо: сам `gateway.ts`; его тест,
 * который обязан проверять, что `overrideAccess: false` действительно уходит в
 * каждый вызов; и этот файл, где запрещённые строки живут шаблонами поиска.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const LAYER_ROOT = import.meta.dirname;

const ALLOWED_FILES = new Set([
  'gateway.ts',
  // Тест шлюза доказывает, что `overrideAccess: false` уходит в каждый вызов, —
  // без права упомянуть эту строку он не смог бы её и проверить.
  'gateway.test.ts',
  'gateway-isolation.test.ts',
]);

const FORBIDDEN: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /\breq\.payload\b/, why: 'обращение к Payload мимо шлюза' },
  { pattern: /\bpayload\.(find|create|update|delete|count)\b/, why: 'операция Payload мимо шлюза' },
  {
    pattern: /overrideAccess/,
    why: 'переключение проверки прав; оно существует ровно в одном месте — в шлюзе',
  },
];

async function collectLayerFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectLayerFiles(full)));
    } else if (entry.name.endsWith('.ts') && !ALLOWED_FILES.has(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

describe('изоляция шлюза', () => {
  it('ни один файл MCP-слоя, кроме gateway.ts, не касается Payload', async () => {
    const files = await collectLayerFiles(LAYER_ROOT);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(source)) {
          offenders.push(`${file.slice(LAYER_ROOT.length + 1)}: ${why}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('шлюз действительно зашивает overrideAccess: false', async () => {
    const source = await readFile(join(LAYER_ROOT, 'gateway.ts'), 'utf8');
    expect(source).toContain('overrideAccess: false');
    // Параметра, которым проверку прав можно включить обратно, быть не должно:
    // присутствие такой строки означало бы, что устройство превратилось в настройку.
    expect(source).not.toContain('overrideAccess: true');
  });
});
