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
import { CardImages } from './card-images';
import { Cards } from './cards';
import { headingField } from './seo-fields';

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
        'collections',
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

describe('cards: связь с подборками (m:n, ТЗ §8.1)', () => {
  it('открытка входит в несколько подборок без дублирования URL', () => {
    // Связь many-to-many и есть реализация требования «открытка входит в
    // несколько подборок без дублирования URL»: канонический адрес карточки
    // остаётся один (/otkrytki/<slug>), копии внутри подборок не создаются.
    const collections = findField(Cards.fields, 'collections');
    expect(collections.type).toBe('relationship');
    expect('relationTo' in collections ? collections.relationTo : undefined).toBe('collections');
    expect('hasMany' in collections ? collections.hasMany : undefined).toBe(true);
  });

  it('H1 берётся из общей фабрики, а не из копии правила в коллекции', () => {
    // Правило «пустой H1 равен title» одинаково для карточек и подборок; две
    // копии разошлись бы не ошибкой сборки, а страницей с чужим заголовком.
    const h1 = findField(Cards.fields, 'h1');
    expect(h1).toEqual(headingField());
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

  it('зеркало вариантов заведено и закрыто от записи снаружи (задача Э3-03a)', () => {
    // Поле системное: его пишет только хук карточки, читающий связанную запись
    // изображения. Открытое на запись, оно означало бы подмену src и srcset
    // опубликованной страницы через API — при неизменном URL самой страницы.
    const variants = findField(subFields(findField(Cards.fields, 'derivative')), 'variants');
    expect(variants.type).toBe('array');
    const access = 'access' in variants ? variants.access : undefined;
    expect(access?.create).toBe(systemFieldAccess);
    expect(access?.update).toBe(systemFieldAccess);
  });

  it('снимок дублей метатегов и виза закрыты от записи снаружи (Э5-01)', () => {
    // Открытые на запись, они означали бы, что калитка снимается самим
    // запросом: клиент прислал бы «конфликтов нет» и отпечаток чужого набора —
    // и перевод в review прошёл бы без единой проверки.
    const group = findField(Cards.fields, 'metaConflict');
    for (const name of [
      'checkedAt',
      'conflicts',
      'confirmedAt',
      'confirmedBy',
      'confirmedFor',
      'total',
      'truncated',
    ]) {
      const field = findField(subFields(group), name);
      const access = 'access' in field ? field.access : undefined;
      expect(access?.create, `metaConflict.${name}.create`).toBe(systemFieldAccess);
      expect(access?.update, `metaConflict.${name}.update`).toBe(systemFieldAccess);
    }
  });

  it('подтверждение конфликта доступно обеим ролям, а нормализованные ключи — никому', () => {
    // Подтверждать вправе и `ai-editor`: перевод draft → review — его штатное
    // действие (ТЗ §9), и запретить ему подтверждение значило бы запретить
    // сам переход. Прослеживаемость даёт не запрет, а поле `confirmedBy`.
    const confirm = findField(subFields(findField(Cards.fields, 'metaConflict')), 'confirm');
    expect('access' in confirm ? confirm.access : undefined).toBeUndefined();

    for (const name of ['titleKey', 'metaDescriptionKey']) {
      const field = findField(Cards.fields, name);
      const access = 'access' in field ? field.access : undefined;
      expect(access?.create, `${name}.create`).toBe(systemFieldAccess);
      expect(access?.update, `${name}.update`).toBe(systemFieldAccess);
    }
  });

  it('systemFieldAccess отказывает обеим ролям, а не только сервисному аккаунту', () => {
    // Формальная опора предыдущего теста: «закрыто» означает отказ и админу
    // тоже. Значение ставит сервер; ручная правка ключа производной означала бы
    // расхождение записи с хранилищем.
    for (const role of ['admin', 'ai-editor']) {
      const decision = systemFieldAccess({
        req: { user: { collection: 'users', id: 1, role } },
      } as unknown as Parameters<typeof systemFieldAccess>[0]);
      expect(decision, role).toBe(false);
    }
  });

  it('состав зеркала вариантов — только то, что нужно разметке (условие C8)', () => {
    // Ни `byteSize`, ни `targetWidth`: второй источник ширины в зеркале означал
    // бы, что дескриптор w, атрибут width и ключ файла могут разойтись.
    const mirror = subFields(
      findField(subFields(findField(Cards.fields, 'derivative')), 'variants'),
    );
    expect(mirror.map((field) => ('name' in field ? field.name : '—'))).toEqual([
      'key',
      'format',
      'width',
      'height',
    ]);
  });

  it('формы полей зеркала и источника совпадают поле в поле', () => {
    // Сверяется с ИСТОЧНИКОМ (`card-images.variants`), а не с литералами: два
    // описания одного поля расходятся молча, и обнаружилось бы это на странице.
    const mirror = subFields(
      findField(subFields(findField(Cards.fields, 'derivative')), 'variants'),
    );
    const source = subFields(findField(CardImages.fields, 'variants'));
    for (const name of ['key', 'format', 'width', 'height']) {
      expect(findField(mirror, name), name).toEqual(findField(source, name));
    }
    // byteSize есть только у источника: разметке он не нужен.
    expect(source.map((field) => ('name' in field ? field.name : '—'))).toContain('byteSize');
  });

  it('зеркало ЧИТАЕТСЯ анонимно: у поля нет ограничения на чтение', () => {
    // Обратная сторона запрета на запись. Публичный рендер читает карточку как
    // аноним, поэтому ограничение чтения на этом поле сделало бы зеркало
    // бесполезным — ровно от этого оно и завелось. Отсекает черновики
    // `contentReadAccess` на уровне КОЛЛЕКЦИИ (тест в policies.test.ts): анониму
    // отдаются только записи со status=published, а вместе с ними и зеркало.
    const derivative = findField(Cards.fields, 'derivative');
    const variants = findField(subFields(derivative), 'variants');
    for (const field of [derivative, variants, ...subFields(variants)]) {
      const access = 'access' in field ? field.access : undefined;
      expect(access?.read, 'name' in field ? String(field.name) : 'derivative').toBeUndefined();
    }
    expect(Cards.access?.read).toBe(contentReadAccess);
  });

  it('граница nameSuffix совпадает с источником: зеркало не мягче оригинала', () => {
    // Находка ревизии от 2026-08-22: у зеркала стояло `min: 1`, у источника
    // (`card-images.nameSuffix`) и у `normalizeUniqueSuffix` в @otkritka/images
    // — 2. У первого имени суффикса нет вовсе, а значение 1 дало бы одному
    // файлу два законных пути. Тест сверяет зеркало с источником, а не с
    // литералом: разъехаться им нельзя.
    const mirror = findField(subFields(findField(Cards.fields, 'derivative')), 'nameSuffix');
    const source = findField(CardImages.fields, 'nameSuffix');
    const minOf = (field: Field): unknown => ('min' in field ? field.min : undefined);
    expect(minOf(mirror)).toBe(2);
    expect(minOf(mirror)).toBe(minOf(source));
  });
});
