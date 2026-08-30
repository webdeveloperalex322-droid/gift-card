import type {
  CollectionBeforeChangeHook,
  CollectionConfig,
  FieldHook,
  TextFieldSingleValidation,
  TypeWithID,
} from 'payload';
import { APIError } from 'payload';

import {
  adminOnlyAccess,
  authenticatedFieldAccess,
  systemFieldAccess,
} from '../access/policies';
import type { Redirect } from '../payload-types';
import {
  RedirectRuleError,
  type RedirectRecord,
  planRedirect,
  validateRedirectFrom,
} from './redirects-plan';

/**
 * Редиректы (задача Э1-06, ТЗ §8.1 и §7.5).
 *
 * Таблица применяется middleware Astro (задача Э3-01), поэтому её содержимое —
 * это HTTP-поведение сайта, а не справочник. Отсюда два следствия:
 *
 *   - все правила (петля, дубль `from`, схлопывание цепочек, запрет источника на
 *     маршруте, который сайт обслуживает сам) живут в серверном хуке и в чистом
 *     планировщике `redirects-plan.ts`. Через REST и GraphQL обойти их нельзя,
 *     потому что другого пути записи не существует;
 *   - создавать и менять редиректы вправе только `admin`. Для сервисного
 *     аккаунта `ai-editor` это запрещено на уровне access control (CLAUDE.md,
 *     ТЗ §9): редирект — это решение о судьбе URL, уже известного поисковику.
 *
 * Чтение открыто анонимно СОЗНАТЕЛЬНО: middleware обязано разрешать редирект на
 * каждом подходящем запросе, а карта переносов и так наблюдаема извне — она
 * буквально проявляется в ответах 301. Внутренние заметки редактора при этом
 * закрыты: поле `comment` читает только аутентифицированный.
 *
 * Чего здесь нет: создания редиректа при смене slug. Это отдельная атомарная
 * операция «сменить URL с одиночным 301» — задача Э1-09.
 */

/** Сохранённые редиректы в форме, которую понимает планировщик. */
function toRecords(docs: readonly Redirect[]): readonly RedirectRecord[] {
  return docs.map((doc) => ({
    id: doc.id,
    from: doc.from,
    to: doc.to ?? null,
    code: doc.code,
  }));
}

/**
 * Автор записи. Заполняется сервером, а не приходит из запроса: `seo-history`
 * и разбор инцидентов опираются на то, что автор — это тот, кто реально
 * выполнил операцию (человек или сервисный аккаунт по API-ключу).
 */
const fillCreatedBy: FieldHook<TypeWithID, number | string | null | undefined, unknown> = ({
  req,
  value,
}) => value ?? req.user?.id ?? null;

/**
 * Проверяет и достраивает редирект: нормализует пути, отклоняет петли, дубли и
 * источник на маршруте, который сайт обслуживает сам, схлопывает цепочки.
 *
 * Планировщик зовётся БЕЗ явного окружения — он берёт настоящее `process.env`
 * через `currentEnv()`. Это здесь обязательно: реестр зарезервированных
 * маршрутов вычисляет путь админки из `PAYLOAD_ADMIN_PATH`, и подставленное
 * окружение проверяло бы другую установку. Поэтому же отказ по незаданному
 * `PAYLOAD_ADMIN_PATH` приходит как содержательный 400, а не как 500.
 *
 * Схлопывание выполняется здесь же, до записи основного документа: операция
 * Payload идёт в транзакции, поэтому либо применяются и новый редирект, и
 * переписанные старые, либо ничего. Промежуточное состояние с цепочкой
 * недопустимо — краулер успел бы его увидеть.
 *
 * Вложенные обновления сознательно идут БЕЗ флага «пропустить проверку». Флаг
 * пришлось бы передавать через `req.context`, а `createLocalReq` в Payload
 * перезаписывает `req.context` объединённым объектом (проверено по исходникам,
 * `payload/dist/utilities/createLocalReq.js`) — то есть флаг остался бы в
 * контексте внешнего запроса и тихо отключил бы другие хуки, например запись в
 * `seo-history`. Повторная проверка переписанной записи безопасна: она не
 * меняет результат, а рекурсия конечна, потому что циклы в таблице запрещены.
 */
const applyRedirectRules: CollectionBeforeChangeHook<Redirect> = async ({
  data,
  originalDoc,
  req,
}) => {
  const existing = await req.payload.find({
    collection: 'redirects',
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
  });

  const candidate = {
    ...(originalDoc?.id === undefined ? {} : { id: originalDoc.id }),
    from: 'from' in data ? data.from : originalDoc?.from,
    to: 'to' in data ? data.to : originalDoc?.to,
    code: 'code' in data ? data.code : originalDoc?.code,
  };

  try {
    const plan = planRedirect({ candidate, existing: toRecords(existing.docs) });

    for (const warning of plan.warnings) {
      req.payload.logger.warn(`[redirects] ${warning}`);
    }

    for (const rewrite of plan.rewrites) {
      await req.payload.update({
        collection: 'redirects',
        id: rewrite.id,
        data: { code: rewrite.code, to: rewrite.to },
        overrideAccess: true,
        req,
      });
    }

    return {
      ...data,
      code: plan.redirect.code,
      from: plan.redirect.from,
      to: plan.redirect.to,
    };
  } catch (error) {
    if (error instanceof RedirectRuleError) {
      // 400, а не 500: отказ содержательный, и он одинаково выглядит в админке,
      // в REST и в GraphQL.
      throw new APIError(error.message, 400, { rule: error.rule }, true);
    }
    throw error;
  }
};

/**
 * Валидация поля `from` в форме, которую ожидает Payload.
 *
 * Окружение не передаётся: в рабочем процессе CMS реестр маршрутов обязан
 * собираться из НАСТОЯЩЕГО `PAYLOAD_ADMIN_PATH`, иначе проверка говорила бы о
 * другой установке. Тесты зовут `validateRedirectFrom` с явным окружением.
 */
const validateFromValue: TextFieldSingleValidation = (value) => validateRedirectFrom(value);

export const Redirects: CollectionConfig = {
  slug: 'redirects',
  labels: {
    singular: 'Редирект',
    plural: 'Редиректы',
  },
  admin: {
    defaultColumns: ['from', 'to', 'code', 'createdBy'],
    description:
      'Одиночные 301 и 410. Цепочки запрещены: новый редирект, создающий цепочку, ' +
      'схлопывается автоматически, а петля отклоняется.',
    useAsTitle: 'from',
  },
  access: {
    create: adminOnlyAccess,
    delete: adminOnlyAccess,
    // Анонимное чтение — осознанное решение: карту переносов применяет
    // middleware сайта на каждом запросе, и она наблюдаема извне по ответам 301.
    read: () => true,
    update: adminOnlyAccess,
  },
  hooks: {
    beforeChange: [applyRedirectRules],
  },
  fields: [
    {
      name: 'from',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      admin: {
        description:
          'Старый путь от корня сайта, например /otkrytki/staraya-otkrytka. ' +
          'Уникален: два правила для одного пути сделали бы ответ зависимым от ' +
          'порядка строк. Маршрут, который сайт обслуживает сам, источником быть ' +
          'не может: «/», «/otkrytki», «/podborki», «/search», «/account», ' +
          'служебные страницы, файлы robots и sitemap, «/media», путь админки и ' +
          'любой путь под ними — редирект оттуда сделал бы живую страницу ' +
          'недостижимой. Адреса записей под каталогами переносить можно.',
      },
      validate: validateFromValue,
    },
    {
      name: 'to',
      type: 'text',
      admin: {
        // Поле сознательно НЕ скрывается при коде 410: скрытое поле продолжает
        // отправляться формой, и редактор, переключивший 301 на 410, получил бы
        // отказ «410 не имеет цели» без возможности очистить значение.
        description:
          'Новый путь от корня сайта. Обязателен для 301 и обязан быть ПУСТЫМ для ' +
          '410. Абсолютный URL недопустим: хост собирается из SITE_URL. В отличие ' +
          'от поля «from», цель МОЖЕТ быть служебным маршрутом — каталогом, ' +
          'информационной страницей или главной: цель редиректа обязана быть ' +
          'достижимой, и запрет здесь сделал бы часть переносов невыполнимой.',
      },
    },
    {
      name: 'code',
      type: 'select',
      required: true,
      defaultValue: '301',
      options: [
        { label: '301 — перенесено на другой URL', value: '301' },
        { label: '410 — удалено без замены', value: '410' },
      ],
      admin: {
        description:
          'Только 301 и 410. Временных редиректов в модели нет: перенос страницы — ' +
          'постоянное решение, а 302 не передаёт сигналы старого URL новому.',
      },
    },
    {
      name: 'createdBy',
      type: 'relationship',
      relationTo: 'users',
      access: {
        create: systemFieldAccess,
        update: systemFieldAccess,
      },
      admin: {
        description: 'Кто создал правило: заполняется сервером и не приходит из запроса.',
        readOnly: true,
      },
      hooks: {
        beforeChange: [fillCreatedBy],
      },
    },
    {
      name: 'comment',
      type: 'textarea',
      access: {
        // Внутренняя заметка: чтение только для аутентифицированных, потому что
        // сама таблица читается анонимно.
        read: authenticatedFieldAccess,
      },
      admin: {
        description: 'Зачем создан редирект: причина переноса, ссылка на задачу.',
      },
    },
  ],
};
