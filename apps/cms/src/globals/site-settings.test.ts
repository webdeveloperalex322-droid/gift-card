/**
 * Глобал «Настройки сайта» (задача Э3-00): права, отсутствие заглушек, аудит.
 *
 * Главная проверка здесь — негативная: `ai-editor` не пишет в настройки. Она
 * гоняется против ТОГО ЖЕ объекта `access`, который вызывает Payload на каждом
 * запросе REST и GraphQL, потому что правило живёт в конфиге глобала, а не в
 * интерфейсе админки. Права, подтверждённые только инструкцией, внешний клиент
 * обходит через API — и узнают об этом по факту.
 *
 * Вторая проверка — «все поля пустые по умолчанию». Она выглядит формальной, но
 * закрывает конкретный сценарий: правдоподобное значение в `defaultValue`
 * (название организации, текст «Условия использования», размер 300×250) попало
 * бы в разметку и в индекс как настоящее. Именно это запрещает п. 23 ТЗ.
 */
import type { PayloadRequest } from 'payload';
import { describe, expect, it } from 'vitest';

import {
  AD_SLOT_POSITIONS,
  IMAGE_CREATOR_KINDS,
  INFO_PAGE_INDEXING_FIELD,
  INFO_PAGE_KEYS,
  SITE_SETTINGS_SLUG,
  isImageLicenseComplete,
  isInfoPageIndexable,
  isOrganizationJsonLdRendered,
} from '@otkritka/shared';

import { ROLES } from '../access/roles';
import { publicRichTextEditor } from '../editor/public-rich-text';
import type { SiteSetting } from '../payload-types';
import {
  SiteSettings,
  adSlotFacts,
  imageLicenseFacts,
  infoPageFacts,
  organizationFacts,
} from './site-settings';

/* ------------------------------------------------------------------ */
/* Вспомогательное: чтение конфига без знания union-типа Field         */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function childFields(container: unknown): readonly Record<string, unknown>[] {
  const fields = asRecord(container).fields;
  return Array.isArray(fields) ? fields.map((field: unknown) => asRecord(field)) : [];
}

/** Хуки поля по фазе. */
function childHooks(field: Record<string, unknown>, phase: string): readonly unknown[] {
  const hooks = asRecord(field.hooks)[phase];
  return Array.isArray(hooks) ? hooks : [];
}

/** Значения набора у select-поля. */
function childOptions(field: Record<string, unknown>): readonly string[] {
  const options = field.options;
  return Array.isArray(options)
    ? options.map((option: unknown) => String(asRecord(option).value))
    : [];
}

/** Поле по пути вида `organization.logo`. Отсутствие поля — ошибка теста. */
function fieldAt(path: string): Record<string, unknown> {
  let current: unknown = SiteSettings;
  for (const segment of path.split('.')) {
    const next = childFields(current).find((field) => field.name === segment);
    if (next === undefined) {
      throw new Error(`поле «${path}» не найдено: нет сегмента «${segment}»`);
    }
    current = next;
  }
  return asRecord(current);
}

/** Тело служебной страницы в форме, которую пишет richText. */
type InfoPageBody = NonNullable<NonNullable<NonNullable<SiteSetting['infoPages']>['terms']>['body']>;

function lexicalBody(text: string): InfoPageBody {
  return {
    root: {
      type: 'root',
      children: [
        { type: 'paragraph', version: 1, children: [{ type: 'text', text, version: 1 }] },
      ],
      direction: 'ltr',
      format: '',
      indent: 0,
      version: 1,
    },
  };
}

function requestOf(role: string | null, strategy?: string): PayloadRequest {
  const user = role === null ? null : { id: 7, role, _strategy: strategy };
  return { user } as unknown as PayloadRequest;
}

type AccessFn = (args: { req: PayloadRequest }) => unknown;

function accessFn(name: 'read' | 'readVersions' | 'update'): AccessFn {
  const access = asRecord(SiteSettings.access)[name];
  if (typeof access !== 'function') {
    throw new Error(`у глобала не объявлен access.${name} — это не «по умолчанию», а дыра`);
  }
  return access as AccessFn;
}

function fieldAccess(path: string, name: 'create' | 'read' | 'update'): AccessFn {
  const access = asRecord(fieldAt(path).access)[name];
  if (typeof access !== 'function') {
    throw new Error(`у поля «${path}» не объявлен access.${name}`);
  }
  return access as AccessFn;
}

function callValidate(path: string, value: unknown): unknown {
  const validate = fieldAt(path).validate;
  if (typeof validate !== 'function') {
    throw new Error(`у поля «${path}» нет валидации`);
  }
  return (validate as (value: unknown, options: unknown) => unknown)(value, {});
}

function callBeforeChange(path: string, req: PayloadRequest): unknown {
  const hooks = asRecord(fieldAt(path).hooks).beforeChange;
  if (!Array.isArray(hooks) || hooks.length === 0) {
    throw new Error(`у поля «${path}» нет хука beforeChange`);
  }
  const hook = hooks[0] as (args: unknown) => unknown;
  return hook({ req });
}

/* ------------------------------------------------------------------ */

describe('Э3-00: подключение глобала', () => {
  it('слаг и имя сгенерированного интерфейса заданы явно', () => {
    expect(SiteSettings.slug).toBe(SITE_SETTINGS_SLUG);
    expect(asRecord(SiteSettings.typescript).interface).toBe('SiteSetting');
  });

  it('история версий включена, черновиков у настроек нет', () => {
    // Версии — тот самый след «что было → что стало», из-за которого изменения
    // настроек не пишутся в seo-history (см. шапку site-settings.ts). Черновики
    // выключены: у настроек нет статусной модели, и `_status` только добавил бы
    // публичному чтению условие, которого в правилах нет.
    expect(SiteSettings.versions).toEqual({ drafts: false, max: 50 });
  });

  it('объявлены все четыре группы решений плюс аудит', () => {
    expect(childFields(SiteSettings).map((field) => field.name)).toEqual([
      'organization',
      'imageLicense',
      'infoPages',
      'adSlots',
      'audit',
    ]);
  });
});

describe('Э3-00: матрица прав — чтение публичное, запись только admin', () => {
  it('читает кто угодно, включая анонима: глобал читают шаблоны Astro', () => {
    expect(accessFn('read')({ req: requestOf(null) })).toBe(true);
    expect(accessFn('read')({ req: requestOf(ROLES.aiEditor) })).toBe(true);
    expect(accessFn('read')({ req: requestOf(ROLES.admin) })).toBe(true);
  });

  it('пишет только admin', () => {
    expect(accessFn('update')({ req: requestOf(ROLES.admin) })).toBe(true);
  });

  it('ai-editor НЕ пишет — ни через REST, ни через GraphQL', () => {
    // Тот же самый объект access вызывает Payload на каждом запросе к
    // /api/globals/site-settings и на мутации GraphQL. Отказ на уровне глобала
    // громкий (Forbidden), в отличие от отказа на уровне поля, где поле молча
    // срезается: сервисный аккаунт обязан узнать, что настройки не его дело.
    expect(accessFn('update')({ req: requestOf(ROLES.aiEditor) })).toBe(false);
    expect(accessFn('update')({ req: requestOf(ROLES.aiEditor, 'api-key') })).toBe(false);
  });

  it('аноним и пользователь с неизвестной ролью не пишут', () => {
    expect(accessFn('update')({ req: requestOf(null) })).toBe(false);
    expect(accessFn('update')({ req: requestOf('editor') })).toBe(false);
  });

  it('историю версий читает только admin', () => {
    expect(accessFn('readVersions')({ req: requestOf(ROLES.admin) })).toBe(true);
    expect(accessFn('readVersions')({ req: requestOf(ROLES.aiEditor) })).toBe(false);
    expect(accessFn('readVersions')({ req: requestOf(null) })).toBe(false);
  });
});

describe('Э3-00: все поля пустые по умолчанию', () => {
  it('единственный defaultValue — закрывающий (реклама выключена)', () => {
    const defaults: { path: string; value: unknown }[] = [];
    const walk = (container: unknown, prefix: string): void => {
      for (const field of childFields(container)) {
        const name = typeof field.name === 'string' ? field.name : '(без имени)';
        const path = prefix === '' ? name : `${prefix}.${name}`;
        if ('defaultValue' in field && field.defaultValue !== undefined) {
          defaults.push({ path, value: field.defaultValue });
        }
        walk(field, path);
      }
    };
    walk(SiteSettings, '');

    // Никаких правдоподобных заглушек: ни названия организации, ни текста
    // страницы, ни размеров рекламного блока. Пустое поле — это сигнал «человек
    // не заполнил», и шаблон обязан по нему промолчать. Значения по умолчанию
    // есть только у выключателей, и каждое из них ЗАКРЫВАЮЩЕЕ.
    expect(defaults).toEqual([
      ...INFO_PAGE_KEYS.map((key) => ({
        path: `infoPages.${key}.${INFO_PAGE_INDEXING_FIELD}`,
        value: false,
      })),
      { path: 'adSlots.enabled', value: false },
    ]);
    expect(defaults.every((entry) => entry.value === false)).toBe(true);
  });

  it('на пустом глобале все предикаты говорят «не выводить»', () => {
    // Ровно то состояние, в котором глобал находится на чистой базе: Payload
    // отдаёт запись без заполненных полей.
    const empty: SiteSetting = { id: 1 };
    expect(organizationFacts(empty)).toEqual({});
    expect(imageLicenseFacts(empty)).toEqual({});
    expect(adSlotFacts(empty)).toEqual([]);
    expect(isOrganizationJsonLdRendered(organizationFacts(empty))).toBe(false);
    expect(isImageLicenseComplete(imageLicenseFacts(empty))).toBe(false);
    for (const key of INFO_PAGE_KEYS) {
      expect(infoPageFacts(empty, key)).toEqual({});
      expect(isInfoPageIndexable(infoPageFacts(empty, key))).toBe(false);
    }
  });

  it('вид правообладателя — отдельное поле без значения по умолчанию', () => {
    // Правка по вердикту ревизии Э3-05/Э3-06: диапазон свойства creator в
    // schema.org — Person|Organization, поэтому вид выбирает человек. Дефолта
    // нет намеренно: подставленный вид был бы утверждением о правообладателе,
    // которого никто не делал.
    const kind = fieldAt('imageLicense.creatorKind');
    expect(kind.type).toBe('select');
    expect(kind.defaultValue).toBeUndefined();
    expect(childOptions(kind)).toEqual([...IMAGE_CREATOR_KINDS]);
  });

  it('имя правообладателя без выбранного вида не сохраняется', () => {
    // Запрет стоит на ВВОДЕ, а не в сборке разметки: строку без типа потребитель
    // разметки игнорирует, и свойство creator выглядело бы выведенным, фактически
    // отсутствуя. Валидация вызывается тем же способом, каким её зовёт Payload.
    const validate = fieldAt('imageLicense.creatorKind').validate;
    if (typeof validate !== 'function') {
      throw new Error('у поля вида правообладателя нет валидации');
    }
    const call = validate as (value: unknown, options: unknown) => unknown;

    expect(call('Organization', { siblingData: { creator: 'Проект «Открытки»' } })).toBe(true);
    expect(call(null, { siblingData: {} })).toBe(true);
    expect(typeof call(null, { siblingData: { creator: 'Проект «Открытки»' } })).toBe('string');
  });

  it('состав служебной страницы — выключатель индексации, заголовок, H1, description и текст', () => {
    for (const key of INFO_PAGE_KEYS) {
      expect(childFields(fieldAt(`infoPages.${key}`)).map((field) => field.name)).toEqual([
        INFO_PAGE_INDEXING_FIELD,
        'title',
        'h1',
        'metaDescription',
        'body',
      ]);
      expect(fieldAt(`infoPages.${key}.body`).type).toBe('richText');
    }
  });

  it('текст служебной страницы редактируется СУЖЕННЫМ набором фич', () => {
    // Тот же дефект, что нашла ревизия у вводного текста подборки: корневой
    // редактор поднят с дефолтами Payload (Upload, Relationship), а печатает
    // эти тексты (Э3-11) тот же разбор lexical, который таких узлов не знает.
    // Набор фич проверяется в `../editor/public-rich-text.test.ts`.
    for (const key of INFO_PAGE_KEYS) {
      const body = fieldAt(`infoPages.${key}.body`);
      expect('editor' in body ? body.editor : undefined).toBe(publicRichTextEditor);
      // Плюс серверный хук: узел отсутствующей фичи валидаций не имеет и через
      // REST/GraphQL сохранился бы молча.
      expect(childHooks(body, 'beforeValidate')).toHaveLength(1);
    }
  });
});

describe('Э3-00: index,follow служебной страницы — отдельное решение человека', () => {
  const switchPaths = INFO_PAGE_KEYS.map((key) => `infoPages.${key}.${INFO_PAGE_INDEXING_FIELD}`);

  it('у каждой страницы есть свой выключатель-флажок, выключенный по умолчанию', () => {
    for (const path of switchPaths) {
      expect(fieldAt(path).type).toBe('checkbox');
      expect(fieldAt(path).defaultValue).toBe(false);
    }
  });

  it('ai-editor выключатель не переключает — ни в админке, ни через API', () => {
    // Два слоя, и оба обязательны. Первый: access.update глобала отдаёт
    // сервисному аккаунту Forbidden. Второй — вот этот, на уровне ПОЛЯ: если
    // право записи в глобал однажды расширят (например, отдадут агенту правку
    // каких-то текстов), выключатель обязан остаться закрытым сам по себе.
    for (const path of switchPaths) {
      expect(fieldAccess(path, 'create')({ req: requestOf(ROLES.aiEditor) })).toBe(false);
      expect(fieldAccess(path, 'update')({ req: requestOf(ROLES.aiEditor) })).toBe(false);
      expect(fieldAccess(path, 'update')({ req: requestOf(ROLES.aiEditor, 'api-key') })).toBe(false);
      expect(fieldAccess(path, 'update')({ req: requestOf(null) })).toBe(false);
      expect(fieldAccess(path, 'update')({ req: requestOf('editor') })).toBe(false);
      expect(accessFn('update')({ req: requestOf(ROLES.aiEditor) })).toBe(false);
    }
  });

  it('admin выключатель переключает: решение об индексации — его', () => {
    for (const path of switchPaths) {
      expect(fieldAccess(path, 'create')({ req: requestOf(ROLES.admin) })).toBe(true);
      expect(fieldAccess(path, 'update')({ req: requestOf(ROLES.admin) })).toBe(true);
    }
  });

  it('значение выключателя читается публично: по нему шаблон решает про robots', () => {
    // Читать обязаны шаблоны Astro без аутентификации — иначе `apps/web` не
    // узнает, ставить странице index,follow или noindex. Поэтому у поля
    // объявлены только create и update: закрытое чтение сделало бы выключатель
    // невидимым для рендера, и страница осталась бы noindex вопреки решению.
    for (const path of switchPaths) {
      expect(Object.keys(asRecord(fieldAt(path).access)).sort()).toEqual(['create', 'update']);
    }
  });

  it('заполненный текст без выключателя индексацию НЕ открывает', () => {
    // Тот же вход, что придёт из базы после правки текстов скриптом или
    // миграцией под ролью admin: наполнение есть, решения человека нет.
    const filled: SiteSetting = {
      id: 1,
      infoPages: {
        terms: {
          title: 'Условия использования',
          metaDescription: 'Как можно использовать открытки проекта',
          body: lexicalBody('Условия использования открыток проекта. '.repeat(20)),
        },
      },
    };
    expect(isInfoPageIndexable(infoPageFacts(filled, 'terms'))).toBe(false);
  });

  it('выключатель плюс наполнение — только вместе дают право на index,follow', () => {
    const approvedAndFilled: SiteSetting = {
      id: 1,
      infoPages: {
        terms: {
          [INFO_PAGE_INDEXING_FIELD]: true,
          title: 'Условия использования',
          metaDescription: 'Как можно использовать открытки проекта',
          body: lexicalBody('Условия использования открыток проекта. '.repeat(20)),
        },
      },
    };
    expect(isInfoPageIndexable(infoPageFacts(approvedAndFilled, 'terms'))).toBe(true);

    const approvedButEmpty: SiteSetting = {
      id: 1,
      infoPages: { terms: { [INFO_PAGE_INDEXING_FIELD]: true } },
    };
    expect(isInfoPageIndexable(infoPageFacts(approvedButEmpty, 'terms'))).toBe(false);
  });
});

describe('Э3-00: валидация полей глобала', () => {
  it('логотип и лицензионные ссылки — путь от корня, не абсолютный адрес', () => {
    for (const path of [
      'organization.logo',
      'imageLicense.license',
      'imageLicense.acquireLicensePage',
    ]) {
      expect(callValidate(path, 'https://otkritka.test/usloviya')).toEqual(expect.any(String));
      expect(callValidate(path, '/usloviya')).toBe(true);
      // Пусто — норма: это состояние «человек не заполнил».
      expect(callValidate(path, '')).toBe(true);
    }
  });

  it('ссылка на профиль — наоборот, полный адрес чужого хоста', () => {
    expect(callValidate('organization.sameAs.url', 'https://vk.com/otkritka')).toBe(true);
    expect(callValidate('organization.sameAs.url', '/otkritka')).toEqual(expect.any(String));
  });

  it('в ряду рекламы не больше трёх блоков, и всего рядов два', () => {
    const slot = { position: 'under-h1', width: 300, height: 250, enabled: true };
    expect(callValidate('adSlots', [slot, slot, slot])).toBe(true);
    expect(callValidate('adSlots', [slot, slot, slot, slot])).toEqual(expect.any(String));
    expect(fieldAt('adSlots').maxRows).toBe(AD_SLOT_POSITIONS.length * 3);
  });

  it('позиция рекламного блока — закрытый набор из двух рядов Ч-11', () => {
    const options = fieldAt('adSlots.position').options;
    const values = (Array.isArray(options) ? options : []).map(
      (option: unknown) => asRecord(option).value,
    );
    expect(values).toEqual([...AD_SLOT_POSITIONS]);
  });
});

describe('Э3-00: аудит правки настроек', () => {
  const auditPaths = ['audit.changedAt', 'audit.authorRole', 'audit.changedBy', 'audit.viaApiKey'];

  it('поля аудита не пишутся снаружи никем, включая admin', () => {
    for (const path of auditPaths) {
      expect(fieldAccess(path, 'create')({ req: requestOf(ROLES.admin) })).toBe(false);
      expect(fieldAccess(path, 'update')({ req: requestOf(ROLES.admin) })).toBe(false);
    }
  });

  it('поля аудита не отдаются публично: кто менял — внутренняя кухня', () => {
    for (const path of auditPaths) {
      expect(fieldAccess(path, 'read')({ req: requestOf(null) })).toBe(false);
      expect(fieldAccess(path, 'read')({ req: requestOf(ROLES.admin) })).toBe(true);
    }
  });

  it('автор и время ставятся сервером на каждом сохранении', () => {
    const req = requestOf(ROLES.admin);
    expect(callBeforeChange('audit.authorRole', req)).toBe(ROLES.admin);
    expect(callBeforeChange('audit.changedBy', req)).toBe(7);
    expect(callBeforeChange('audit.viaApiKey', req)).toBe(false);
    expect(callBeforeChange('audit.changedAt', req)).toEqual(expect.any(String));
  });

  it('признак API-ключа фиксируется отдельно от роли', () => {
    const req = requestOf(ROLES.admin, 'api-key');
    expect(callBeforeChange('audit.viaApiKey', req)).toBe(true);
    expect(callBeforeChange('audit.authorRole', req)).toBe(ROLES.admin);
  });

  it('операция без пользователя помечается как системная, а не как admin', () => {
    // Скрипт или миграция через Local API: автора нет, и выдавать его за человека
    // нельзя — иначе журнал показывал бы решение человека там, где его не было.
    const req = requestOf(null);
    expect(callBeforeChange('audit.authorRole', req)).toBe('system');
    expect(callBeforeChange('audit.changedBy', req)).toBeNull();
  });

  it('нераспознанная роль остаётся инцидентом, а не превращается в system', () => {
    expect(callBeforeChange('audit.authorRole', requestOf('editor'))).toBe('unknown');
  });
});
