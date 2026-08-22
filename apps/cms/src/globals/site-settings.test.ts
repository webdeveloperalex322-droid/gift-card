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

import { ROLES } from '../access/roles';
import type { SiteSetting } from '../payload-types';
import {
  SiteSettings,
  adSlotFacts,
  imageLicenseFacts,
  infoPageFacts,
  organizationFacts,
} from './site-settings';
import {
  AD_SLOT_POSITIONS,
  INFO_PAGE_KEYS,
  SITE_SETTINGS_SLUG,
  isImageLicenseComplete,
  isInfoPageIndexable,
  isOrganizationJsonLdRendered,
} from './site-settings-rules';

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
    // не заполнил», и шаблон обязан по нему промолчать.
    expect(defaults).toEqual([{ path: 'adSlots.enabled', value: false }]);
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

  it('состав служебной страницы — заголовок, H1, description и текст', () => {
    for (const key of INFO_PAGE_KEYS) {
      expect(childFields(fieldAt(`infoPages.${key}`)).map((field) => field.name)).toEqual([
        'title',
        'h1',
        'metaDescription',
        'body',
      ]);
      expect(fieldAt(`infoPages.${key}.body`).type).toBe('richText');
    }
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
