/**
 * Дубли метатегов (задача Э5-01; ТЗ §8.3.1): чистое ядро правил.
 *
 * TDD: файл написан до реализации. Главные проверки негативные, потому что
 * ценность правила измеряется тем, что оно НЕ пропускает:
 *   - совпадение ищется по обеим контентным коллекциям сразу. title и
 *     description — это выдача поисковика, а не путь: конфликт «карточка против
 *     подборки» такой же настоящий, как «карточка против карточки»;
 *   - подтверждение привязано к ОТПЕЧАТКУ набора конфликтов, поэтому виза,
 *     выданная для прежнего заголовка, не действует для нового;
 *   - пустое значение конфликтом не считается: пустой description уже наказан
 *     отдельным правилом (`index-requires-description`), а «все пустые совпадают
 *     со всеми пустыми» превратило бы предупреждение в шум.
 */
import { describe, expect, it } from 'vitest';

import { DUPLICATE_SEARCH_STATUSES } from '../images/duplicates';
import {
  type MetaConflict,
  MAX_LISTED_META_CONFLICTS,
  META_DUPLICATE_FIELDS,
  META_DUPLICATE_SEARCH_STATUSES,
  assertMetaConflictResolved,
  assertMetaUniqueForIndex,
  describeMetaConflicts,
  metaConflictFingerprint,
  normalizeMetaValue,
  readMetaConflictFacts,
} from './meta-duplicates';
import { ContentRuleError } from './status-model';

const CARD_CONFLICT: MetaConflict = {
  documentCollection: 'cards',
  documentId: '42',
  field: 'title',
  path: '/otkrytki/otkrytka-mame',
  status: 'published',
  title: 'Открытка маме',
};

const NODE_CONFLICT: MetaConflict = {
  documentCollection: 'collections',
  documentId: '7',
  field: 'metaDescription',
  path: '/podborki/prazdniki/8-marta',
  status: 'review',
  title: 'Открытки к 8 Марта',
};

function fingerprintOf(conflicts: readonly MetaConflict[], total = conflicts.length): string {
  return metaConflictFingerprint({
    conflicts,
    descriptionKey: 'opisanie',
    titleKey: 'zagolovok',
    total,
  });
}

describe('нормализация значения метатега', () => {
  it('регистр и лишние пробелы не создают «разных» значений', () => {
    // Иначе конфликт «решался» бы заглавной буквой: в выдаче поисковика это
    // тот же самый заголовок.
    expect(normalizeMetaValue('  Открытка   Маме  ')).toBe('открытка маме');
    expect(normalizeMetaValue('открытка маме')).toBe(normalizeMetaValue('ОТКРЫТКА МАМЕ'));
  });

  it('неразрывный пробел и перевод строки — тот же пробел', () => {
    expect(normalizeMetaValue('Открытка\u00A0маме')).toBe('открытка маме');
    expect(normalizeMetaValue('Открытка\nмаме')).toBe('открытка маме');
  });

  it('пусто — это null, а не пустая строка', () => {
    expect(normalizeMetaValue('')).toBeNull();
    expect(normalizeMetaValue('   ')).toBeNull();
    expect(normalizeMetaValue(undefined)).toBeNull();
    expect(normalizeMetaValue(null)).toBeNull();
    expect(normalizeMetaValue(42)).toBeNull();
  });

  it('пунктуация и «ё» значение меняют: над-нормализация запрещена', () => {
    // Слишком широкая нормализация даёт ложные блокировки, а редактор выходит из
    // них ухудшением заголовка. «Все» и «всё» — разные слова.
    expect(normalizeMetaValue('Открытка маме!')).not.toBe(normalizeMetaValue('Открытка маме'));
    expect(normalizeMetaValue('все')).not.toBe(normalizeMetaValue('всё'));
  });
});

describe('круг поиска конфликтов', () => {
  it('published и review — те же два статуса, что у визуальных дублей', () => {
    expect([...META_DUPLICATE_SEARCH_STATUSES]).toEqual(['published', 'review']);
  });

  it('константа СВОЯ, а не переиспользованная у визуальных дублей', () => {
    // Совпадение значений сегодня — не повод связать два правила одной
    // константой: круг поиска визуальных дублей задан ТЗ §6.7 п. 4, круг поиска
    // дублей метатегов — ТЗ §8.3.1, и меняться они могут порознь. Тот же приём,
    // что у `canEditSlug` и `canReplaceImage` в access-политиках.
    expect(META_DUPLICATE_SEARCH_STATUSES).not.toBe(DUPLICATE_SEARCH_STATUSES);
    expect([...META_DUPLICATE_SEARCH_STATUSES]).toEqual([...DUPLICATE_SEARCH_STATUSES]);
  });

  it('сравниваются ровно два поля: title и metaDescription', () => {
    expect([...META_DUPLICATE_FIELDS]).toEqual(['title', 'metaDescription']);
  });
});

describe('отпечаток набора конфликтов', () => {
  it('не зависит от порядка записей в наборе', () => {
    expect(fingerprintOf([CARD_CONFLICT, NODE_CONFLICT])).toBe(
      fingerprintOf([NODE_CONFLICT, CARD_CONFLICT]),
    );
  });

  it('меняется от состава набора, от значений метатегов и от общего числа', () => {
    const base = fingerprintOf([CARD_CONFLICT]);
    expect(fingerprintOf([CARD_CONFLICT, NODE_CONFLICT])).not.toBe(base);
    expect(fingerprintOf([])).not.toBe(base);
    // Число найденных сверх показанных тоже входит в отпечаток: иначе при
    // усечённом списке появление нового конфликта не устаревало бы визу.
    expect(fingerprintOf([CARD_CONFLICT], 5)).not.toBe(base);
    expect(
      metaConflictFingerprint({
        conflicts: [CARD_CONFLICT],
        descriptionKey: 'opisanie',
        titleKey: 'drugoy-zagolovok',
        total: 1,
      }),
    ).not.toBe(base);
  });

  it('различает совпадение по title и совпадение по description у одной записи', () => {
    const byTitle = fingerprintOf([CARD_CONFLICT]);
    const byDescription = fingerprintOf([{ ...CARD_CONFLICT, field: 'metaDescription' }]);
    expect(byDescription).not.toBe(byTitle);
  });
});

describe('перевод в review при неразрешённом конфликте', () => {
  const conflicts = [CARD_CONFLICT];
  const fingerprint = fingerprintOf(conflicts);

  it('без конфликтов переход не трогается', () => {
    expect(() =>
      assertMetaConflictResolved({
        conflicts: [],
        confirmedFor: null,
        confirmedNow: false,
        fingerprint: fingerprintOf([]),
        metaChanged: true,
        nextStatus: 'review',
        previousStatus: 'draft',
      }),
    ).not.toThrow();
  });

  it('draft → review без подтверждения отклоняется, и отказ называет страницу', () => {
    try {
      assertMetaConflictResolved({
        conflicts,
        confirmedFor: null,
        confirmedNow: false,
        fingerprint,
        metaChanged: false,
        nextStatus: 'review',
        previousStatus: 'draft',
      });
      throw new Error('переход прошёл, хотя должен был быть заблокирован');
    } catch (error) {
      expect(error).toBeInstanceOf(ContentRuleError);
      expect((error as ContentRuleError).rule).toBe('meta-duplicate-unresolved');
      // «Со ссылками на конфликтующие страницы» — дословное требование ТЗ §8.3.1.
      expect((error as ContentRuleError).message).toContain('/otkrytki/otkrytka-mame');
    }
  });

  it('review → published тоже закрыт: набор конфликтов мог измениться после review', () => {
    expect(() =>
      assertMetaConflictResolved({
        conflicts,
        confirmedFor: null,
        confirmedNow: false,
        fingerprint,
        metaChanged: false,
        nextStatus: 'published',
        previousStatus: 'review',
      }),
    ).toThrow(ContentRuleError);
  });

  it('подтверждение ДЛЯ ЭТОГО набора переход открывает', () => {
    expect(() =>
      assertMetaConflictResolved({
        conflicts,
        confirmedFor: fingerprint,
        confirmedNow: false,
        fingerprint,
        metaChanged: false,
        nextStatus: 'review',
        previousStatus: 'draft',
      }),
    ).not.toThrow();
  });

  /**
   * Находка ревизии от 2026-08-29.
   *
   * Сценарий целиком: `ai-editor` подтвердил совпадение на переходе
   * `draft → review`; набор конфликтующих страниц с тех пор не изменился, значит
   * отпечаток совпадает; публикацию делает уже `admin` — и она проходила молча.
   * Прежний тест «review → published тоже закрыт» этот путь не ловил: он подавал
   * `confirmedFor: null`, то есть проверял случай, когда визы НЕТ, а не случай,
   * когда виза унаследована.
   */
  it('виза, выданная на прежнем переходе, не переносится на публикацию', () => {
    try {
      assertMetaConflictResolved({
        conflicts,
        confirmedFor: fingerprint,
        confirmedNow: false,
        fingerprint,
        metaChanged: false,
        nextStatus: 'published',
        previousStatus: 'review',
      });
      throw new Error('публикация прошла по унаследованному подтверждению');
    } catch (error) {
      expect(error).toBeInstanceOf(ContentRuleError);
      expect((error as ContentRuleError).rule).toBe('meta-duplicate-unresolved');
      // Отказ обязан объяснить, что дело не в устаревшей визе, а в чужой.
      expect((error as ContentRuleError).message).toMatch(/раньше и другим переходом/i);
      expect((error as ContentRuleError).message).not.toMatch(/устарел/i);
    }
  });

  it('подтверждение В ТОМ ЖЕ сохранении публикацию открывает', () => {
    expect(() =>
      assertMetaConflictResolved({
        conflicts,
        confirmedFor: fingerprint,
        confirmedNow: true,
        fingerprint,
        metaChanged: false,
        nextStatus: 'published',
        previousStatus: 'review',
      }),
    ).not.toThrow();
  });

  it('на переход в review унаследованной визы по-прежнему достаточно', () => {
    // Иначе штатный путь агента (подтвердил и сохранил) требовал бы повторного
    // подтверждения на каждое следующее сохранение черновика.
    expect(() =>
      assertMetaConflictResolved({
        conflicts,
        confirmedFor: fingerprint,
        confirmedNow: false,
        fingerprint,
        metaChanged: true,
        nextStatus: 'review',
        previousStatus: 'review',
      }),
    ).not.toThrow();
  });

  it('подтверждение, выданное для ДРУГОГО набора, не действует', () => {
    expect(() =>
      assertMetaConflictResolved({
        conflicts,
        confirmedFor: fingerprintOf([NODE_CONFLICT]),
        confirmedNow: false,
        fingerprint,
        metaChanged: false,
        nextStatus: 'review',
        previousStatus: 'draft',
      }),
    ).toThrow(/устарел/i);
  });

  it('правки внутри draft не блокируются: калитка стоит на переходе', () => {
    expect(() =>
      assertMetaConflictResolved({
        conflicts,
        confirmedFor: null,
        confirmedNow: false,
        fingerprint,
        metaChanged: true,
        nextStatus: 'draft',
        previousStatus: 'draft',
      }),
    ).not.toThrow();
  });

  it('снятие с публикации не блокируется: назад калитка не стоит', () => {
    expect(() =>
      assertMetaConflictResolved({
        conflicts,
        confirmedFor: null,
        confirmedNow: false,
        fingerprint,
        metaChanged: true,
        nextStatus: 'draft',
        previousStatus: 'published',
      }),
    ).not.toThrow();
  });
});

/**
 * Правка метатега на УЖЕ ВИДНОЙ странице.
 *
 * Тот же класс, что подмена изображения у опубликованной карточки (находка
 * ревизии от 2026-08-22, `../images/duplicates.ts`): статус не меняется, а две
 * страницы с одинаковым title появляются сразу — потому что обе уже видны.
 */
describe('правка метатега у записи, которая уже в review или published', () => {
  const conflicts = [CARD_CONFLICT];
  const fingerprint = fingerprintOf(conflicts);

  it('published → published со сменой title блокируется без подтверждения', () => {
    expect(() =>
      assertMetaConflictResolved({
        conflicts,
        confirmedFor: null,
        confirmedNow: false,
        fingerprint,
        metaChanged: true,
        nextStatus: 'published',
        previousStatus: 'published',
      }),
    ).toThrow(ContentRuleError);
  });

  it('сохранение published БЕЗ правки метатегов не блокируется', () => {
    // Иначе на калитке падала бы любая правка текста опубликованной страницы —
    // включая ту, которой конфликт и разрешают.
    expect(() =>
      assertMetaConflictResolved({
        conflicts,
        confirmedFor: null,
        confirmedNow: false,
        fingerprint,
        metaChanged: false,
        nextStatus: 'published',
        previousStatus: 'published',
      }),
    ).not.toThrow();
  });
});

/**
 * Уникальность метатегов как условие ИНДЕКСАЦИИ (п. 5.1, чек-лист п. 22).
 *
 * Находка ревизии от 2026-08-29: включение `index,follow` у уже опубликованной
 * записи не меняет ни статуса, ни метатегов, поэтому калитка перехода на нём не
 * срабатывала вовсе — механика уникальности была построена, но к решению об
 * индексации не подключена.
 */
describe('открытие в index,follow при совпадении метатегов', () => {
  const conflicts = [CARD_CONFLICT];

  it('отклоняется, и отказ называет и страницу, и конфликтующую', () => {
    try {
      assertMetaUniqueForIndex({
        conflicts,
        confirmedNow: false,
        indexOpening: true,
        path: '/podborki/prazdniki/8-marta',
      });
      throw new Error('индексация открылась при совпадении заголовков');
    } catch (error) {
      expect(error).toBeInstanceOf(ContentRuleError);
      expect((error as ContentRuleError).rule).toBe('index-requires-unique-meta');
      expect((error as ContentRuleError).message).toContain('/podborki/prazdniki/8-marta');
      expect((error as ContentRuleError).message).toContain('/otkrytki/otkrytka-mame');
    }
  });

  it('совпадение по description закрывает индексацию так же, как по title', () => {
    // Оба поля — отдельные пункты чек-листа приёмки п. 22; блокировать только
    // заголовок значило бы отдать description приёмке, где он стоит дороже.
    expect(() =>
      assertMetaUniqueForIndex({
        conflicts: [NODE_CONFLICT],
        confirmedNow: false,
        indexOpening: true,
        path: '/otkrytki/otkrytka-mame',
      }),
    ).toThrow(ContentRuleError);
  });

  it('без совпадений и без открытия индексации калитка молчит', () => {
    expect(() =>
      assertMetaUniqueForIndex({
        conflicts: [],
        confirmedNow: false,
        indexOpening: true,
        path: '/otkrytki/otkrytka-mame',
      }),
    ).not.toThrow();
    expect(() =>
      assertMetaUniqueForIndex({
        conflicts,
        confirmedNow: false,
        indexOpening: false,
        path: '/otkrytki/otkrytka-mame',
      }),
    ).not.toThrow();
  });

  it('явное подтверждение в том же сохранении открывает: решает человек', () => {
    expect(() =>
      assertMetaUniqueForIndex({
        conflicts,
        confirmedNow: true,
        indexOpening: true,
        path: '/otkrytki/otkrytka-mame',
      }),
    ).not.toThrow();
  });

  it('унаследованного подтверждения мало: параметра «виза из записи» здесь нет', () => {
    // Калитка принимает только `confirmedNow`. Это не упущение: индексацию
    // открывает admin отдельным действием, и решение по совпадению — часть
    // именно этого действия.
    expect(() =>
      assertMetaUniqueForIndex({
        conflicts,
        confirmedNow: false,
        indexOpening: true,
        path: null,
      }),
    ).toThrow(ContentRuleError);
  });
});

describe('описание набора конфликтов', () => {
  it('без конфликтов говорит именно это, а не молчит', () => {
    const summary = describeMetaConflicts({ conflicts: [], total: 0, truncated: false });
    expect(summary).toMatch(/не найден/i);
  });

  it('называет поле, путь и статус конфликтующей записи', () => {
    const summary = describeMetaConflicts({
      conflicts: [CARD_CONFLICT, NODE_CONFLICT],
      total: 2,
      truncated: false,
    });
    expect(summary).toContain('/otkrytki/otkrytka-mame');
    expect(summary).toContain('/podborki/prazdniki/8-marta');
    expect(summary).toContain('published');
  });

  it('усечённый список говорит, что он усечён', () => {
    const summary = describeMetaConflicts({
      conflicts: [CARD_CONFLICT],
      total: 40,
      truncated: true,
    });
    expect(summary).toContain('40');
    expect(summary).toMatch(/показан|усеч/i);
  });

  it('предел списка положителен и невелик: это предупреждение, а не выгрузка', () => {
    expect(MAX_LISTED_META_CONFLICTS).toBeGreaterThan(0);
    expect(MAX_LISTED_META_CONFLICTS).toBeLessThanOrEqual(50);
  });
});

describe('чтение сохранённого снимка конфликтов', () => {
  it('терпит мусор в значении: снимок читается на КАЖДОМ чтении записи', () => {
    expect(readMetaConflictFacts(undefined)).toEqual({
      conflicts: [],
      total: 0,
      truncated: false,
    });
    expect(readMetaConflictFacts({ conflicts: 'нет', total: 'много' })).toEqual({
      conflicts: [],
      total: 0,
      truncated: false,
    });
  });

  it('строка без известного поля отбрасывается, а не считается конфликтом', () => {
    const facts = readMetaConflictFacts({
      conflicts: [
        { documentCollection: 'cards', documentId: '1', field: 'nesushchestvuyushchee' },
        CARD_CONFLICT,
      ],
      total: 2,
      truncated: false,
    });
    expect(facts.conflicts).toEqual([CARD_CONFLICT]);
    // total сохраняется как есть: он считается базой, а не длиной списка.
    expect(facts.total).toBe(2);
  });
});
