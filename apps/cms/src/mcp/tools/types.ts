/**
 * Общие типы инструментов и — главное — ЧЕСТНОСТЬ ОТВЕТА.
 *
 * ═══ ГЛАВНАЯ ЛОВУШКА, ОТ КОТОРОЙ ЗАЩИЩАЕТ ЭТОТ ФАЙЛ ═══
 *
 * Отказ на уровне ПОЛЯ у Payload МОЛЧАЛИВЫЙ: правило доступа возвращает `false`,
 * поле вырезается из входных данных, на его место встаёт прежнее значение, ответ
 * — `200`. Разбор этого поведения по исходникам лежит в шапке
 * `src/access/policies.ts`, а живой набор `tests/api/` из-за него объявляет вид
 * отказа параметром `outcome: 'silent' | 'loud'`.
 *
 * Для внешней LLM это худшая из возможных форм отказа: она получает успех и
 * рапортует человеку, что открытка опубликована или что robots переключён. Код
 * ответа при этом ничего не доказывает.
 *
 * Поэтому каждый пишущий инструмент работает в три шага — записать, перечитать,
 * сравнить с запрошенным, — а {@link diffApplied} считает расхождение. Непустой
 * `ignored` для вызывающего означает ОШИБКУ, а не успех с оговоркой.
 *
 * ═══ ПРО ПРИЗНАК УСЕЧЕНИЯ ═══
 *
 * У выборок есть потолок (`GATEWAY_LIMIT_CEILING`). Молча обрезанный список
 * означает, что модель сочтёт тему готовой, не увидев остатка, — поэтому
 * {@link truncation} попадает в ответ каждого читающего инструмента, тем же
 * приёмом, что `scanTruncated` в дашборде.
 */
import type { McpGateway } from '../gateway';
import type { ToolSchema } from '../schema';

export interface ToolContext {
  readonly gateway: McpGateway;
}

export interface ToolDefinition {
  readonly description: string;
  readonly name: string;
  /** `true` — у клиента не нужно спрашивать подтверждение (MCP `readOnlyHint`). */
  readonly readOnly: boolean;
  readonly schema: ToolSchema;
  readonly title: string;
  run(ctx: ToolContext, args: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/**
 * Отказ инструмента по смыслу задачи: не нашли запись, вид узла не допускает
 * родителя, запись не в том статусе. Отличается от `InvalidArgumentsError`
 * (аргументы не по схеме) и от ошибки хука Payload (нарушено правило модели).
 */
export class ToolRefusal extends Error {
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(message);
    this.name = 'ToolRefusal';
    this.field = field;
  }
}

export interface IgnoredField {
  readonly actual: unknown;
  readonly field: string;
  readonly reason: string;
  readonly requested: unknown;
}

export interface WriteOutcome {
  readonly applied: Readonly<Record<string, unknown>>;
  /** `false` — запись уже существовала, повторный вызов ничего не создал. */
  readonly created: boolean;
  readonly id: number | string;
  readonly ignored: readonly IgnoredField[];
  readonly path: string | null;
  readonly status: string | null;
}

function sameValue(requested: unknown, saved: unknown): boolean {
  if (Array.isArray(requested) && Array.isArray(saved)) {
    if (requested.length !== saved.length) {
      return false;
    }
    // Связи сравниваются по строковому виду идентификатора: на `depth: 0` Payload
    // отдаёт id числом или строкой в зависимости от адаптера, и строгое равенство
    // показало бы расхождение там, где его нет.
    const normalize = (list: readonly unknown[]): string[] =>
      list
        .map((item) =>
          typeof item === 'object' && item !== null && 'id' in item
            ? String((item).id)
            : String(item),
        )
        .sort();
    return normalize(requested).join(',') === normalize(saved).join(',');
  }
  if (typeof requested === 'string' && typeof saved === 'string') {
    return requested === saved;
  }
  return String(requested) === String(saved);
}

/**
 * Какие из запрошенных полей не применились.
 *
 * Сравниваются только поля, которые вызывающий ПРОСИЛ изменить: всё остальное в
 * записи его не касается.
 */
export function diffApplied(args: {
  readonly requested: Readonly<Record<string, unknown>>;
  readonly saved: Readonly<Record<string, unknown>>;
}): readonly IgnoredField[] {
  const ignored: IgnoredField[] = [];
  for (const [field, requested] of Object.entries(args.requested)) {
    if (requested === undefined) {
      continue;
    }
    const actual = args.saved[field];
    if (!sameValue(requested, actual)) {
      ignored.push({
        actual: actual ?? null,
        field,
        reason:
          `значение не применилось: в записи осталось прежнее. У Payload отказ на уровне ` +
          'поля молчаливый — поле вырезается из входных данных, а ответ остаётся успешным, ' +
          'поэтому расхождение проверяется перечитыванием записи, а не кодом ответа.',
        requested,
      });
    }
  }
  return ignored;
}

/** Собирает значения, которые фактически записаны, для поля `applied` ответа. */
export function appliedValues(args: {
  readonly requested: Readonly<Record<string, unknown>>;
  readonly saved: Readonly<Record<string, unknown>>;
}): Readonly<Record<string, unknown>> {
  const applied: Record<string, unknown> = {};
  for (const field of Object.keys(args.requested)) {
    applied[field] = args.saved[field] ?? null;
  }
  return applied;
}

export interface Truncation {
  readonly returned: number;
  readonly total: number;
  /** `true` — отдано не всё; числа ответа являются НИЖНЕЙ границей. */
  readonly truncated: boolean;
}

export function truncation(args: { readonly returned: number; readonly total: number }): Truncation {
  return {
    returned: args.returned,
    total: args.total,
    truncated: args.returned < args.total,
  };
}

/** Убирает из данных ключи с `undefined`: Payload трактует их как «обнулить». */
export function definedOnly(
  source: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
