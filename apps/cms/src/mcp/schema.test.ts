import { describe, expect, it } from 'vitest';

import { type ToolSchema, parseArguments, toJsonSchema } from './schema';

const SCHEMA = {
  ids: { kind: 'idList', description: 'Идентификаторы', maxItems: 2 },
  limit: { kind: 'integer', description: 'Сколько', max: 50, min: 1 },
  title: { kind: 'string', description: 'Заголовок', maxLength: 10, required: true },
} as const satisfies ToolSchema;

describe('toJsonSchema', () => {
  it('выводит схему с required только из обязательных полей', () => {
    expect(toJsonSchema(SCHEMA)).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        ids: {
          type: 'array',
          description: 'Идентификаторы',
          items: { type: ['string', 'integer'] },
          maxItems: 2,
        },
        limit: { type: 'integer', description: 'Сколько', maximum: 50, minimum: 1 },
        title: { type: 'string', description: 'Заголовок', maxLength: 10 },
      },
      required: ['title'],
    });
  });

  it('переносит enum в схему', () => {
    const schema = {
      nodeKind: { kind: 'string', description: 'Вид', enum: ['group', 'topic'] },
    } as const satisfies ToolSchema;
    expect(toJsonSchema(schema).properties).toEqual({
      nodeKind: { type: 'string', description: 'Вид', enum: ['group', 'topic'] },
    });
  });
});

describe('parseArguments', () => {
  it('принимает корректные аргументы', () => {
    expect(parseArguments(SCHEMA, { ids: [1, 'abc'], limit: 5, title: 'Открытка' })).toEqual({
      ids: [1, 'abc'],
      limit: 5,
      title: 'Открытка',
    });
  });

  it('отвергает отсутствие обязательного поля, называя его', () => {
    expect(() => parseArguments(SCHEMA, {})).toThrow(/title/);
  });

  it('отвергает пустую строку в обязательном поле', () => {
    expect(() => parseArguments(SCHEMA, { title: '   ' })).toThrow(/обязательно/);
  });

  it('отвергает лишнее поле, а не игнорирует его', () => {
    expect(() => parseArguments(SCHEMA, { robots: 'index,follow', title: 'a' })).toThrow(/robots/);
  });

  it('отклоняет превышение maxLength, а не усекает', () => {
    expect(() => parseArguments(SCHEMA, { title: 'оченьдлинныйзаголовок' })).toThrow(/длиннее 10/);
  });

  it('не приводит строку к числу', () => {
    expect(() => parseArguments(SCHEMA, { limit: '5', title: 'a' })).toThrow(/целым числом/);
  });

  it('отвергает число вне диапазона', () => {
    expect(() => parseArguments(SCHEMA, { limit: 99, title: 'a' })).toThrow(/больше 50/);
    expect(() => parseArguments(SCHEMA, { limit: 0, title: 'a' })).toThrow(/меньше 1/);
  });

  it('отвергает не массив в idList', () => {
    expect(() => parseArguments(SCHEMA, { ids: 7, title: 'a' })).toThrow(/массивом/);
  });

  it('отвергает слишком длинный idList', () => {
    expect(() => parseArguments(SCHEMA, { ids: [1, 2, 3], title: 'a' })).toThrow(/больше 2/);
  });

  it('отвергает мусор внутри idList', () => {
    expect(() => parseArguments(SCHEMA, { ids: [{}], title: 'a' })).toThrow(/идентификатор/);
  });

  it('отвергает аргументы, которые не объект', () => {
    expect(() => parseArguments(SCHEMA, null)).toThrow(/объектом/);
    expect(() => parseArguments(SCHEMA, [])).toThrow(/объектом/);
  });

  it('перечисляет все нарушения сразу, а не первое', () => {
    try {
      parseArguments(SCHEMA, { limit: '5', robots: 'x' });
      expect.unreachable('разбор обязан был отказать');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/robots/);
      expect(message).toMatch(/limit/);
      expect(message).toMatch(/title/);
    }
  });

  it('необязательное отсутствующее поле не попадает в результат', () => {
    expect(parseArguments(SCHEMA, { title: 'a' })).toEqual({ title: 'a' });
  });
});
