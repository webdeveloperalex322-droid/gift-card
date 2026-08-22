/**
 * Коллекция `cards` (задача Э1-04): дефолты и проводка правил доступа.
 *
 * Проверяется не Payload, а КОНФИГ: что новая запись рождается черновиком с
 * `noindex`, что служебные поля закрыты от записи снаружи и что поля SEO
 * подключены к общим правилам, а не к локальной копии. Дефолт `status = draft` и
 * `robots = noindex,follow` — это не удобство, а защита: значение по умолчанию
 * `index,follow` открыло бы в индекс любую запись, созданную через API без явных
 * полей.
 */
import type { Field } from 'payload';
import { describe, expect, it } from 'vitest';

import {
  canonicalFieldAccess,
  contentDeleteAccess,
  contentReadAccess,
  contentStatusFieldAccess,
  contentUpdatedAtFieldAccess,
  contentWriteAccess,
  robotsFieldAccess,
  slugFieldAccess,
  systemFieldAccess,
} from '../access/policies';
import { DEFAULT_ROBOTS } from '../seo/robots';
import { Cards } from './cards';

function findField(fields: readonly Field[], name: string): Field {
  const field = fields.find((candidate) => 'name' in candidate && candidate.name === name);
  if (field === undefined) {
    throw new Error(`Поле «${name}» в коллекции не найдено`);
  }
  return field;
}

function subFields(field: Field): readonly Field[] {
  if (!('fields' in field)) {
    throw new Error('У поля нет вложенных полей');
  }
  return field.fields;
}

describe('cards: базовые свойства коллекции', () => {
  it('slug коллекции и права соответствуют матрице Э1-03', () => {
    expect(Cards.slug).toBe('cards');
    expect(Cards.access?.create).toBe(contentWriteAccess);
    expect(Cards.access?.update).toBe(contentWriteAccess);
    expect(Cards.access?.read).toBe(contentReadAccess);
    expect(Cards.access?.delete).toBe(contentDeleteAccess);
  });

  it('все поля из ТЗ §8.1, которые не зависят от других коллекций, объявлены', () => {
    const names = Cards.fields
      .map((field) => ('name' in field ? field.name : undefined))
      .filter((name): name is string => name !== undefined);

    expect(names).toEqual(
      expect.arrayContaining([
        'title',
        'h1',
        'slug',
        'alt',
        'caption',
        'description',
        'metaDescription',
        'status',
        'robots',
        'canonical',
        'publishedAt',
        'updatedContentAt',
        'pHash',
      ]),
    );
  });
});

describe('cards: дефолты новой записи', () => {
  it('статус по умолчанию — draft', () => {
    const status = findField(Cards.fields, 'status');
    expect('defaultValue' in status ? status.defaultValue : undefined).toBe('draft');
    expect('required' in status ? status.required : undefined).toBe(true);
  });

  it('robots по умолчанию — noindex,follow', () => {
    const robots = findField(Cards.fields, 'robots');
    expect('defaultValue' in robots ? robots.defaultValue : undefined).toBe('noindex,follow');
    expect(DEFAULT_ROBOTS).toBe('noindex,follow');
    expect('required' in robots ? robots.required : undefined).toBe(true);
  });

  it('canonical и publishedAt по умолчанию пусты: canonical self, публикации не было', () => {
    const canonical = findField(Cards.fields, 'canonical');
    const publishedAt = findField(Cards.fields, 'publishedAt');
    expect('defaultValue' in canonical ? canonical.defaultValue : undefined).toBeUndefined();
    expect('defaultValue' in publishedAt ? publishedAt.defaultValue : undefined).toBeUndefined();
  });
});

describe('cards: slug', () => {
  it('обязателен, уникален, проиндексирован и проверяется валидатором', () => {
    const slug = findField(Cards.fields, 'slug');
    expect('required' in slug ? slug.required : undefined).toBe(true);
    expect('unique' in slug ? slug.unique : undefined).toBe(true);
    expect('index' in slug ? slug.index : undefined).toBe(true);
    expect('validate' in slug ? typeof slug.validate : undefined).toBe('function');
  });

  it('подключён к общему правилу доступа, а не к локальной копии', () => {
    const slug = findField(Cards.fields, 'slug');
    const access = 'access' in slug ? slug.access : undefined;
    expect(access?.create).toBe(slugFieldAccess);
    expect(access?.update).toBe(slugFieldAccess);
  });
});

describe('cards: поля, управляющие индексацией, закрыты для ai-editor', () => {
  it('status проверяется по значению, robots и canonical — по роли', () => {
    const status = findField(Cards.fields, 'status');
    const robots = findField(Cards.fields, 'robots');
    const canonical = findField(Cards.fields, 'canonical');
    const updatedContentAt = findField(Cards.fields, 'updatedContentAt');

    expect(('access' in status ? status.access : undefined)?.update).toBe(
      contentStatusFieldAccess,
    );
    expect(('access' in robots ? robots.access : undefined)?.update).toBe(robotsFieldAccess);
    expect(('access' in canonical ? canonical.access : undefined)?.update).toBe(
      canonicalFieldAccess,
    );
    expect(
      ('access' in updatedContentAt ? updatedContentAt.access : undefined)?.update,
    ).toBe(contentUpdatedAtFieldAccess);
  });
});

describe('cards: служебные поля не пишутся снаружи', () => {
  it('pHash закрыт и на создании, и на обновлении', () => {
    const pHash = findField(Cards.fields, 'pHash');
    const access = 'access' in pHash ? pHash.access : undefined;
    expect(access?.create).toBe(systemFieldAccess);
    expect(access?.update).toBe(systemFieldAccess);
  });

  it('поля производной изображения заведены и закрыты (условия C1, C2, суффикс -N)', () => {
    const derivative = findField(Cards.fields, 'derivative');
    const inner = subFields(derivative);

    for (const name of ['keyBase', 'nameStem', 'nameSuffix', 'revision']) {
      const field = findField(inner, name);
      const access = 'access' in field ? field.access : undefined;
      expect(access?.create, `${name}.create`).toBe(systemFieldAccess);
      expect(access?.update, `${name}.update`).toBe(systemFieldAccess);
    }
  });
});
