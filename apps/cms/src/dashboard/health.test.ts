/**
 * Модель дашборда SEO-здоровья (Э5-04, ТЗ §8.4).
 *
 * Каждое число проверяется отдельно, потому что дашборд — единственный экран, по
 * которому судят о состоянии сайта, не открывая записи. Особая цена у трёх
 * мест: снимок дублей не должен выдаваться за сегодняшнее состояние, неполный
 * обход визуальных дублей не должен читаться как «чисто», а незапущенная
 * проверка ссылок — как «сирот нет».
 */
import { describe, expect, it } from 'vitest';

import {
  type DashboardRecord,
  buildDashboard,
  collectMetaSnapshots,
  collectReview,
  collectSeasonal,
  collectVisualDuplicates,
  countStatuses,
  findMetaKeyDuplicates,
  toDashboardRecord,
} from './health';

function record(overrides: Partial<DashboardRecord> & { id: string }): DashboardRecord {
  return {
    collection: 'cards',
    metaConflict: null,
    metaDescriptionKey: null,
    path: `/otkrytki/${overrides.id}`,
    robots: 'noindex,follow',
    seasonal: null,
    status: 'draft',
    title: `Запись ${overrides.id}`,
    titleKey: null,
    updatedAt: null,
    visualDuplicate: null,
    ...overrides,
  };
}

describe('счётчики по статусам', () => {
  it('считаются по коллекциям, а не одной кучей', () => {
    const counts = countStatuses([
      record({ id: '1', status: 'draft' }),
      record({ id: '2', status: 'review' }),
      record({ id: '3', status: 'published' }),
      record({ collection: 'collections', id: '4', status: 'published' }),
    ]);

    expect(counts[0]).toMatchObject({ collection: 'cards', draft: 1, published: 1, review: 1, total: 3 });
    expect(counts[1]).toMatchObject({ collection: 'collections', published: 1, total: 1 });
  });

  it('неизвестный статус не теряется, а попадает в «прочее»', () => {
    const counts = countStatuses([record({ id: '1', status: 'archived' })]);
    expect(counts[0]?.other).toBe(1);
  });
});

describe('дубли метатегов: ключи (всегда актуально)', () => {
  it('совпадение нормализованных ключей находится по обеим коллекциям сразу', () => {
    const summary = findMetaKeyDuplicates([
      record({ id: '1', status: 'published', titleKey: 'otkrytki k 8 marta' }),
      record({ collection: 'collections', id: '2', status: 'review', titleKey: 'otkrytki k 8 marta' }),
    ]);

    expect(summary.groupCount).toBe(1);
    expect(summary.recordCount).toBe(2);
    expect(summary.groups[0]?.field).toBe('title');
  });

  it('черновики в счёт не идут: о них молчат и сами хуки', () => {
    const summary = findMetaKeyDuplicates([
      record({ id: '1', status: 'draft', titleKey: 'odno i to zhe' }),
      record({ id: '2', status: 'draft', titleKey: 'odno i to zhe' }),
    ]);
    expect(summary.groupCount).toBe(0);
  });

  it('заголовок, совпавший с чужим описанием, конфликтом не считается', () => {
    const summary = findMetaKeyDuplicates([
      record({ id: '1', status: 'published', titleKey: 'tekst' }),
      record({ id: '2', metaDescriptionKey: 'tekst', status: 'published' }),
    ]);
    expect(summary.groupCount).toBe(0);
  });
});

describe('дубли метатегов: снимок (верен на checkedAt)', () => {
  it('число идёт вместе с датой снимка и с тем, кто его подтвердил', () => {
    const summary = collectMetaSnapshots([
      record({
        id: '1',
        metaConflict: {
          checkedAt: '2026-08-20T10:00:00.000Z',
          confirmedBy: 'ai@otkritka.test',
          confirmedFor: 'otpechatok',
          total: 3,
        },
        status: 'review',
      }),
      record({
        id: '2',
        metaConflict: {
          checkedAt: '2026-08-28T10:00:00.000Z',
          confirmedBy: null,
          confirmedFor: null,
          total: 1,
        },
        status: 'review',
      }),
    ]);

    expect(summary.count).toBe(2);
    expect(summary.confirmedCount).toBe(1);
    // Самый старый снимок — мера того, насколько устарела картина.
    expect(summary.oldestCheckedAt).toBe('2026-08-20T10:00:00.000Z');
    expect(summary.rows[0]?.confirmedBy).toBe('ai@otkritka.test');
  });

  it('запись без снимка в блок не попадает — «ноль» тут значит «не проверялась»', () => {
    const summary = collectMetaSnapshots([record({ id: '1', metaConflict: null })]);
    expect(summary.count).toBe(0);
    expect(summary.oldestCheckedAt).toBeNull();
  });
});

describe('визуальные дубли', () => {
  it('неполный обход каталога считается отдельно от найденных дублей', () => {
    const summary = collectVisualDuplicates([
      record({
        id: '1',
        visualDuplicate: { closest: 7, scanTruncated: false, similar: 2 },
      }),
      record({
        id: '2',
        visualDuplicate: { closest: null, scanTruncated: true, similar: 0 },
      }),
    ]);

    expect(summary.withSimilarCount).toBe(1);
    expect(summary.rows[0]?.closest).toBe(7);
    // У этой записи «похожих не найдено» означает «дальше не искали».
    expect(summary.truncatedCount).toBe(1);
    expect(summary.truncated[0]?.id).toBe('2');
  });
});

describe('сезонные дедлайны', () => {
  const now = new Date('2027-01-22T00:00:00.000Z');

  it('показываются только приближающиеся и сорванные, ближайший первым', () => {
    const summary = collectSeasonal(
      [
        record({
          collection: 'collections',
          id: 'daleko',
          seasonal: {
            holidayDate: null,
            readyBy: '2027-06-01T00:00:00.000Z',
            showFrom: null,
            showUntil: null,
          },
        }),
        record({
          collection: 'collections',
          id: 'sorvan',
          seasonal: {
            holidayDate: null,
            readyBy: '2027-01-10T00:00:00.000Z',
            showFrom: null,
            showUntil: null,
          },
        }),
        record({
          collection: 'collections',
          id: 'blizko',
          seasonal: {
            holidayDate: null,
            readyBy: '2027-01-27T00:00:00.000Z',
            showFrom: null,
            showUntil: null,
          },
        }),
      ],
      now,
    );

    expect(summary.alerts.map((row) => row.id)).toEqual(['sorvan', 'blizko']);
    expect(summary.overdueCount).toBe(1);
    expect(summary.upcomingCount).toBe(1);
  });

  it('карточки в сезонный блок не попадают: даты праздника у открытки нет', () => {
    const summary = collectSeasonal(
      [
        record({
          id: 'kartochka',
          seasonal: {
            holidayDate: null,
            readyBy: '2027-01-10T00:00:00.000Z',
            showFrom: null,
            showUntil: null,
          },
        }),
      ],
      now,
    );
    expect(summary.alerts).toEqual([]);
  });

  it('окно показа, заданное наполовину, названо отдельной находкой', () => {
    const summary = collectSeasonal(
      [
        record({
          collection: 'collections',
          id: 'polovina',
          seasonal: {
            holidayDate: null,
            readyBy: null,
            showFrom: '2027-02-01T00:00:00.000Z',
            showUntil: null,
          },
        }),
      ],
      now,
    );
    expect(summary.windowIssues[0]?.deadline.showWindow).toBe('half-set');
  });
});

describe('записи в review', () => {
  it('свежие сверху', () => {
    const summary = collectReview([
      record({ id: 'staraya', status: 'review', updatedAt: '2026-08-01T00:00:00.000Z' }),
      record({ id: 'svezhaya', status: 'review', updatedAt: '2026-08-28T00:00:00.000Z' }),
      record({ id: 'chernovik', status: 'draft' }),
    ]);

    expect(summary.count).toBe(2);
    expect(summary.rows[0]?.id).toBe('svezhaya');
  });
});

describe('чтение документа Payload', () => {
  it('поля, срезанные доступом, не превращаются в нули', () => {
    // У смотрящего без прав групп `metaConflict` и `visualDuplicate` в документе
    // нет вовсе. Ноль вместо них выглядел бы как проверенный факт «дублей нет».
    const read = toDashboardRecord('cards', { id: 5, status: 'published', title: 'Роза' }, '/otkrytki/roza');
    expect(read.metaConflict).toBeNull();
    expect(read.visualDuplicate).toBeNull();
    expect(read.id).toBe('5');
  });

  it('ближайший похожий считается по наименьшему расстоянию', () => {
    const read = toDashboardRecord(
      'cards',
      {
        id: 6,
        status: 'review',
        title: 'Тюльпан',
        visualDuplicate: {
          scanTruncated: true,
          similar: [{ distance: 11 }, { distance: 4 }],
        },
      },
      '/otkrytki/tyulpan',
    );
    expect(read.visualDuplicate).toEqual({ closest: 4, scanTruncated: true, similar: 2 });
  });
});

describe('сборка модели', () => {
  it('незапущенная проверка ссылок названа прямо, а не показана нулями', () => {
    const model = buildDashboard({
      audit: null,
      auditAbsence: 'never-run',
      history: [],
      historyAbsence: 'empty',
      now: new Date('2027-01-22T00:00:00.000Z'),
      records: [],
      scanTruncated: false,
    });

    expect(model.audit).toBeNull();
    expect(model.auditAbsence).toBe('never-run');
  });

  it('«журнал закрыт» и «изменений не было» доходят до модели разными значениями', () => {
    // Пустой список у обоих один и тот же; разница вся в этом поле, и без неё
    // экран печатает «Изменений пока нет» тому, кому журнал просто не отдан.
    const forbidden = buildDashboard({
      audit: null,
      auditAbsence: 'never-run',
      history: [],
      historyAbsence: 'forbidden',
      now: new Date('2027-01-22T00:00:00.000Z'),
      records: [],
      scanTruncated: false,
    });
    expect(forbidden.history).toEqual([]);
    expect(forbidden.historyAbsence).toBe('forbidden');
  });

  it('усечённый обход записей помечается: числа — нижняя граница', () => {
    const model = buildDashboard({
      audit: null,
      auditAbsence: 'never-run',
      history: [],
      historyAbsence: 'empty',
      now: new Date('2027-01-22T00:00:00.000Z'),
      records: [record({ id: '1' })],
      scanTruncated: true,
    });
    expect(model.scanTruncated).toBe(true);
  });
});
