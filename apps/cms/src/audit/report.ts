/**
 * Хранилище отчёта проверки внутренних ссылок (задача Э5-03, ТЗ §8.3.4).
 *
 * ПОЧЕМУ ГЛОБАЛ, А НЕ КОЛЛЕКЦИЯ. Отчёт один и всегда последний: дашборд
 * спрашивает «что сейчас», а не «что было в марте». Коллекция дала бы историю
 * прогонов — и вместе с ней вопрос, кто её чистит; ежесуточная задача набивала
 * бы таблицу отчётами, каждый из которых устаревает на следующие сутки.
 * Предыдущие состояния при этом не теряются: у глобала включены версии, и
 * сравнить сегодняшний отчёт со вчерашним можно там.
 *
 * ПРАВА. Читают только аутентифицированные, пишет только задача.
 *
 *   - `read: authenticatedAccess` — отчёт перечисляет адреса и идентификаторы
 *     записей, а среди находок бывает «опубликованная запись отвечает 404», то
 *     есть готовый список слабых мест сайта. Публичного смысла в нём нет.
 *     Урок Э5-02 и Э5-05 (снимок дублей анониму, выгрузка без фильтрации) здесь
 *     учтён заранее, а не после находки контролёра;
 *   - `update: () => false` — руками отчёт не правится ни админом, ни сервисным
 *     аккаунтом: он не мнение, а протокол измерения. Задача пишет его через
 *     Local API с `overrideAccess`, то есть единственным путём, у которого есть
 *     измеренные данные.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Ни одного поля, которым отчёт мог бы на что-то повлиять:
 * ни «закрыть от индексации», ни «снять с публикации», ни «перегенерировать
 * карту». Проверка только читает сайт и складывает найденное.
 */
import type { GlobalConfig } from 'payload';

import { authenticatedAccess } from '../access/policies';
import {
  LINK_AUDIT_CRAWL_DEPTH,
  LINK_AUDIT_MAX_CLICKS,
  LINK_AUDIT_MAX_LISTED,
  LINK_AUDIT_MAX_REQUESTS,
  type RecordFindingReason,
} from './link-audit';

/** Слаг глобала. Экспортируется, чтобы читатели не писали строку заново. */
export const LINK_AUDIT_SLUG = 'seo-link-audit';

/** Причины находок в том же порядке, в каком их читает редактор. */
export const RECORD_FINDING_OPTIONS: readonly { label: string; value: RecordFindingReason }[] = [
  { label: 'Ссылок на адрес в обходе не встретилось', value: 'not-linked' },
  {
    label: `Путь от главной длиннее ${String(LINK_AUDIT_MAX_CLICKS)} переходов`,
    value: 'too-deep',
  },
  { label: 'Адрес опубликованной записи ответил, и ответ не 200', value: 'not-200' },
  { label: 'Адрес опубликованной записи не ответил вовсе', value: 'no-response' },
  { label: 'Адрес не спрошен: обход оборвался по пределу', value: 'not-measured' },
];

/**
 * Значение отчёта в том виде, в каком его пишет задача.
 *
 * Интерфейс объявлен здесь, а не выведен из сгенерированного типа, по той же
 * причине, по какой существует `PublishableDoc` в `../access/policies.ts`: он
 * нужен коду, который компилируется ДО `pnpm generate:types`. Сгенерированный
 * тип `SeoLinkAudit` при этом остаётся авторитетным для читателей.
 */
export interface LinkAuditReportValue {
  readonly counts: {
    readonly broken: number;
    readonly notMeasured: number;
    readonly orphans: number;
    readonly publishedRecords: number;
    readonly redirected: number;
    readonly unhealthy: number;
  };
  readonly crawl: {
    readonly requested: number;
    readonly truncated: boolean;
  };
  readonly finishedAt: string;
  // Массивы намеренно НЕ `readonly`: значение уходит в `payload.updateGlobal`,
  // а его тип выведен из сгенерированной схемы и мутабелен. Своя обёртка ради
  // косметического `readonly` заставила бы копировать структуру при каждой
  // записи — то есть платить за оформление.
  links: {
    kind: 'broken' | 'redirected';
    location?: string | null;
    referrers?: string | null;
    status?: number | null;
    url: string;
  }[];
  readonly origin: string;
  records: {
    depth?: number | null;
    documentCollection: 'cards' | 'collections';
    documentId: string;
    inSitemap?: string | null;
    reason: RecordFindingReason;
    title?: string | null;
    url: string;
  }[];
  readonly reliable: boolean;
  readonly sitemap: {
    readonly indexStatus?: number | null;
    readonly urls?: number | null;
  };
  readonly startedAt: string;
  warnings: { text: string }[];
}

/**
 * Глобал «Проверка внутренних ссылок».
 *
 * Все поля только на чтение в интерфейсе: форма админки показывает протокол
 * измерения, а не анкету. `readOnly` здесь — удобство; настоящий запрет держит
 * `access.update`, потому что REST и GraphQL про `admin.readOnly` не знают.
 */
export const LinkAuditReport: GlobalConfig = {
  slug: LINK_AUDIT_SLUG,
  label: 'Проверка внутренних ссылок',
  access: {
    read: authenticatedAccess,
    readVersions: authenticatedAccess,
    // Руками отчёт не правится: он протокол измерения, а не мнение редактора.
    update: () => false,
  },
  admin: {
    description:
      'Результат ежесуточного обхода сайта от главной (ТЗ §8.3.4). Обход спрашивает только ' +
      `origin из SITE_URL, идёт на глубину ${String(LINK_AUDIT_CRAWL_DEPTH)} переходов и не ` +
      `делает больше ${String(LINK_AUDIT_MAX_REQUESTS)} запросов. Отчёт ничего не меняет: ни ` +
      'статусов, ни robots-директив, ни карты сайта.',
  },
  fields: [
    {
      name: 'startedAt',
      type: 'date',
      admin: {
        date: { displayFormat: 'dd.MM.yyyy HH:mm:ss' },
        description: 'Когда начат прогон. Отчёт верен НА ЭТОТ МОМЕНТ, а не на момент просмотра.',
        readOnly: true,
      },
    },
    {
      name: 'finishedAt',
      type: 'date',
      admin: {
        date: { displayFormat: 'dd.MM.yyyy HH:mm:ss' },
        description: 'Когда прогон закончен.',
        readOnly: true,
      },
    },
    {
      name: 'origin',
      type: 'text',
      admin: {
        description:
          'Какой хост обойдён. Значение из SITE_URL и только оттуда: адрес обхода не задаётся ' +
          'ни параметром, ни второй переменной окружения.',
        readOnly: true,
      },
    },
    {
      name: 'reliable',
      type: 'checkbox',
      defaultValue: false,
      admin: {
        description:
          'Можно ли верить находкам о достижимости. Снято — обход оборвался по пределу или ' +
          'главная не ответила 200; тогда «сирот» в отчёте читать нельзя: их там столько, ' +
          'сколько страниц не успели обойти.',
        readOnly: true,
      },
    },
    {
      name: 'crawl',
      type: 'group',
      label: 'Обход',
      fields: [
        {
          name: 'requested',
          type: 'number',
          label: 'Запросов к сайту',
          admin: { readOnly: true },
        },
        {
          name: 'truncated',
          type: 'checkbox',
          defaultValue: false,
          label: 'Оборван пределом',
          admin: { readOnly: true },
        },
      ],
    },
    {
      name: 'counts',
      type: 'group',
      label: 'Счётчики',
      fields: [
        {
          name: 'publishedRecords',
          type: 'number',
          label: 'Опубликованных записей проверено',
          admin: { readOnly: true },
        },
        {
          name: 'orphans',
          type: 'number',
          label: 'Сирот (нет ссылок либо глубже нормы)',
          admin: { readOnly: true },
        },
        { name: 'broken', type: 'number', label: 'Битых ссылок', admin: { readOnly: true } },
        {
          name: 'redirected',
          type: 'number',
          label: 'Ссылок через редирект',
          admin: {
            description:
              'Не битые: работают. Но каждая тратит переход и спорит с правилом «внутренние ' +
              'ссылки — канонические».',
            readOnly: true,
          },
        },
        {
          name: 'unhealthy',
          type: 'number',
          label: 'Опубликованных записей, чей адрес не отдал 200',
          admin: {
            description:
              'Считаются обе находки: «ответил, и ответ не 200» и «не ответил вовсе». В ' +
              'списке находок они названы порознь, потому что чинятся разным.',
            readOnly: true,
          },
        },
        {
          name: 'notMeasured',
          type: 'number',
          label: 'Записей, адрес которых не спрошен',
          admin: { readOnly: true },
        },
      ],
    },
    {
      name: 'records',
      type: 'array',
      label: 'Находки по записям',
      admin: {
        description: `Список ограничен ${String(LINK_AUDIT_MAX_LISTED)} строками; общее число — в счётчиках.`,
        readOnly: true,
      },
      fields: [
        { name: 'url', type: 'text' },
        {
          name: 'reason',
          type: 'select',
          options: RECORD_FINDING_OPTIONS.map((option) => ({ ...option })),
        },
        {
          name: 'documentCollection',
          type: 'select',
          options: [
            { label: 'Открытки', value: 'cards' },
            { label: 'Подборки', value: 'collections' },
          ],
        },
        {
          name: 'documentId',
          type: 'text',
          admin: {
            description:
              'Идентификатор строкой, а не связью: отчёт обязан переживать удаление записи — ' +
              'иначе исчезал бы след ровно того события, ради которого его смотрят.',
          },
        },
        { name: 'title', type: 'text' },
        { name: 'depth', type: 'number', label: 'Переходов от главной' },
        {
          name: 'inSitemap',
          type: 'text',
          label: 'В карте сайта',
          admin: {
            description:
              'да / нет / пусто. Пусто — карта не прочитана, то есть «неизвестно», а не «нет».',
          },
        },
      ],
    },
    {
      name: 'links',
      type: 'array',
      label: 'Находки по ссылкам',
      admin: {
        description: `Список ограничен ${String(LINK_AUDIT_MAX_LISTED)} строками на вид находки.`,
        readOnly: true,
      },
      fields: [
        { name: 'url', type: 'text' },
        {
          name: 'kind',
          type: 'select',
          options: [
            { label: 'Битая ссылка', value: 'broken' },
            { label: 'Ссылка через редирект', value: 'redirected' },
          ],
        },
        { name: 'status', type: 'number', label: 'Код ответа' },
        { name: 'location', type: 'text', label: 'Куда ведёт редирект' },
        {
          name: 'referrers',
          type: 'text',
          label: 'Страницы, где стоит ссылка',
          admin: { description: 'Через перевод строки. Правится ссылка на странице-источнике.' },
        },
      ],
    },
    {
      name: 'sitemap',
      type: 'group',
      label: 'Наблюдение за картой сайта',
      admin: {
        description:
          'Карта сайта собирается НА ЗАПРОСЕ (решение этапа 4): файла на диске нет, отдельной ' +
          '«генерации» не существует, и её дату здесь показать неоткуда. Поэтому здесь стоит ' +
          'то, что действительно измерено: чем ответил /sitemap.xml во время последнего ' +
          'обхода. Расхождение этой формы с формулировкой CLAUDE.md «перегенерируется хуками» ' +
          'заведено вопросом Э4-04-A и ждёт решения человека.',
      },
      fields: [
        {
          name: 'indexStatus',
          type: 'number',
          label: 'Ответ /sitemap.xml',
          admin: { readOnly: true },
        },
        {
          name: 'urls',
          type: 'number',
          label: 'Адресов в карте',
          admin: { readOnly: true },
        },
      ],
    },
    {
      name: 'warnings',
      type: 'array',
      label: 'Что осталось неизмеренным',
      admin: {
        description:
          'Пустое место в отчёте без объяснения читается как «всё хорошо». Эти строки ' +
          'объясняют, чего проверка не увидела и почему.',
        readOnly: true,
      },
      fields: [{ name: 'text', type: 'text' }],
    },
  ],
  typescript: {
    interface: 'SeoLinkAudit',
  },
  versions: {
    drafts: false,
    // Хватает, чтобы увидеть, когда сирота появилась, и мало, чтобы таблица
    // версий росла без предела при ежесуточном прогоне.
    max: 30,
  },
};
