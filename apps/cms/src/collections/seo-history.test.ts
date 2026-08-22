/**
 * Коллекция `seo-history` (задача Э1-07): конфигурация журнала аудита.
 *
 * Проверяется не Payload, а КОНФИГ: что журнал закрыт для записи снаружи, что
 * набор отслеживаемых полей совпадает с общим перечнем и что автор фиксируется
 * связью, а не строкой. Поведение хуков (что запись действительно появляется и
 * что её нельзя изменить) проверяется в `content-hooks.test.ts` на прогоне через
 * фазы Payload.
 */
import type { Field } from 'payload';
import { APIError } from 'payload';
import { describe, expect, it } from 'vitest';

import { authenticatedAccess } from '../access/policies';
import { TRACKED_SEO_FIELDS } from './seo-history-diff';
import { SeoHistory, rejectHistoryEdit } from './seo-history';

function findField(fields: readonly Field[], name: string): Field {
  const field = fields.find((candidate) => 'name' in candidate && candidate.name === name);
  if (field === undefined) {
    throw new Error(`Поле «${name}» в коллекции не найдено`);
  }
  return field;
}

function optionValues(field: Field): readonly string[] {
  if (!('options' in field) || !Array.isArray(field.options)) {
    throw new Error('У поля нет набора значений');
  }
  return field.options.map((option) =>
    typeof option === 'string' ? option : String(option.value),
  );
}

describe('seo-history: запись только чтение', () => {
  it('создание, изменение и удаление закрыты для всех снаружи', () => {
    expect(SeoHistory.access?.create?.({} as never)).toBe(false);
    expect(SeoHistory.access?.update?.({} as never)).toBe(false);
    expect(SeoHistory.access?.delete?.({} as never)).toBe(false);
  });

  it('читать журнал может только аутентифицированный', () => {
    expect(SeoHistory.access?.read).toBe(authenticatedAccess);
  });

  it('хук неизменяемости отклоняет правку и пропускает создание', () => {
    const args = { operation: 'update' } as unknown as Parameters<typeof rejectHistoryEdit>[0];
    expect(() => {
      rejectHistoryEdit(args);
    }).toThrow(APIError);
    const createArgs = { operation: 'create' } as unknown as Parameters<typeof rejectHistoryEdit>[0];
    expect(() => {
      rejectHistoryEdit(createArgs);
    }).not.toThrow();
  });
});

describe('seo-history: состав записи (ТЗ §8.1)', () => {
  it('фиксируется что, когда, кем и «старое → новое»', () => {
    const names = SeoHistory.fields
      .map((field) => ('name' in field ? field.name : undefined))
      .filter((name): name is string => name !== undefined);

    expect(names).toEqual(
      expect.arrayContaining([
        'documentCollection',
        'documentId',
        'documentPath',
        'field',
        'previousValue',
        'nextValue',
        'operation',
        'authorRole',
        'changedBy',
        'viaApiKey',
        'changedAt',
      ]),
    );
  });

  it('набор отслеживаемых полей берётся из общего перечня, а не дублируется', () => {
    expect(optionValues(findField(SeoHistory.fields, 'field'))).toEqual([...TRACKED_SEO_FIELDS]);
  });

  it('идентификатор документа — строка: журнал переживает удаление записи', () => {
    const field = findField(SeoHistory.fields, 'documentId');
    expect(field.type).toBe('text');
    expect('required' in field ? field.required : undefined).toBe(true);
  });

  it('автор фиксируется связью с users, а не текстом', () => {
    const field = findField(SeoHistory.fields, 'changedBy');
    expect(field.type).toBe('relationship');
    expect('relationTo' in field ? field.relationTo : undefined).toBe('users');
  });
});
