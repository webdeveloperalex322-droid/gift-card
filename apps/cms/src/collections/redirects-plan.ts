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
 *      иначе `A→B` вело бы на страницу, которой нет;
 *   6. `from` не может быть маршрутом, который сайт обслуживает сам (задача
 *      Э4-06). Подробности — у {@link assertRedirectSourceFree}.
 *
 * Окружение приходит АРГУМЕНТОМ: правилу 6 нужен реестр зарезервированных
 * маршрутов, а путь админки в реестре вычисляется из `PAYLOAD_ADMIN_PATH`.
 * Чтение `process.env` внутри сделало бы правило непроверяемым на нестандартном
 * значении — том самом случае, ради которого путь админки и вычисляется.
 *
 * Чего планировщик НЕ делает: не проверяет, что `to` отвечает 200 (это задача
 * приёмки и `url-guard`), и не создаёт редирект при смене slug — атомарная
 * операция «сменить URL с 301» это задача Э1-09.
 */
import {
  type SharedEnv,
  canonicalizePath,
  checkReservedPath,
  currentEnv,
  looksLikeAbsoluteUrl,
} from '@otkritka/shared';

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
  /** Реестр маршрутов не собрался: `PAYLOAD_ADMIN_PATH` не задан или негоден. */
  | 'registry-unavailable'
  /** `from` — маршрут, который сайт обслуживает сам (Э4-06). */
  | 'reserved-from'
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

/**
 * Хвост отказа: где проходит граница правила. Один текст на все случаи, потому
 * что редактор, получивший отказ, спрашивает ровно это — «а что тогда можно».
 */
const SOURCE_RULE_BOUNDARY =
  'Ограничение касается только источника правила: цель редиректа (поле «to») на служебный ' +
  'путь, на каталог или на главную допустима, а пути ПОД контейнерами — /otkrytki/<slug>, ' +
  '/podborki/... — это обычные адреса записей, и переносить их можно.';

/**
 * Проверяет, что путь-ИСТОЧНИК редиректа не занят самим сайтом (задача Э4-06).
 *
 * Правило появилось по находке Э4-01/Э4-02: правило с `from = /`, `/search` или
 * `/o-proekte` создавалось без возражений, а нейтрализовал его уже рантайм
 * middleware (`apps/web/src/routing/redirects.ts`) — игнорировал и писал в лог.
 * Место неверное: 301 с адреса живой страницы делает её недостижимой, а причина
 * не видна ни в шаблоне, ни в записи — только в логе. Отказ обязан произойти при
 * сохранении, то есть одинаково в админке, REST и GraphQL.
 *
 * Проверка — тот же предикат, что у middleware (`checkReservedPath`), и это не
 * совпадение, а условие: правило, которое отклоняет одно, а игнорирует другое,
 * оставило бы записи, законные при сохранении и мёртвые в рантайме.
 *
 * Граница правила НЕ шире реестра, и это важнее самого запрета:
 *   - «занят целиком» и «контейнер» запрещены НА САМОМ пути. Редирект с
 *     `/otkrytki` увёл бы с каталога, с `/search` — с поиска;
 *   - пути ПОД контейнером разрешены: `/otkrytki/<slug>` и `/podborki/...` — это
 *     обычные адреса записей, и без редиректа с них перенос карточки был бы
 *     невозможен, то есть запрет сломал бы главное требование к URL;
 *   - к полю `to` правило не применяется вовсе: цель обязана быть достижимой, а
 *     служебная страница, каталог и главная достижимы.
 *
 * @throws RedirectRuleError с признаком `reserved-from` — путь занят сайтом;
 *   `registry-unavailable` — реестр не собрался (нет `PAYLOAD_ADMIN_PATH`).
 *   Второй случай не подменяется «разрешено»: без пути админки нельзя сказать,
 *   свободен ли путь, а дефолт зарезервировал бы не тот путь.
 */
export function assertRedirectSourceFree(from: string, env: SharedEnv): void {
  let availability;
  try {
    availability = checkReservedPath(from, env);
  } catch (error) {
    return fail(
      'registry-unavailable',
      `Редирект с «${from}» проверить нельзя: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (availability.available) {
    return;
  }

  return fail(
    'reserved-from',
    `Редирект с «${from}» создать нельзя: этот путь сайт обслуживает сам — ` +
      `${availability.reason}. 301 или 410 с адреса живой страницы сделал бы её ` +
      'недостижимой, а причина не была бы видна ни в шаблоне, ни в записи. ' +
      SOURCE_RULE_BOUNDARY,
  );
}

/**
 * Форма правила для `validate` поля `from`: возвращает `true` либо текст отказа.
 *
 * Существует РЯДОМ с проверкой в хуке, а не вместо неё. Валидацию поля Payload
 * умеет пропускать (например при сохранении черновика версии), а
 * `beforeChange` коллекции — нет, поэтому авторитетная проверка живёт в
 * планировщике. Здесь — та же формулировка, показанная редактору сразу в форме,
 * а не после отправки.
 *
 * Исключений не бросает даже при незаданном `PAYLOAD_ADMIN_PATH`: проблема
 * конфигурации обязана дойти до редактора текстом, а не пятисоткой, иначе она
 * выглядит как поломка админки.
 */
export function validateRedirectFrom(
  value: unknown,
  env: SharedEnv = currentEnv(),
): string | true {
  try {
    assertRedirectSourceFree(normalizeRedirectPath(value), env);
  } catch (error) {
    if (error instanceof RedirectRuleError) {
      return error.message;
    }
    throw error;
  }
  return true;
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
  /** Окружение для реестра маршрутов: путь админки в нём вычисляется. */
  readonly env?: SharedEnv;
  readonly existing: readonly RedirectRecord[];
}): RedirectPlan {
  const { candidate, existing } = input;
  const env = input.env ?? currentEnv();

  const from = normalizeRedirectPath(candidate.from);
  // Правило 6 проверяется ДО остальных: путь, который сайт обслуживает сам, не
  // становится законным ни от кода, ни от цели, ни от состояния таблицы.
  //
  // Проверяется только КАНДИДАТ. Остальные строки таблицы не перепроверяются:
  // унаследованную строку с занятым `from` рантайм и так игнорирует, а отказ на
  // ней сорвал бы правку любой соседней записи — то есть чужая ошибка блокировала
  // бы работу. Саму такую строку сохранить заново не выйдет (её `from` и есть
  // кандидат при обновлении), и это верно: чинится она удалением, как и советует
  // сообщение middleware.
  assertRedirectSourceFree(from, env);
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
