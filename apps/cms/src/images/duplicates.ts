/**
 * Визуальные дубли (задача Э2-05; ТЗ §6.7 п. 4, §8.3.2, решение Ч-08).
 *
 * Что здесь решается и почему именно так:
 *
 *   - **круг поиска — `published` И `review`** ({@link DUPLICATE_SEARCH_STATUSES}).
 *     Так требует ТЗ §6 п. 4, и сужение до одних опубликованных было бы не
 *     «мягче», а неверно: два похожих черновика доходили бы до публикации, не
 *     увидев друг друга;
 *   - **порог берётся из окружения** (`PHASH_DISTANCE_THRESHOLD`, дефолт 14 по
 *     Ч-08) внутри `@otkritka/images`. Своего порога здесь нет: два порога — это
 *     два разных вердикта «дубль» в проекте;
 *   - **вердикт не автоматический.** Похожие показываются редактору, а решение
 *     принимает человек. Но перевод в `review` при непустом наборе похожих
 *     БЛОКИРУЕТСЯ до явного решения — иначе предупреждение можно не заметить, а
 *     дальше дубль уходит в индекс (ТЗ §8.3.2);
 *   - **решение привязано к отпечатку набора** ({@link similarFingerprint}).
 *     Подтверждение «уникально», выданное для прежнего изображения, не должно
 *     открывать дорогу новому: после замены изображения набор похожих другой, и
 *     виза обязана устареть сама, без ручного сброса.
 *
 * Ограничение алгоритма, которое здесь не лечится (решение Ч-08): DCT-pHash не
 * инвариантен к повороту. Повёрнутый дубль не найдётся ни при каком пороге, и
 * это известное свойство, а не пробел реализации.
 */
import { createHash } from 'node:crypto';

import { findSimilarPerceptualHashes } from '@otkritka/images';

import { ContentRuleError } from '../collections/status-model';

/**
 * Статусы, среди которых ищутся похожие. Ровно два — так в ТЗ §6 п. 4.
 * `draft` не входит: черновиков может быть много, и предупреждать о каждом
 * наброске значило бы обесценить предупреждение.
 */
export const DUPLICATE_SEARCH_STATUSES = ['published', 'review'] as const;

/** Форма хеша: 16 hex (64 бита), как отдаёт `computePerceptualHash`. */
const PHASH_SHAPE = /^[0-9a-f]{16}$/i;

export type CardId = number | string;

export interface HashCandidate {
  readonly hash: string;
  readonly id: CardId;
}

export interface SimilarMatch {
  readonly distance: number;
  readonly id: CardId;
}

export interface FindSimilarInput {
  readonly candidates: readonly HashCandidate[];
  /** Запись, для которой ищем: из результата исключается. */
  readonly excludeId?: CardId | null;
  readonly hash: string;
  /** Явный порог; без него берётся `PHASH_DISTANCE_THRESHOLD` (дефолт 14). */
  readonly threshold?: number;
}

/**
 * Похожие среди кандидатов, по возрастанию расстояния.
 *
 * Кандидаты с пустым или неформатным хешем ОТБРАСЫВАЮТСЯ, а не валят поиск:
 * список приходит из базы, и запись, загруженная до появления pHash, не должна
 * отменять проверку остальных.
 */
export function findSimilarCards(input: FindSimilarInput): readonly SimilarMatch[] {
  if (!PHASH_SHAPE.test(input.hash)) {
    return [];
  }

  const usable = input.candidates
    .filter((candidate) => PHASH_SHAPE.test(candidate.hash))
    .filter((candidate) => String(candidate.id) !== String(input.excludeId ?? ''));

  const matches = findSimilarPerceptualHashes(
    input.hash,
    usable.map((candidate) => ({ hash: candidate.hash, id: String(candidate.id) })),
    input.threshold === undefined ? {} : { threshold: input.threshold },
  );

  const byStringId = new Map(usable.map((candidate) => [String(candidate.id), candidate.id]));

  return matches.map((match) => ({
    distance: match.distance,
    id: byStringId.get(match.id) ?? match.id,
  }));
}

/**
 * Отпечаток набора похожих: короткий хеш от собственного pHash и списка
 * найденных записей.
 *
 * Порядок не влияет (список сортируется), поэтому отпечаток не «дрожит» от
 * порядка выборки из базы. Значение хранится в записи рядом с решением редактора
 * и сравнивается при переходе статуса.
 */
export function similarFingerprint(input: {
  readonly hash: string;
  readonly ids: readonly CardId[];
}): string {
  const ids = [...input.ids].map((id) => String(id)).sort();
  return createHash('sha256')
    .update(`${input.hash}|${ids.join(',')}`)
    .digest('hex')
    .slice(0, 16);
}

/** Решение редактора о найденном наборе похожих. */
export const VISUAL_DUPLICATE_DECISIONS = ['unique', 'duplicate'] as const;

export type VisualDuplicateDecision = (typeof VISUAL_DUPLICATE_DECISIONS)[number];

export function isVisualDuplicateDecision(value: unknown): value is VisualDuplicateDecision {
  return typeof value === 'string' && (VISUAL_DUPLICATE_DECISIONS as readonly string[]).includes(value);
}

export interface VisualDuplicateGate {
  readonly decision: unknown;
  readonly decisionFor: unknown;
  /** Отпечаток НАЙДЕННОГО СЕЙЧАС набора: {@link similarFingerprint}. */
  readonly fingerprint: string;
  /**
   * Меняется ли СВЯЗЬ `cards.image` этой операцией.
   *
   * Поле обязательное, а не «необязательное со значением по умолчанию»:
   * забытый параметр тогда снимал бы калитку молча, и заметить это можно было бы
   * только по двум страницам с одной картинкой в выдаче.
   */
  readonly imageChanged: boolean;
  readonly nextStatus: unknown;
  readonly previousStatus: unknown;
  readonly similar: readonly SimilarMatch[];
}

/** Статусы, в которых страница уже видна проверяющему или поиску. */
function isForwardStatus(status: unknown): boolean {
  return status === 'review' || status === 'published';
}

/**
 * Блокирует появление второй страницы с той же картинкой, пока редактор не
 * решил, дубль это или нет.
 *
 * ДВА СЛУЧАЯ, оба обязательные:
 *
 *   1. ПЕРЕХОД `draft → review → published`. Править черновик с похожим
 *      изображением никто не запрещает — запрещено вести его дальше молча.
 *   2. ПОДМЕНА ИЗОБРАЖЕНИЯ у записи, которая уже в `review` или `published`.
 *      Этот случай был открыт (находка ревизии от 2026-08-22): проверка
 *      выходила по `!statusChanged`, поэтому поставить визуальный дубль на уже
 *      опубликованную карточку можно было без единого вопроса — оставалось
 *      только предупреждение в журнале, которого никто не читает. Норма при
 *      этом одна и та же: «в каталоге не появляются две страницы с одной
 *      картинкой» (ТЗ §6.7 п. 4), и от того, менялся ли при этом статус, она не
 *      зависит.
 *
 * ЧТО СЮДА НАМЕРЕННО НЕ ПОПАЛО: замена БАЙТОВ записи изображения
 * (`card-images`, Э2-06) при неизменной связи. Там pHash карточки тоже меняется,
 * но приходит это изменение через пересинхронизацию зеркала
 * (`upload-hooks.ts`), где сохранение карточки идёт с пустыми данными и
 * подтверждение редактора передать физически нечем: отказ на этой фазе завалил
 * бы всю операцию замены байтов с сообщением про постороннюю карточку.
 * Зафиксировано как открытый вопрос (`docs/otkrytye-voprosy.md`, Э3-03a-C), а не
 * закрыто здесь по догадке.
 *
 * @throws ContentRuleError с кодом `visual-duplicate-unresolved`.
 */
export function assertVisualDuplicateResolved(gate: VisualDuplicateGate): void {
  const statusChanged = gate.nextStatus !== gate.previousStatus;
  const goingForward = isForwardStatus(gate.nextStatus);
  const swapOnVisiblePage =
    gate.imageChanged && goingForward && isForwardStatus(gate.previousStatus);

  if ((!statusChanged && !swapOnVisiblePage) || !goingForward || gate.similar.length === 0) {
    return;
  }

  const list = gate.similar
    .map((match) => `#${String(match.id)} (расстояние ${String(match.distance)})`)
    .join(', ');
  const preamble =
    `Изображение визуально похоже на уже существующие открытки: ${list}. ` +
    'Круг поиска — published и review (ТЗ §6.7 п. 4).' +
    (swapOnVisiblePage && !statusChanged
      ? ` Карточка уже в статусе «${String(gate.previousStatus)}», и изображение меняется ` +
        'у неё на месте — решение требуется тем же порядком, что и при переводе дальше по ' +
        'статусам: страница уже видна, поэтому дубль появился бы сразу.'
      : '');

  if (gate.decision === 'duplicate') {
    throw new ContentRuleError(
      'visual-duplicate-unresolved',
      `${preamble} Запись помечена редактором как ДУБЛЬ, поэтому дальше не идёт: ` +
        'замените изображение или удалите запись. Смена статуса дубля в review означала бы, ' +
        'что в каталоге появятся две страницы с одной картинкой.',
    );
  }

  if (gate.decision !== 'unique') {
    throw new ContentRuleError(
      'visual-duplicate-unresolved',
      `${preamble} Переход заблокирован до явного решения редактора: в поле ` +
        '«Проверка визуальных дублей» выберите «уникально» (если совпадение ложное) или ' +
        '«это дубль». Автоматически такое решение не принимается — порог похожести ' +
        'подсказывает, но не выносит вердикт.',
    );
  }

  if (gate.decisionFor !== gate.fingerprint) {
    throw new ContentRuleError(
      'visual-duplicate-unresolved',
      `${preamble} Прежнее решение «уникально» устарело: оно выдано для другого набора ` +
        'похожих (изображение или круг похожих изменились). Подтвердите решение заново — ' +
        'иначе виза, выданная старой картинке, пропускала бы новую.',
    );
  }
}
