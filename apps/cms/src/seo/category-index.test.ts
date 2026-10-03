/**
 * Тесты отбора карточек для открытия в индекс.
 *
 * Проверяется ровно то, что в этом модуле может тихо сломаться и пустить
 * страницу в поиск или, наоборот, снять страховку: состав жёстких шлюзов,
 * невозможность молчаливого отключения шлюза дублей, разделение «решение
 * редактора есть / решения нет» и применение по явному списку.
 */
import { describe, expect, it } from 'vitest';

import {
  type CategoryCardFacts,
  DEFAULT_ATTENTION_THRESHOLDS,
  collectAttention,
  countCrawlPagesAfter,
  findHardGates,
  medianDescriptionLength,
  resolveRequestedSlugs,
} from './category-index.js';

function card(over: Partial<CategoryCardFacts> = {}): CategoryCardFacts {
  return {
    canonical: '',
    duplicateDecision: null,
    duplicateDecisionCurrent: false,
    duplicateScanTruncated: false,
    description: 'Описание открытки достаточной длины, чтобы не попасть в поводы для правки текста.',
    hasDerivatives: true,
    hasImage: true,
    id: 1,
    metaConflicts: 0,
    metaDescription: 'x'.repeat(140),
    robots: 'noindex,follow',
    similarDistances: [],
    slug: 'otkrytka-primer',
    status: 'published',
    title: 'Новогодняя открытка со снеговиком',
    ...over,
  };
}

describe('жёсткие шлюзы', () => {
  it('пропускают карточку, у которой всё на месте', () => {
    expect(findHardGates([card()], 14)).toEqual([]);
  });

  it('держат неопубликованную: хук всё равно откажет', () => {
    const gates = findHardGates([card({ status: 'review' })], 14);
    expect(gates.map((g) => g.code)).toEqual(['not-published']);
  });

  it('держат карточку без изображения: страница отвечает 404', () => {
    const gates = findHardGates([card({ hasImage: false })], 14);
    expect(gates.map((g) => g.code)).toEqual(['no-image']);
  });

  it('держат карточку со связью, но без производных: показать открытку нечем', () => {
    const gates = findHardGates([card({ hasDerivatives: false })], 14);
    expect(gates.map((g) => g.code)).toEqual(['no-image']);
  });

  it('держат переопределённый canonical: страница не попала бы в карту сайта', () => {
    const gates = findHardGates([card({ canonical: 'https://example.test/other' })], 14);
    expect(gates.map((g) => g.code)).toEqual(['canonical-override']);
  });

  it('держат пустой description: сработает index-requires-description', () => {
    const gates = findHardGates([card({ metaDescription: '   ' })], 14);
    expect(gates.map((g) => g.code)).toEqual(['empty-meta-description']);
  });

  it('держат конфликт метатегов', () => {
    const gates = findHardGates([card({ metaConflicts: 2 })], 14);
    expect(gates.map((g) => g.code)).toEqual(['meta-conflict']);
  });

  it('держат неразрешённый дубль на пороге и пропускают за порогом', () => {
    expect(findHardGates([card({ similarDistances: [14] })], 14).map((g) => g.code)).toEqual([
      'visual-duplicate-unresolved',
    ]);
    expect(findHardGates([card({ similarDistances: [15, 18] })], 14)).toEqual([]);
  });

  it('не держат сходство, по которому редактор решил «уникально»', () => {
    // Иначе выдуманный порог блокировал бы решение человека, а платформа тут не
    // защищает: хук на правку robots не срабатывает.
    const resolved = card({
      duplicateDecision: 'unique',
      duplicateDecisionCurrent: true,
      similarDistances: [8],
    });
    expect(findHardGates([resolved], 14)).toEqual([]);
    expect(collectAttention([resolved]).map((a) => a.code)).toContain('visual-duplicate-resolved');
  });

  it('держат сходство, по которому решение «это дубль»', () => {
    const duplicate = card({ duplicateDecision: 'duplicate', similarDistances: [8] });
    expect(findHardGates([duplicate], 14).map((g) => g.code)).toEqual([
      'visual-duplicate-unresolved',
    ]);
  });

  it('держат УСТАРЕВШЕЕ решение «уникально» так же, как отсутствие решения', () => {
    // Платформа считает решением только выданное для текущего набора похожих
    // (`decisionFor` против отпечатка). Шлюз, читающий одно `decision`, был бы
    // мягче самой платформы: виза старой картинки пропускала бы новую.
    const stale = card({
      duplicateDecision: 'unique',
      duplicateDecisionCurrent: false,
      similarDistances: [8],
    });
    expect(findHardGates([stale], 14).map((g) => g.code)).toEqual([
      'visual-duplicate-unresolved',
    ]);
    expect(collectAttention([stale]).map((a) => a.code)).not.toContain(
      'visual-duplicate-resolved',
    );
  });

  it('падают на нечисловом пороге, а не выключают шлюз дублей молча', () => {
    expect(() => findHardGates([card({ similarDistances: [2] })], Number.NaN)).toThrow(
      /Порог pHash должен быть числом/,
    );
  });
});

describe('поводы для решения человека', () => {
  it('не блокируют, а перечисляются отдельно от шлюзов', () => {
    const thin = card({ description: 'Коротко.' });
    expect(findHardGates([thin], 14)).toEqual([]);
    expect(collectAttention([thin]).map((a) => a.code)).toContain('thin-description');
  });

  it('ловят общий зачин title, когда карточек не меньше порога', () => {
    const cards = Array.from({ length: DEFAULT_ATTENTION_THRESHOLDS.sharedPrefixFrom }, (_, i) =>
      card({ id: i + 1, slug: `s-${String(i)}`, title: 'С Новым годом! — сюжет ' + String(i) }),
    );
    const shared = collectAttention(cards).filter((a) => a.code === 'shared-title-prefix');
    expect(shared).toHaveLength(1);
    expect(shared[0]?.cards).toHaveLength(DEFAULT_ATTENTION_THRESHOLDS.sharedPrefixFrom);
  });

  it('не считает зачин поводом, когда карточек меньше порога', () => {
    const cards = Array.from({ length: DEFAULT_ATTENTION_THRESHOLDS.sharedPrefixFrom - 1 }, (_, i) =>
      card({ id: i + 1, slug: `s-${String(i)}`, title: 'С Новым годом! — сюжет ' + String(i) }),
    );
    expect(collectAttention(cards).map((a) => a.code)).not.toContain('shared-title-prefix');
  });

  it('называет обрезанный обход похожих поводом', () => {
    const truncated = card({ duplicateScanTruncated: true });
    expect(collectAttention([truncated]).map((a) => a.code)).toContain('duplicate-scan-truncated');
  });

  it('считает медиану длины текста на чётном и нечётном наборе', () => {
    expect(medianDescriptionLength([card({ description: 'aaa' })])).toBe(3);
    expect(
      medianDescriptionLength([card({ description: 'aa' }), card({ description: 'aaaa' })]),
    ).toBe(3);
    expect(medianDescriptionLength([])).toBe(0);
  });
});

describe('применение по явному списку', () => {
  it('находит названные slug и сообщает о ненайденных', () => {
    const cards = [card({ slug: 'a' }), card({ id: 2, slug: 'b' })];
    const resolved = resolveRequestedSlugs(cards, ['b', 'нет-такого']);
    expect(resolved.picked.map((c) => c.slug)).toEqual(['b']);
    expect(resolved.missing).toEqual(['нет-такого']);
  });

  it('не додумывает карточки, которых в списке нет', () => {
    const cards = [card({ slug: 'a' }), card({ id: 2, slug: 'b' })];
    expect(resolveRequestedSlugs(cards, ['a']).picked.map((c) => c.slug)).toEqual(['a']);
  });
});

describe('счёт страниц для обхода', () => {
  it('складывает карточки, узлы и открываемые сейчас как нижнюю оценку', () => {
    expect(
      countCrawlPagesAfter({
        indexableCards: 10,
        indexableNodes: 6,
        opening: 44,
      }),
    ).toBe(60);
  });
});
