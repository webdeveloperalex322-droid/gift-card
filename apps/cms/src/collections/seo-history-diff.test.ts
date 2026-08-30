/**
 * История изменений SEO-полей (задача Э1-07): чистое ядро сравнения.
 */
import { describe, expect, it } from 'vitest';

import { ROLES } from '../access/roles';
import {
  TRACKED_SEO_FIELDS,
  describeHistoryAuthor,
  diffSeoFields,
  normalizeHistoryValue,
} from './seo-history-diff';

describe('перечень отслеживаемых полей', () => {
  it('совпадает с ТЗ §8.1 плюс path подборки', () => {
    expect([...TRACKED_SEO_FIELDS]).toEqual([
      'title',
      'h1',
      'metaDescription',
      'slug',
      'path',
      'canonical',
      'robots',
      'status',
    ]);
  });
});

describe('нормализация значений', () => {
  it('пустая строка, null и undefined — одно и то же «пусто»', () => {
    expect(normalizeHistoryValue('')).toBeNull();
    expect(normalizeHistoryValue('   ')).toBeNull();
    expect(normalizeHistoryValue(null)).toBeNull();
    expect(normalizeHistoryValue(undefined)).toBeNull();
  });

  it('строка обрезается по краям, но не по содержанию', () => {
    expect(normalizeHistoryValue('  Открытки мам е ')).toBe('Открытки мам е');
  });

  it('дата приводится к ISO: сравнение по строкам иначе зависело бы от формата', () => {
    expect(normalizeHistoryValue(new Date('2026-03-08T10:00:00.000Z'))).toBe(
      '2026-03-08T10:00:00.000Z',
    );
  });

  it('очень длинное значение усекается с явным признаком', () => {
    const value = 'а'.repeat(3000);
    const stored = normalizeHistoryValue(value);
    expect(stored).not.toBeNull();
    expect((stored ?? '').length).toBeLessThan(value.length);
    expect(stored).toContain('…');
  });
});

describe('сравнение записи «до» и «после»', () => {
  it('изменение каждого отслеживаемого поля даёт запись «старое → новое»', () => {
    const changes = diffSeoFields(
      { robots: 'noindex,follow', status: 'draft', title: 'Старый' },
      { robots: 'noindex,follow', status: 'review', title: 'Новый' },
    );
    expect(changes).toEqual([
      { field: 'title', nextValue: 'Новый', previousValue: 'Старый' },
      { field: 'status', nextValue: 'review', previousValue: 'draft' },
    ]);
  });

  it('поля, которых нет ни до, ни после, не порождают записей', () => {
    const changes = diffSeoFields({ title: 'Один' }, { title: 'Один' });
    expect(changes).toEqual([]);
  });

  it('правка не-SEO поля историю не пишет', () => {
    const changes = diffSeoFields(
      { caption: 'Старая подпись', title: 'Один' },
      { caption: 'Новая подпись', title: 'Один' },
    );
    expect(changes).toEqual([]);
  });

  it('создание записи фиксируется как «пусто → значение»', () => {
    const changes = diffSeoFields(null, {
      robots: 'noindex,follow',
      slug: 'mame',
      status: 'draft',
      title: 'Открытка маме',
    });
    expect(changes).toEqual([
      { field: 'title', nextValue: 'Открытка маме', previousValue: null },
      { field: 'slug', nextValue: 'mame', previousValue: null },
      { field: 'robots', nextValue: 'noindex,follow', previousValue: null },
      { field: 'status', nextValue: 'draft', previousValue: null },
    ]);
  });

  it('переезд узла подборки фиксируется по path, а не только по slug', () => {
    const changes = diffSeoFields(
      { path: '/podborki/prazdniki/8-marta/mame', slug: 'mame' },
      { path: '/podborki/adresaty/mame', slug: 'mame' },
    );
    expect(changes).toEqual([
      {
        field: 'path',
        nextValue: '/podborki/adresaty/mame',
        previousValue: '/podborki/prazdniki/8-marta/mame',
      },
    ]);
  });

  it('у карточки path не существует, поэтому записей по нему нет', () => {
    const changes = diffSeoFields({ slug: 'staraya' }, { slug: 'novaya' });
    expect(changes.map((change) => change.field)).toEqual(['slug']);
  });
});

describe('автор изменения', () => {
  it('человек: роль admin и его id', () => {
    expect(describeHistoryAuthor({ id: 7, role: ROLES.admin })).toEqual({
      apiKey: false,
      authorRole: 'admin',
      userId: 7,
    });
  });

  it('сервисный аккаунт по API-ключу помечается отдельно (ТЗ §9)', () => {
    expect(
      describeHistoryAuthor({ _strategy: 'api-key', id: 9, role: ROLES.aiEditor }),
    ).toEqual({ apiKey: true, authorRole: 'ai-editor', userId: 9 });
  });

  it('без пользователя — системная операция (миграция, скрипт, onInit)', () => {
    expect(describeHistoryAuthor(null)).toEqual({
      apiKey: false,
      authorRole: 'system',
      userId: null,
    });
  });

  it('нераспознанная роль не выдаётся за системную', () => {
    expect(describeHistoryAuthor({ id: 3, role: 'reviewer' })).toEqual({
      apiKey: false,
      authorRole: 'unknown',
      userId: 3,
    });
  });
});
