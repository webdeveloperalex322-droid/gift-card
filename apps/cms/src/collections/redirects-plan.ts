/**
 * Планировщик редиректов (задача Э1-06): чистое ядро правил, без Payload и без базы.
 *
 * Почему отдельный модуль, а не тело хука: правила редиректов — это защита URL,
 * то есть самая дорогая часть проекта («изменение существующего URL без
 * одиночного 301 — критическая ошибка», «цепочки редиректов запрещены»). Правило,
 * записанное внутри хука, проверяется только поднятой базой; вынесенное в чистую
 * функцию — обычным юнит-тестом на каждый случай, включая негативные.
 *
 * Что гарантирует планировщик (инварианты таблицы редиректов):
 *   1. `from` уникален — иначе поведение зависело бы от порядка строк;
 *   2. `from ≠ to` — редирект на себя даёт бесконечный цикл в браузере;
 *   3. ни один `to` не совпадает с чьим-либо `from` — то есть цепочек нет
 *      вообще, а не «они короткие». Новый редирект, создающий цепочку,
 *      схлопывается: `A→B` + `B→C` становится `A→C` (одиночный 301);
 *   4. цепочка, замыкающаяся в петлю, отклоняется, а не схлопывается;
 *   5. цепочка, ведущая на удалённый URL, превращается в 410 на всей длине:
 *      иначе `A→B` вело бы на страницу, которой нет.
 *
 * Чего планировщик НЕ делает: не проверяет, что `to` отвечает 200 (это задача
 * приёмки и `url-guard`), и не создаёт редирект при смене slug — атомарная
 * операция «сменить URL с 301» это задача Э1-09.
 */
import { canonicalizePath, looksLikeAbsoluteUrl } from '@otkritka/shared';

/** Коды из ТЗ §8.1. 302 и 307 в модели не существуют: перенос всегда постоянный. */
export const REDIRECT_CODES = ['301', '410'] as const;

export type RedirectCode = (typeof REDIRECT_CODES)[number];

export type RedirectRuleCode =
  | 'cycle'
  | 'duplicate-from'
  | 'invalid-code'
  | 'invalid-path'
  | 'loop'
  | 'missing-target'
  | 'unexpected-target';

/**
 * Отказ правила редиректов. Отдельный класс с машинным признаком `rule`:
 * тест обязан проверять, что отказ произошёл по ТОЙ причине, иначе зелёный
 * негативный тест может держаться на опечатке в пути.
 */
export class RedirectRuleError extends Error {
  readonly rule: RedirectRuleCode;

  constructor(rule: RedirectRuleCode, message: string) {
    super(message);
    this.name = 'RedirectRuleError';
    this.rule = rule;
  }
}

/** Сохранённая запись редиректа (нормализованная при записи). */
export interface RedirectRecord {
  readonly id?: number | string;
  readonly from: string;
  readonly to?: string | null;
  readonly code: RedirectCode;
}

/** Входные данные: приходят из REST/GraphQL, поэтому типы не гарантированы. */
export interface RedirectInput {
  readonly id?: number | string;
  readonly from?: unknown;
  readonly to?: unknown;
  readonly code?: unknown;
}

export interface RedirectRewrite {
  readonly id: number | string;
  readonly from: string;
  readonly previousTo: string | null;
  readonly to: string | null;
  readonly code: RedirectCode;
  readonly reason: string;
}

export interface RedirectPlan {
  /** Что записать в проверяемую запись после нормализации и схлопывания. */
  readonly redirect: {
    readonly from: string;
    readonly to: string | null;
    readonly code: RedirectCode;
  };
  /** Существующие записи, которые надо переписать, чтобы не возникла цепочка. */
  readonly rewrites: readonly RedirectRewrite[];
  /** Текст для редактора и журнала: что именно было изменено автоматически. */
  readonly warnings: readonly string[];
}

/**
 * Приводит путь редиректа к канонической форме.
 *
 * Абсолютный URL отклоняется: правило проекта — абсолютные адреса собираются
 * ЕДИНСТВЕННЫМ хелпером из `SITE_URL`, поэтому хост, вписанный редактором в
 * поле редиректа, был бы вторым источником хоста.
 *
 * @throws RedirectRuleError
 */
export function normalizeRedirectPath(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    return fail('invalid-path', 'Путь редиректа не задан. Ожидается путь от корня сайта, например /otkrytki/staraya-otkrytka.');
  }

  const raw = value.trim();

  // `looksLikeAbsoluteUrl` из общего пакета покрывает и схему (`https:`), и
  // протокольно-относительную форму (`//host/path`): это одно правило про один и
  // тот же риск — чужой хост вместо пути.
  if (looksLikeAbsoluteUrl(raw)) {
    return fail(
      'invalid-path',
      `«${raw}» — абсолютный URL. В редиректах задаётся путь от корня сайта: хост ` +
        'собирается единственным хелпером из SITE_URL, и второй его источник ' +
        'означал бы редиректы на чужой домен.',
    );
  }

  try {
    return canonicalizePath(raw);
  } catch (error) {
    return fail(
      'invalid-path',
      `«${raw}» не является путём: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function fail(rule: RedirectRuleCode, message: string): never {
  throw new RedirectRuleError(rule, message);
}

function assertCode(value: unknown): RedirectCode {
  if (typeof value === 'string' && (REDIRECT_CODES as readonly string[]).includes(value)) {
    return value as RedirectCode;
  }
  return fail(
    'invalid-code',
    `Код редиректа «${String(value)}» недопустим. Разрешены только ${REDIRECT_CODES.join(' и ')}: ` +
      'перенос страницы всегда постоянный (301), удаление без замены — 410.',
  );
}

function isEmptyTarget(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function sameId(left: number | string | undefined, right: number | string | undefined): boolean {
  return left !== undefined && right !== undefined && String(left) === String(right);
}

/**
 * Проверяет и достраивает редирект так, чтобы инварианты таблицы сохранились.
 *
 * @throws RedirectRuleError на любом нарушении: петля, дубль `from`,
 *   несоответствие кода и цели, цепочка, замыкающаяся в петлю.
 */
export function planRedirect(input: {
  readonly candidate: RedirectInput;
  readonly existing: readonly RedirectRecord[];
}): RedirectPlan {
  const { candidate, existing } = input;

  const from = normalizeRedirectPath(candidate.from);
  const code = assertCode(candidate.code);

  let target: string | null;
  if (code === '410') {
    if (!isEmptyTarget(candidate.to)) {
      return fail(
        'unexpected-target',
        `Редирект с кодом 410 не имеет цели, а задана «${String(candidate.to)}». ` +
          '410 означает «удалено без замены»; если замена есть — это 301.',
      );
    }
    target = null;
  } else {
    if (isEmptyTarget(candidate.to)) {
      return fail(
        'missing-target',
        'Редирект 301 без цели невозможен: 301 — это перенос на конкретный URL. ' +
          'Если замены нет, укажите код 410.',
      );
    }
    target = normalizeRedirectPath(candidate.to);
  }

  if (target === from) {
    return fail(
      'loop',
      `Редирект «${from}» на самого себя отклонён: браузер и краулер получат ` +
        'бесконечный цикл, а страница станет недоступной.',
    );
  }

  const others = existing.filter((record) => !sameId(record.id, candidate.id));

  const duplicate = others.find((record) => normalizeRedirectPath(record.from) === from);
  if (duplicate !== undefined) {
    return fail(
      'duplicate-from',
      `Для «${from}» редирект уже существует (цель «${duplicate.to ?? '— 410 —'}»). ` +
        'Два правила для одного пути делают ответ зависимым от порядка строк — ' +
        'исправьте существующую запись вместо создания второй.',
    );
  }

  const warnings: string[] = [];
  let finalTarget = target;
  let finalCode = code;

  // Прямое схлопывание: цель нового редиректа сама может быть источником другого.
  const visited = new Set<string>([from]);
  while (finalTarget !== null) {
    const next = others.find((record) => normalizeRedirectPath(record.from) === finalTarget);
    if (next === undefined) {
      break;
    }
    if (visited.has(finalTarget)) {
      return fail(
        'cycle',
        `Цепочка от «${from}» замыкается на «${finalTarget}». Схлопнуть её нельзя — ` +
          'сначала уберите существующий редирект, ведущий обратно.',
      );
    }
    visited.add(finalTarget);

    const via = finalTarget;
    if (next.code === '410') {
      finalTarget = null;
      finalCode = '410';
      warnings.push(
        `«${via}» помечен как удалённый (410), поэтому редирект «${from}» тоже сохранён как 410: ` +
          'иначе он вёл бы на страницу, которой нет.',
      );
      break;
    }

    finalTarget = normalizeRedirectPath(next.to);
    warnings.push(
      `Цепочка схлопнута: «${from}» ведёт сразу на «${finalTarget}», минуя «${via}». ` +
        'Цепочки редиректов запрещены — краулер теряет вес ссылки на каждом переходе.',
    );

    if (finalTarget === from) {
      return fail(
        'cycle',
        `Цепочка «${from}» → «${via}» → «${finalTarget}» замыкается в петлю. ` +
          'Редирект не создан: сначала уберите обратный переход.',
      );
    }
  }

  // Обратное схлопывание: всё, что вело на этот путь, обязано вести на конечную цель.
  const rewrites: RedirectRewrite[] = [];
  const rewritten = new Set<number | string>();
  const queue: string[] = [from];

  while (queue.length > 0) {
    const path = queue.shift();
    if (path === undefined) {
      break;
    }
    for (const record of others) {
      if (record.id === undefined || rewritten.has(record.id) || record.code !== '301') {
        continue;
      }
      const recordTo = isEmptyTarget(record.to) ? null : normalizeRedirectPath(record.to);
      if (recordTo !== path) {
        continue;
      }
      const recordFrom = normalizeRedirectPath(record.from);
      if (finalTarget !== null && finalTarget === recordFrom) {
        return fail(
          'cycle',
          `Схлопывание сделало бы «${recordFrom}» редиректом на самого себя. ` +
            'Редирект не создан: цель совпадает с источником существующего правила.',
        );
      }
      rewritten.add(record.id);
      const reason =
        finalCode === '410'
          ? `«${path}» удалён (410), поэтому «${recordFrom}» тоже отдаёт 410`
          : `«${recordFrom}» переписан на конечную цель «${String(finalTarget)}», чтобы не возникла цепочка`;
      rewrites.push({
        id: record.id,
        from: recordFrom,
        previousTo: recordTo,
        to: finalTarget,
        code: finalCode,
        reason,
      });
      warnings.push(
        `Цепочка схлопнута: «${recordFrom}» → «${path}» переписан в «${recordFrom}» → ` +
          `«${finalTarget ?? '410'}». Цепочки редиректов запрещены.`,
      );
      queue.push(recordFrom);
    }
  }

  return {
    redirect: { from, to: finalTarget, code: finalCode },
    rewrites,
    warnings,
  };
}
