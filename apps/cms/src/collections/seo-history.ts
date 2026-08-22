import type { CollectionBeforeChangeHook, CollectionConfig } from 'payload';
import { APIError } from 'payload';

import { authenticatedAccess, systemFieldAccess } from '../access/policies';
import { HISTORY_AUTHOR_ROLES, TRACKED_SEO_FIELDS } from './seo-history-diff';

/**
 * История изменений SEO-полей (задача Э1-07, ТЗ §8.1: «только чтение»).
 *
 * Коллекция заполняется ТОЛЬКО серверными хуками контентных коллекций
 * (`content-hooks.ts`), поэтому её защита строится на двух разных механизмах, и
 * оба нужны:
 *
 *   1. `access` со значением `false` на запись — закрывает внешний путь: REST,
 *      GraphQL и форму админки. Кнопки «создать» и «сохранить» в интерфейсе
 *      исчезают, а запрос извне получает отказ;
 *   2. хук {@link rejectHistoryEdit} — закрывает ВНУТРЕННИЙ путь. Серверные
 *      хуки работают через Local API с `overrideAccess: true`, а он отключает
 *      проверки доступа целиком (проверено по исходникам Payload). То есть
 *      правило «запись истории неизменяема» без хука держалось бы на
 *      добросовестности собственного кода, а не на механизме. Аудит, который
 *      можно тихо отредактировать своим же хуком, аудитом не является.
 *
 * Удаление закрыто на уровне `access`, но НЕ запрещено хуком сознательно:
 * обслуживающая операция (перенос старых записей в архив) должна оставаться
 * возможной через Local API. Через API и админку удалить историю нельзя.
 *
 * Чего здесь нет: строки «кем именно» в свободной форме. Автор хранится связью с
 * `users` плюс роль и признак API-ключа: текстовое поле разошлось бы с
 * действительностью при переименовании пользователя, а по связи всегда видно,
 * чей это аккаунт (ТЗ §9 — логирование мутаций с указанием ключа, Э6-04).
 */

const IMMUTABILITY_REASON =
  'Запись истории изменений неизменяема: это журнал аудита, по которому ' +
  'восстанавливается, кто и когда изменил SEO-поля страницы (ТЗ §8.1 — только чтение). ' +
  'Правка журнала обесценивает сам журнал. Если запись создана ошибочно, добавьте ' +
  'новую с верным значением — история должна показывать и ошибку, и исправление.';

/**
 * Не даёт изменить уже созданную запись истории — в том числе своему же коду.
 *
 * Хук выбран потому, что хуки выполняются и при `overrideAccess: true`, в отличие
 * от `access`: иначе запрет обходился бы одним вызовом Local API.
 */
export const rejectHistoryEdit: CollectionBeforeChangeHook = ({ operation }) => {
  if (operation === 'update') {
    throw new APIError(IMMUTABILITY_REASON, 400, { rule: 'history-immutable' }, true);
  }
};

export const SeoHistory: CollectionConfig = {
  slug: 'seo-history',
  labels: {
    singular: 'Изменение SEO-поля',
    plural: 'История SEO',
  },
  admin: {
    defaultColumns: [
      'changedAt',
      'documentCollection',
      'documentPath',
      'field',
      'previousValue',
      'nextValue',
      'authorRole',
    ],
    description:
      'Журнал изменений SEO-полей: что, когда, кем (человек или сервисный аккаунт), ' +
      'старое → новое. Заполняется хуками автоматически, вручную не редактируется.',
    useAsTitle: 'documentPath',
  },
  access: {
    // Записывают только серверные хуки через Local API.
    create: () => false,
    delete: () => false,
    // Читают только аутентифицированные: журнал показывает внутреннюю кухню
    // (кто и что менял), а публичного смысла в нём нет.
    read: authenticatedAccess,
    update: () => false,
  },
  hooks: {
    beforeChange: [rejectHistoryEdit],
  },
  fields: [
    {
      name: 'documentCollection',
      type: 'select',
      required: true,
      index: true,
      options: [
        { label: 'Открытки', value: 'cards' },
        { label: 'Подборки', value: 'collections' },
      ],
      access: { create: systemFieldAccess, update: systemFieldAccess },
      admin: { description: 'Коллекция изменённой записи.', readOnly: true },
    },
    {
      name: 'documentId',
      type: 'text',
      required: true,
      index: true,
      access: { create: systemFieldAccess, update: systemFieldAccess },
      admin: {
        description:
          'Идентификатор записи. Строкой, а не связью: история обязана переживать ' +
          'удаление документа — иначе исчезал бы след ровно того события, из-за ' +
          'которого чаще всего и смотрят журнал.',
        readOnly: true,
      },
    },
    {
      name: 'documentPath',
      type: 'text',
      index: true,
      access: { create: systemFieldAccess, update: systemFieldAccess },
      admin: {
        description:
          'Путь записи на момент изменения. Хранится копией: по нему история ' +
          'читается как список URL, а не как список идентификаторов.',
        readOnly: true,
      },
    },
    {
      name: 'field',
      type: 'select',
      required: true,
      index: true,
      options: TRACKED_SEO_FIELDS.map((field) => ({ label: field, value: field })),
      access: { create: systemFieldAccess, update: systemFieldAccess },
      admin: { description: 'Какое SEO-поле изменилось.', readOnly: true },
    },
    {
      name: 'previousValue',
      type: 'textarea',
      access: { create: systemFieldAccess, update: systemFieldAccess },
      admin: { description: 'Значение ДО изменения. Пусто — поле не было заполнено.', readOnly: true },
    },
    {
      name: 'nextValue',
      type: 'textarea',
      access: { create: systemFieldAccess, update: systemFieldAccess },
      admin: { description: 'Значение ПОСЛЕ изменения.', readOnly: true },
    },
    {
      name: 'operation',
      type: 'select',
      required: true,
      options: [
        { label: 'Создание записи', value: 'create' },
        { label: 'Изменение записи', value: 'update' },
      ],
      access: { create: systemFieldAccess, update: systemFieldAccess },
      admin: { description: 'Операция, в которой произошло изменение.', readOnly: true },
    },
    {
      name: 'authorRole',
      type: 'select',
      required: true,
      index: true,
      options: HISTORY_AUTHOR_ROLES.map((role) => ({ label: role, value: role })),
      access: { create: systemFieldAccess, update: systemFieldAccess },
      admin: {
        description:
          'Кто изменил: admin (человек), ai-editor (сервисный аккаунт), system ' +
          '(операция без пользователя — миграция, скрипт) или unknown (роль не ' +
          'распознана — это инцидент, а не норма).',
        readOnly: true,
      },
    },
    {
      name: 'changedBy',
      type: 'relationship',
      relationTo: 'users',
      access: { create: systemFieldAccess, update: systemFieldAccess },
      admin: {
        description: 'Аккаунт автора изменения. Пусто — операция без пользователя.',
        readOnly: true,
      },
    },
    {
      name: 'viaApiKey',
      type: 'checkbox',
      defaultValue: false,
      access: { create: systemFieldAccess, update: systemFieldAccess },
      admin: {
        description:
          'Изменение пришло по API-ключу (ТЗ §9). Признак хранится отдельно от роли: ' +
          'один и тот же аккаунт может работать и через админку, и через API.',
        readOnly: true,
      },
    },
    {
      name: 'changedAt',
      type: 'date',
      required: true,
      index: true,
      access: { create: systemFieldAccess, update: systemFieldAccess },
      admin: {
        date: { displayFormat: 'dd.MM.yyyy HH:mm:ss' },
        description:
          'Момент изменения. Ставится хуком; собственное поле, а не createdAt, чтобы ' +
          'все записи одной операции имели ровно одно время.',
        readOnly: true,
      },
    },
  ],
};
