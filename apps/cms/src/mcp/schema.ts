/**
 * Схемы аргументов инструментов: ОДНА декларация, ДВА потребителя.
 *
 * `tools/list` обязан отдать клиенту JSON Schema, а `tools/call` — проверить
 * пришедшие аргументы. Если записать это дважды, получится инструмент, чья схема
 * обещает одно, а проверка требует другого, и расхождение проявится не ошибкой
 * компиляции, а отказом у внешней модели, которая сделала ровно то, что ей
 * обещали. Поэтому декларация здесь одна, а {@link toJsonSchema} и
 * {@link parseArguments} — два вывода из неё.
 *
 * ПОЧЕМУ `additionalProperties: false` И ОТКАЗ НА ЛИШНЕМ ПОЛЕ. Лишнее поле в
 * аргументах почти всегда означает попытку записать то, чего внешнему редактору
 * нельзя: `status`, `robots`, `canonical`, `slug` опубликованной записи. Молчаливо
 * выброшенное поле повторило бы худшее свойство Payload — молчаливый отказ на
 * уровне поля, из-за которого модель считает операцию выполненной. Здесь это
 * громкий отказ с названием поля.
 *
 * ПОЧЕМУ ТИПЫ НЕ ПРИВОДЯТСЯ. `limit: '5'` отвергается, а не превращается в `5`.
 * Приведение типов — это догадка о намерении, а у инструмента, который правит
 * каталог, догадок быть не должно: строка там, где ожидалось число, означает, что
 * клиент собрал аргументы не по схеме, и об этом он обязан узнать сразу.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Полноценного валидатора JSON Schema (`zod`, `ajv`) — он не
 * добавляется зависимостью: набор видов полей закрыт четырьмя, и каждый проверяется
 * десятком строк. Зависимость ради них стоила бы дороже, чем стоит сам модуль.
 */

/** Описание одного аргумента. Набор видов закрыт намеренно. */
export type FieldSpec =
  | {
      readonly description: string;
      readonly enum?: readonly string[];
      readonly kind: 'string';
      readonly maxLength?: number;
      readonly required?: boolean;
    }
  | {
      readonly description: string;
      readonly kind: 'integer';
      readonly max?: number;
      readonly min?: number;
      readonly required?: boolean;
    }
  | { readonly description: string; readonly kind: 'boolean'; readonly required?: boolean }
  | {
      readonly description: string;
      readonly kind: 'idList';
      readonly maxItems?: number;
      readonly required?: boolean;
    };

export type ToolSchema = Readonly<Record<string, FieldSpec>>;

/** Значение аргумента после разбора. `idList` отдаётся как есть — id Payload бывают и числом, и строкой. */
export type ArgumentValue = string | number | boolean | readonly (string | number)[];

export type ParsedArguments = Readonly<Record<string, ArgumentValue>>;

/** Отказ разбора. Все найденные нарушения перечисляются сразу: клиенту нужен полный список, а не первое. */
export class InvalidArgumentsError extends Error {
  readonly details: readonly string[];

  constructor(details: readonly string[]) {
    super(`Аргументы не соответствуют схеме инструмента: ${details.join('; ')}`);
    this.name = 'InvalidArgumentsError';
    this.details = details;
  }
}

function fieldJsonSchema(spec: FieldSpec): Record<string, unknown> {
  switch (spec.kind) {
    case 'string':
      return {
        type: 'string',
        description: spec.description,
        ...(spec.maxLength === undefined ? {} : { maxLength: spec.maxLength }),
        ...(spec.enum === undefined ? {} : { enum: [...spec.enum] }),
      };
    case 'integer':
      return {
        type: 'integer',
        description: spec.description,
        ...(spec.min === undefined ? {} : { minimum: spec.min }),
        ...(spec.max === undefined ? {} : { maximum: spec.max }),
      };
    case 'boolean':
      return { type: 'boolean', description: spec.description };
    case 'idList':
      return {
        type: 'array',
        description: spec.description,
        items: { type: ['string', 'integer'] },
        ...(spec.maxItems === undefined ? {} : { maxItems: spec.maxItems }),
      };
  }
}

/** JSON Schema для `tools/list`. */
export function toJsonSchema(schema: ToolSchema): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(schema)) {
    properties[name] = fieldJsonSchema(spec);
    if (spec.required === true) {
      required.push(name);
    }
  }
  return { type: 'object', additionalProperties: false, properties, required };
}

function checkString(name: string, spec: FieldSpec & { kind: 'string' }, value: unknown): string[] {
  if (typeof value !== 'string') {
    return [`«${name}» ожидается строкой, получено ${typeof value}`];
  }
  const problems: string[] = [];
  if (spec.required === true && value.trim() === '') {
    problems.push(`«${name}» обязательно и не может быть пустой строкой`);
  }
  if (spec.maxLength !== undefined && value.length > spec.maxLength) {
    problems.push(
      `«${name}» длиннее ${String(spec.maxLength)} символов (${String(value.length)}). ` +
        'Значение отклоняется, а не усекается: усечённый текст выглядел бы как принятый.',
    );
  }
  if (spec.enum !== undefined && !spec.enum.includes(value)) {
    problems.push(`«${name}» принимает одно из: ${spec.enum.join(', ')}; получено «${value}»`);
  }
  return problems;
}

function checkInteger(
  name: string,
  spec: FieldSpec & { kind: 'integer' },
  value: unknown,
): string[] {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return [
      `«${name}» ожидается целым числом, получено ${typeof value === 'string' ? `строку «${value}»` : typeof value}. ` +
        'Приведение типов не делается намеренно: строка там, где ожидалось число, означает, ' +
        'что аргументы собраны не по схеме.',
    ];
  }
  const problems: string[] = [];
  if (spec.min !== undefined && value < spec.min) {
    problems.push(`«${name}» меньше ${String(spec.min)}`);
  }
  if (spec.max !== undefined && value > spec.max) {
    problems.push(`«${name}» больше ${String(spec.max)}`);
  }
  return problems;
}

function checkIdList(name: string, spec: FieldSpec & { kind: 'idList' }, value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [`«${name}» ожидается массивом идентификаторов`];
  }
  const problems: string[] = [];
  if (spec.maxItems !== undefined && value.length > spec.maxItems) {
    problems.push(`«${name}» содержит больше ${String(spec.maxItems)} элементов`);
  }
  for (const [index, item] of value.entries()) {
    const ok =
      (typeof item === 'number' && Number.isInteger(item)) ||
      (typeof item === 'string' && item.trim() !== '');
    if (!ok) {
      problems.push(`«${name}[${String(index)}]» не похож на идентификатор записи`);
    }
  }
  return problems;
}

/**
 * Разбирает аргументы вызова по схеме.
 *
 * @throws InvalidArgumentsError со полным списком нарушений.
 */
export function parseArguments(schema: ToolSchema, raw: unknown): ParsedArguments {
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    throw new InvalidArgumentsError(['аргументы ожидаются объектом']);
  }
  const incoming = (raw ?? {}) as Readonly<Record<string, unknown>>;
  const problems: string[] = [];
  const parsed: Record<string, ArgumentValue> = {};

  for (const name of Object.keys(incoming)) {
    if (!(name in schema)) {
      problems.push(
        `«${name}» не объявлено в схеме инструмента. Поле не игнорируется молча: лишний ` +
          'аргумент обычно означает попытку записать то, что внешнему редактору запрещено ' +
          '(status, robots, canonical, slug опубликованной записи).',
      );
    }
  }

  for (const [name, spec] of Object.entries(schema)) {
    const value = incoming[name];
    if (value === undefined || value === null) {
      if (spec.required === true) {
        problems.push(`«${name}» обязательно и не передано`);
      }
      continue;
    }
    switch (spec.kind) {
      case 'string': {
        const found = checkString(name, spec, value);
        problems.push(...found);
        if (found.length === 0) {
          parsed[name] = value as string;
        }
        break;
      }
      case 'integer': {
        const found = checkInteger(name, spec, value);
        problems.push(...found);
        if (found.length === 0) {
          parsed[name] = value as number;
        }
        break;
      }
      case 'boolean': {
        if (typeof value !== 'boolean') {
          problems.push(`«${name}» ожидается логическим значением`);
        } else {
          parsed[name] = value;
        }
        break;
      }
      case 'idList': {
        const found = checkIdList(name, spec, value);
        problems.push(...found);
        if (found.length === 0) {
          parsed[name] = value as readonly (string | number)[];
        }
        break;
      }
    }
  }

  if (problems.length > 0) {
    throw new InvalidArgumentsError(problems);
  }
  return parsed;
}
