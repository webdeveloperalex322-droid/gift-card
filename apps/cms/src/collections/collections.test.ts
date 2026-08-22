/**
 * Коллекция `collections` (задача Э1-05): состав полей, дефолты и проводка
 * правил.
 *
 * Проверяется не Payload, а КОНФИГ — то, что нельзя увидеть в чистых функциях:
 *
 *   - итоговый путь `path` объявлен УНИКАЛЬНЫМ и проиндексированным. Это не
 *     косметика: уникальность URL держится на индексе БД, а не на проверке
 *     запросом перед записью, и снятие `unique` не сломало бы ни один другой
 *     тест — гонка двух сохранений через API просто создала бы две подборки с
 *     одним URL;
 *   - slug, наоборот, НЕ уникален: «mame» законно существует и под праздником, и
 *     в ветке адресатов;
 *   - поля, формирующие URL (`slug`, `parent`, `nodeKind`), подключены к ОДНОМУ
 *     правилу доступа: три разных права на три поля, меняющие один URL, — это
 *     дыра в одном из трёх;
 *   - `path` не пишется снаружи никем, включая администратора: значение ставит
 *     хук, а правка руками означала бы URL, не соответствующий иерархии.
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
  urlShapeFieldAccess,
} from '../access/policies';
import { ROLES } from '../access/roles';
import { DEFAULT_ROBOTS } from '../seo/robots';
import { COLLECTION_NODE_KINDS } from './collection-path';
import { Collections, pickDefaultResponsibleEditor } from './collections';

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

describe('collections: базовые свойства коллекции', () => {
  it('slug коллекции и права соответствуют матрице Э1-03', () => {
    expect(Collections.slug).toBe('collections');
    expect(Collections.access?.create).toBe(contentWriteAccess);
    expect(Collections.access?.update).toBe(contentWriteAccess);
    expect(Collections.access?.read).toBe(contentReadAccess);
    expect(Collections.access?.delete).toBe(contentDeleteAccess);
  });

  it('все поля из ТЗ §8.1 объявлены', () => {
    const names = Collections.fields
      .map((field) => ('name' in field ? field.name : undefined))
      .filter((name): name is string => name !== undefined);

    expect(names).toEqual(
      expect.arrayContaining([
        'title',
        'h1',
        'slug',
        'path',
        'nodeKind',
        'parent',
        'intro',
        'metaDescription',
        'status',
        'robots',
        'canonical',
        'publishedAt',
        'updatedContentAt',
        'responsibleEditor',
        'related',
        'seasonal',
      ]),
    );
  });

  it('иерархия и смежные подборки — связи с этой же коллекцией', () => {
    const parent = findField(Collections.fields, 'parent');
    const related = findField(Collections.fields, 'related');

    expect('relationTo' in parent ? parent.relationTo : undefined).toBe('collections');
    expect('hasMany' in parent ? parent.hasMany : undefined).toBeUndefined();
    expect('relationTo' in related ? related.relationTo : undefined).toBe('collections');
    expect('hasMany' in related ? related.hasMany : undefined).toBe(true);
  });

  it('вводный текст — rich text (ТЗ §8.1)', () => {
    expect(findField(Collections.fields, 'intro').type).toBe('richText');
  });
});

describe('collections: дефолты новой записи', () => {
  it('статус по умолчанию — draft', () => {
    const status = findField(Collections.fields, 'status');
    expect('defaultValue' in status ? status.defaultValue : undefined).toBe('draft');
    expect('required' in status ? status.required : undefined).toBe(true);
  });

  it('robots по умолчанию — noindex,follow', () => {
    const robots = findField(Collections.fields, 'robots');
    expect('defaultValue' in robots ? robots.defaultValue : undefined).toBe('noindex,follow');
    expect(DEFAULT_ROBOTS).toBe('noindex,follow');
  });

  it('canonical и publishedAt по умолчанию пусты', () => {
    const canonical = findField(Collections.fields, 'canonical');
    const publishedAt = findField(Collections.fields, 'publishedAt');
    expect('defaultValue' in canonical ? canonical.defaultValue : undefined).toBeUndefined();
    expect('defaultValue' in publishedAt ? publishedAt.defaultValue : undefined).toBeUndefined();
  });
});

describe('collections: уникальность итогового пути', () => {
  it('path уникален и проиндексирован — это и есть гарантия уникальности URL', () => {
    // Уникальный индекс БД, а не запрос перед записью: два одновременных
    // сохранения через API прошли бы проверку запросом оба.
    const path = findField(Collections.fields, 'path');
    expect('unique' in path ? path.unique : undefined).toBe(true);
    expect('index' in path ? path.index : undefined).toBe(true);
  });

  it('path не пишется снаружи никем, включая администратора', () => {
    const path = findField(Collections.fields, 'path');
    const access = 'access' in path ? path.access : undefined;
    expect(access?.create).toBe(systemFieldAccess);
    expect(access?.update).toBe(systemFieldAccess);
  });

  it('slug НЕ уникален: уникален путь, а не сегмент', () => {
    // «mame» живёт и под /podborki/prazdniki/8-marta, и под /podborki/adresaty.
    const slug = findField(Collections.fields, 'slug');
    expect('unique' in slug ? slug.unique : undefined).toBe(false);
    expect('required' in slug ? slug.required : undefined).toBe(true);
    expect('index' in slug ? slug.index : undefined).toBe(true);
    expect('validate' in slug ? typeof slug.validate : undefined).toBe('function');
  });

  it('путь собирается хуком коллекции, а не приходит из запроса', () => {
    expect(Collections.hooks?.beforeChange).toHaveLength(1);
    expect(Collections.hooks?.afterChange).toHaveLength(1);
  });

  it('удаление узла с вложенными перехватывается хуком', () => {
    // Иначе у потомков остался бы сохранённый путь, ведущий в исчезнувший узел,
    // — и этот путь ушёл бы в sitemap и canonical.
    expect(Collections.hooks?.beforeDelete).toHaveLength(1);
  });
});

describe('collections: поля, формирующие URL, подчинены одному правилу', () => {
  it('slug, parent и nodeKind закрываются после первой публикации', () => {
    const slug = findField(Collections.fields, 'slug');
    const parent = findField(Collections.fields, 'parent');
    const nodeKind = findField(Collections.fields, 'nodeKind');

    expect(('access' in slug ? slug.access : undefined)?.update).toBe(slugFieldAccess);
    expect(('access' in parent ? parent.access : undefined)?.update).toBe(urlShapeFieldAccess);
    expect(('access' in nodeKind ? nodeKind.access : undefined)?.update).toBe(
      urlShapeFieldAccess,
    );
    // Один и тот же предикат, а не три похожих: правило «URL меняется только до
    // первой публикации» одно.
    expect(urlShapeFieldAccess).toBe(slugFieldAccess);
  });

  it('вид узла обязателен и ограничен закрытым набором', () => {
    const nodeKind = findField(Collections.fields, 'nodeKind');
    expect('required' in nodeKind ? nodeKind.required : undefined).toBe(true);
    const options = 'options' in nodeKind ? nodeKind.options : undefined;
    expect(options).toHaveLength(COLLECTION_NODE_KINDS.length);
  });
});

describe('collections: поля, управляющие индексацией, закрыты для ai-editor', () => {
  it('status по значению, robots, canonical и updatedContentAt — по роли', () => {
    const status = findField(Collections.fields, 'status');
    const robots = findField(Collections.fields, 'robots');
    const canonical = findField(Collections.fields, 'canonical');
    const updatedContentAt = findField(Collections.fields, 'updatedContentAt');

    expect(('access' in status ? status.access : undefined)?.update).toBe(
      contentStatusFieldAccess,
    );
    expect(('access' in robots ? robots.access : undefined)?.update).toBe(robotsFieldAccess);
    expect(('access' in canonical ? canonical.access : undefined)?.update).toBe(
      canonicalFieldAccess,
    );
    expect(('access' in updatedContentAt ? updatedContentAt.access : undefined)?.update).toBe(
      contentUpdatedAtFieldAccess,
    );
  });
});

describe('collections: сезонность (ТЗ §8.6, решение Ч-12)', () => {
  it('даты праздника, готовности и показа на главной заведены', () => {
    const seasonal = findField(Collections.fields, 'seasonal');
    const inner = subFields(seasonal);

    for (const name of ['holidayDate', 'readyBy', 'showFrom', 'showUntil']) {
      expect(findField(inner, name).type, name).toBe('date');
    }
  });

  it('дата готовности заполняется хуком, а не константой в схеме', () => {
    const readyBy = findField(subFields(findField(Collections.fields, 'seasonal')), 'readyBy');
    expect('hooks' in readyBy ? readyBy.hooks?.beforeChange : undefined).toHaveLength(1);
    expect('defaultValue' in readyBy ? readyBy.defaultValue : undefined).toBeUndefined();
  });

  it('сезонные даты не создают URL: они поля группы, а не отдельные узлы', () => {
    // Решение Ч-04-3 и запрет «год в URL ежегодного праздника» держатся на том,
    // что сезонность — атрибут подборки. Отдельного вида узла под сезон нет.
    const seasonal = findField(Collections.fields, 'seasonal');
    expect(seasonal.type).toBe('group');
    expect(COLLECTION_NODE_KINDS).not.toContain('season');
  });
});

describe('pickDefaultResponsibleEditor (решение Ч-16)', () => {
  const admins = [{ id: 1 }, { id: 2 }];

  it('администратор становится ответственным за свою запись', () => {
    expect(pickDefaultResponsibleEditor({ id: 7, role: ROLES.admin }, admins)).toBe(7);
  });

  it('запись сервисного аккаунта получает ответственного-человека', () => {
    // Иначе у подборки, доведённой агентом до review, не было бы адресата
    // проверки, а решение о публикации принимает человек.
    expect(pickDefaultResponsibleEditor({ id: 99, role: ROLES.aiEditor }, admins)).toBe(1);
  });

  it('без пользователя берётся старейший администратор', () => {
    expect(pickDefaultResponsibleEditor(null, admins)).toBe(1);
    expect(pickDefaultResponsibleEditor(undefined, admins)).toBe(1);
  });

  it('администраторов нет — поле остаётся пустым, а не заполняется догадкой', () => {
    expect(pickDefaultResponsibleEditor({ id: 99, role: ROLES.aiEditor }, [])).toBeNull();
  });
});
