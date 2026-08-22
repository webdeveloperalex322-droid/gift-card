/**
 * Визуальные дубли: поиск похожих и блокировка перевода в review (Э2-05, DoD
 * «при похожем изображении перевод в review блокируется до явного решения
 * редактора»; ТЗ §6.7 п. 4, §8.3.2).
 *
 * TDD: тест написан до реализации. Главные проверки — негативные:
 *   - круг поиска ровно тот, что задан ТЗ: `published` И `review`. Сужение до
 *     одних опубликованных пропустило бы два похожих черновика, которые не
 *     увидели друг друга;
 *   - решение редактора привязано к ОТПЕЧАТКУ найденного набора: подтверждение,
 *     выданное для прежнего изображения, не открывает дорогу новому.
 */
import { describe, expect, it } from 'vitest';

import { ContentRuleError } from '../collections/status-model';
import {
  DUPLICATE_SEARCH_STATUSES,
  assertVisualDuplicateResolved,
  findSimilarCards,
  similarFingerprint,
} from './duplicates';

const HASH = 'ffffffffffffffff';
const NEAR = 'fffffffffffffff0';
const FAR = '0000000000000000';

describe('круг поиска похожих', () => {
  it('published и review — оба статуса, как требует ТЗ §6.7 п. 4', () => {
    expect([...DUPLICATE_SEARCH_STATUSES]).toEqual(['published', 'review']);
  });

  it('похожие возвращаются с расстоянием, по возрастанию', () => {
    const matches = findSimilarCards({
      candidates: [
        { hash: FAR, id: 3 },
        { hash: NEAR, id: 2 },
        { hash: HASH, id: 1 },
      ],
      hash: HASH,
      threshold: 14,
    });

    expect(matches.map((match) => match.id)).toEqual([1, 2]);
    expect(matches[0]?.distance).toBe(0);
    expect(matches[1]?.distance).toBe(4);
  });

  it('сама запись из результата исключается', () => {
    const matches = findSimilarCards({
      candidates: [{ hash: HASH, id: 7 }],
      excludeId: 7,
      hash: HASH,
      threshold: 14,
    });
    expect(matches).toEqual([]);
  });

  it('пустой или неизвестный хеш кандидата не валит поиск целиком', () => {
    // Кандидаты приходят из базы: запись, загруженная до появления pHash, не
    // должна отменять проверку остальных.
    const matches = findSimilarCards({
      candidates: [
        { hash: '', id: 1 },
        { hash: 'нехеш', id: 2 },
        { hash: NEAR, id: 3 },
      ],
      hash: HASH,
      threshold: 14,
    });
    expect(matches.map((match) => match.id)).toEqual([3]);
  });
});

describe('отпечаток набора похожих', () => {
  it('одинаков для одного набора и не зависит от порядка', () => {
    const a = similarFingerprint({ hash: HASH, ids: [2, 10, 3] });
    const b = similarFingerprint({ hash: HASH, ids: [10, 3, 2] });
    expect(a).toBe(b);
  });

  it('меняется при другом хеше и при другом составе набора', () => {
    const base = similarFingerprint({ hash: HASH, ids: [2, 3] });
    expect(similarFingerprint({ hash: NEAR, ids: [2, 3] })).not.toBe(base);
    expect(similarFingerprint({ hash: HASH, ids: [2, 3, 4] })).not.toBe(base);
    expect(similarFingerprint({ hash: HASH, ids: [] })).not.toBe(base);
  });
});

describe('блокировка перевода в review', () => {
  const similar = [{ distance: 4, id: 2 }];
  const fingerprint = similarFingerprint({ hash: HASH, ids: [2] });

  it('без похожих переход не трогается', () => {
    expect(() =>
      assertVisualDuplicateResolved({
        decision: null,
        decisionFor: null,
        fingerprint: similarFingerprint({ hash: HASH, ids: [] }),
        nextStatus: 'review',
        previousStatus: 'draft',
        similar: [],
      }),
    ).not.toThrow();
  });

  it('похожее изображение без решения редактора блокирует draft → review', () => {
    try {
      assertVisualDuplicateResolved({
        decision: null,
        decisionFor: null,
        fingerprint,
        nextStatus: 'review',
        previousStatus: 'draft',
        similar,
      });
      throw new Error('переход прошёл, хотя должен был быть заблокирован');
    } catch (error) {
      expect(error).toBeInstanceOf(ContentRuleError);
      expect((error as ContentRuleError).rule).toBe('visual-duplicate-unresolved');
      expect((error as ContentRuleError).message).toContain('2');
    }
  });

  it('блокирует и review → published: непроверенный дубль не уходит в индекс', () => {
    expect(() =>
      assertVisualDuplicateResolved({
        decision: null,
        decisionFor: null,
        fingerprint,
        nextStatus: 'published',
        previousStatus: 'review',
        similar,
      }),
    ).toThrow(ContentRuleError);
  });

  it('решение «уникально» для ЭТОГО набора открывает переход', () => {
    expect(() =>
      assertVisualDuplicateResolved({
        decision: 'unique',
        decisionFor: fingerprint,
        fingerprint,
        nextStatus: 'review',
        previousStatus: 'draft',
        similar,
      }),
    ).not.toThrow();
  });

  it('решение, выданное для ДРУГОГО набора, не действует', () => {
    // Иначе подтверждение уникальности пережило бы замену изображения — и
    // новый дубль прошёл бы по старой визе.
    expect(() =>
      assertVisualDuplicateResolved({
        decision: 'unique',
        decisionFor: similarFingerprint({ hash: NEAR, ids: [2] }),
        fingerprint,
        nextStatus: 'review',
        previousStatus: 'draft',
        similar,
      }),
    ).toThrow(/устарел/i);
  });

  it('решение «это дубль» переход не открывает', () => {
    expect(() =>
      assertVisualDuplicateResolved({
        decision: 'duplicate',
        decisionFor: fingerprint,
        fingerprint,
        nextStatus: 'review',
        previousStatus: 'draft',
        similar,
      }),
    ).toThrow(/дубл/i);
  });

  it('правки внутри draft не блокируются: проверка стоит на переходе', () => {
    expect(() =>
      assertVisualDuplicateResolved({
        decision: null,
        decisionFor: null,
        fingerprint,
        nextStatus: 'draft',
        previousStatus: 'draft',
        similar,
      }),
    ).not.toThrow();
  });
});
