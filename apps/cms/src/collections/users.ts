import type {
  CollectionBeforeOperationHook,
  CollectionBeforeValidateHook,
  CollectionConfig,
  TypeWithID,
} from 'payload';
import { APIError } from 'payload';

import {
  adminOnlyAccess,
  adminOnlyFieldAccess,
  adminPanelAccess,
  authenticatedAccess,
} from '../access/policies';
import { ROLES, type RoledUser, isAdmin } from '../access/roles';

/**
 * Пользователи и API-ключи (задача Э1-03, ТЗ §4 и §9).
 *
 * Ролей ровно две (решение Ч-16): `admin` — человек, `ai-editor` — сервисный
 * аккаунт с API-ключом. Роли `editor` в модели нет: Ч-16 её отменил, хотя в
 * раннем плане она упоминалась.
 *
 * Что здесь защищается и почему именно так:
 *
 *   - **роль меняет только `admin`.** Без этого сервисный аккаунт выдал бы себе
 *     `admin` через `PATCH /api/users/<id>` и обошёл бы всю границу
 *     автоматизации. Это правило поля, а не интерфейса: правило, живущее в UI
 *     админки, обходится первым же запросом к REST;
 *   - **пользователей создаёт и удаляет только `admin`.** Иначе `ai-editor`
 *     завёл бы себе второй аккаунт с другой ролью — тот же обход, длиннее на шаг;
 *   - **вход в админку только для `admin`** (`access.admin`). Сервисному
 *     аккаунту интерфейс не нужен: он работает по API-ключу. Открытая для него
 *     админка означала бы вторую поверхность, где надо перепроверять те же
 *     запреты;
 *   - **API-ключи включены здесь** (`auth.useAPIKey`), потому что ключ по ТЗ §9
 *     принадлежит пользователю и наследует его роль. Отдельной коллекции
 *     `api-keys` в модели нет — иначе роль ключа и роль пользователя могли бы
 *     разойтись, и разбор «кто это сделал» перестал бы быть однозначным.
 *
 * ЗАДАЧА Э6-01 закрыла три дыры в этой картине. Все три существовали потому, что
 * поля API-ключа Payload добавляет в коллекцию САМ (`auth/baseFields/apiKey.js`)
 * и БЕЗ собственного access control — они наследовали правило коллекции
 * «свою запись правит любой аутентифицированный», задуманное для смены пароля:
 *
 *   1. **сервисный аккаунт управлял своим ключом.** `PATCH /api/users/<свой id>`
 *      с полями `enableAPIKey`/`apiKey` проходил: `ai-editor` мог выпустить себе
 *      новый ключ, перевыпустить существующий или отключить его. ТЗ §11 прямо
 *      относит «пользователей, ключи» к тому, чего сервисный аккаунт не трогает;
 *   2. **чужой ключ читался в открытом виде.** У поля `apiKey` есть хук
 *      `afterRead`, расшифровывающий значение, а `access.read` коллекции
 *      открыт любому аутентифицированному (это нужно, чтобы админка показывала
 *      автора записи в `seo-history`). Значит `GET /api/users` от имени
 *      `ai-editor` отдавал ключи ВСЕХ пользователей, включая администраторов;
 *   3. **отзыв ключа держался на побочном эффекте.** Стратегия аутентификации
 *      Payload ищет пользователя ТОЛЬКО по `apiKeyIndex` и `enableAPIKey` не
 *      проверяет вовсе. Обнуляет индекс хук поля `apiKeyIndex` — но лишь тогда,
 *      когда `enableAPIKey === false` пришло В ТОМ ЖЕ запросе. Запрос, где
 *      прислан один `apiKey`, оставлял флаг выключенным, а индекс — рабочим:
 *      достижимое состояние «ключ отозван, но работает».
 *
 * Закрыто тремя средствами, и каждое нужно отдельно (см. {@link API_KEY_FIELDS},
 * {@link forbiddenAccountFields}, {@link resolveApiKeyIndex}).
 *
 * Чего здесь нет: rate limiting на ключ (Ч-14, задача Э6-03), 2FA для
 * администраторов (ТЗ §11, этап 7) и запрета удалить последнего администратора
 * (это отдельная защита от самоблокировки, требует запроса к базе в хуке).
 *
 * ЗНАЧЕНИЯ ПО УМОЛЧАНИЮ У РОЛИ НЕТ (исправление находки ревизии от 2026-08-22).
 * Раньше стоял `defaultValue: 'admin'`, поэтому пользователь, созданный без
 * явной роли — в том числе через API, — получал право публикации и включения
 * `index,follow`. Дефолт открывал границу, которую защищает вся модель, и делал
 * это молча. Остальные дефолты проекта закрывают (`DEFAULT_ROBOTS` —
 * `noindex,follow`, новая запись — `draft`), а у роли «закрывающего» дефолта не
 * существует: `ai-editor` по умолчанию — тоже решение, принятое за человека, и
 * первый администратор, созданный штатным экраном Payload, оказался бы сервисным
 * аккаунтом без входа в админку. Поэтому роль обязательна и задаётся явно;
 * единственное исключение — самый первый пользователь в пустой базе
 * ({@link resolveCreateRole}).
 */

/** Запись пользователя в том виде, в каком её видят хуки. */
interface UserRecord extends TypeWithID {
  readonly [key: string]: unknown;
}

/**
 * Роль, которую нужно подставить при создании, или `null` — «оставить как есть».
 *
 * Единственный случай подстановки: пользователей в базе ЕЩЁ НЕТ, а роль не
 * задана. Так приходит запрос от штатного экрана Payload «создать первого
 * пользователя»: поле роли закрыто для неаутентифицированного запроса, и форма
 * его не присылает. Права этим не расширяются — пока пользователей ноль, первого
 * создаёт кто угодно (так устроен сам Payload, `registerFirstUser`), и админом
 * он обязан быть по смыслу: сервисный аккаунт первым не бывает, а не-admin
 * закрыл бы вход в админку насовсем.
 *
 * Во всех остальных случаях функция возвращает `null`, и запрос без роли
 * отклоняется валидацией `required` — ГРОМКО. Это и есть разница с прежним
 * поведением: раньше отсутствие роли означало «администратор».
 */
export async function resolveCreateRole(args: {
  readonly countUsers: () => Promise<number>;
  readonly incomingRole: unknown;
}): Promise<string | null> {
  const { countUsers, incomingRole } = args;

  if (typeof incomingRole === 'string' && incomingRole.trim() !== '') {
    return null;
  }

  return (await countUsers()) === 0 ? ROLES.admin : null;
}

/** Подстановка роли первому пользователю. Обвязка над {@link resolveCreateRole}. */
const assignFirstUserRole: CollectionBeforeValidateHook<UserRecord> = async ({
  data,
  operation,
  req,
}) => {
  if (operation !== 'create' || data === undefined) {
    return data;
  }

  const role = await resolveCreateRole({
    countUsers: async () => {
      const { totalDocs } = await req.payload.count({
        collection: 'users',
        overrideAccess: true,
        req,
      });
      return totalDocs;
    },
    incomingRole: data.role,
  });

  if (role === null) {
    return data;
  }

  req.payload.logger.info(
    `[users] Первый пользователь создаётся с ролью ${role}: роль в запросе не задана, ` +
      'а база пуста. Всем последующим пользователям роль задаётся явно — значения по ' +
      'умолчанию у неё нет.',
  );

  return { ...data, role };
};

/* ------------------------------------------------------------------ */
/* Э6-01. API-ключ: выпуск, отзыв, чтение                             */
/* ------------------------------------------------------------------ */

/**
 * Поля API-ключа, которые Payload добавляет в коллекцию сам.
 *
 * Имена перечислены здесь ОДИН раз и используются и в объявлении полей, и в
 * громком отказе, и в тестах: сравнение с литералом в трёх местах даёт не
 * ошибку компиляции, а тихо пропущенное поле.
 */
export const API_KEY_FIELDS = ['enableAPIKey', 'apiKey', 'apiKeyIndex'] as const;

/**
 * Поля, которыми управляется САМ аккаунт: ключ и роль.
 *
 * Роль стоит рядом с ключом не для симметрии: ключ наследует роль владельца, и
 * право сменить роль равносильно праву выпустить ключ с другими правами.
 */
export const ACCOUNT_CONTROL_FIELDS = [...API_KEY_FIELDS, 'role'] as const;

export type AccountControlField = (typeof ACCOUNT_CONTROL_FIELDS)[number];

/**
 * Какие защищённые поля пользователь пытается задать, не имея на это права.
 *
 * Чистая функция ПО СЫРЫМ данным запроса — та же роль, что у
 * `assertIncomingChangeAllowed` в статусной модели: правило доступа к полю у
 * Payload молчаливое (поле вырезается, ответ 200 с прежним значением), а
 * сервисный аккаунт обязан отличать «применено» от «проигнорировано». Поэтому
 * рядом с правилом поля стоит громкий отказ на входе операции.
 *
 * Проверяется НАЛИЧИЕ ключа в объекте, а не истинность значения:
 * `enableAPIKey: false` — это отключение чужого ключа, то есть тоже действие
 * администратора.
 */
export function forbiddenAccountFields(
  incoming: Readonly<Record<string, unknown>>,
  user: RoledUser | null | undefined,
): readonly AccountControlField[] {
  if (isAdmin(user)) {
    return [];
  }
  return ACCOUNT_CONTROL_FIELDS.filter((field) => field in incoming);
}

/**
 * Итоговое значение `apiKeyIndex` — единственного поля, по которому Payload
 * находит владельца ключа при аутентификации.
 *
 * ЗАЧЕМ ОТДЕЛЬНОЕ ПРАВИЛО, ЕСЛИ ЕСТЬ ПРАВА ПОЛЯ. Права поля выполняются ПОСЛЕ
 * хуков поля и в рамках Promise.all по всем полям сразу (проверено по
 * исходникам, `payload/dist/fields/hooks/beforeValidate/`). Хук поля
 * `apiKeyIndex` читает `data.apiKey` из общего объекта данных, а право поля
 * `apiKey` этот самый ключ из объекта удаляет — и что случится раньше, зависит
 * от числа микротактов внутри чужого кода. Полагаться на это нельзя: в
 * неудачном порядке индекс считался бы от значения, которое права уже
 * отклонили. Функция снимает вопрос: она вызывается на фазе `beforeValidate`
 * КОЛЛЕКЦИИ, то есть после того, как все поля отработали, и решает по итоговым
 * данным.
 *
 * Правило состоит из двух частей:
 *
 *   1. `enableAPIKey` не равен `true` → индекса нет. Это и есть отзыв ключа,
 *      выраженный состоянием, а не последовательностью действий: сама стратегия
 *      Payload флаг не проверяет, поэтому «ключ выключен» обязано означать
 *      «искать нечего»;
 *   2. `apiKey` в запросе НЕ приходил → индекс остаётся прежним. Пересчитывать
 *      его не от чего (в записи ключ хранится зашифрованным), а принимать
 *      присланный индекс нельзя — это и была бы подстановка чужого ключа.
 *
 * Следствие, названное прямо: повторное включение `enableAPIKey` без нового
 * `apiKey` ключ НЕ воскрешает — индекс остаётся пустым, пока администратор не
 * выпустит ключ заново. Отзыв в этой модели окончателен, и это осознанный
 * выбор: «включил обратно — старый ключ снова принимается» означало бы, что
 * скомпрометированный ключ живёт до тех пор, пока о нём не вспомнят.
 *
 * @param incoming данные ПОСЛЕ фазы полей: то, что реально будет записано
 * @param stored предыдущее состояние записи; `null` при создании
 */
export function resolveApiKeyIndex(input: {
  readonly incoming: Readonly<Record<string, unknown>>;
  readonly stored: Readonly<Record<string, unknown>> | null;
}): string | null {
  const { incoming, stored } = input;

  const enabled = 'enableAPIKey' in incoming ? incoming.enableAPIKey : stored?.enableAPIKey;
  if (enabled !== true) {
    return null;
  }

  const source = 'apiKey' in incoming ? incoming.apiKeyIndex : stored?.apiKeyIndex;
  return typeof source === 'string' && source !== '' ? source : null;
}

/**
 * Громкий отказ на попытку задать чужие или свои служебные поля.
 *
 * `overrideAccess` берётся из аргументов операции, а не угадывается: серверные
 * хуки и сидирование первого администратора ходят через Local API, где проверки
 * доступа отключены по определению. Правило закрывает ровно внешний путь — REST,
 * GraphQL и форму админки, — то есть тот, по которому ходит внешний AI-редактор.
 *
 * ГРАНИЦА НАЗВАНА ТОЧНО, БЕЗ ОКРУГЛЕНИЯ. Есть ровно один внешний маршрут, на
 * котором это правило не срабатывает, и он не наш: `POST
 * /api/users/first-register`. Операция `registerFirstUser` самого Payload зовёт
 * `payload.create` с `overrideAccess: true` (проверено по исходникам,
 * `payload/dist/auth/operations/registerFirstUser.js`), поэтому и хук выше, и
 * права полей `role`/`apiKey`/`enableAPIKey` на ней не действуют: анонимный
 * запрос может задать роль и сразу выпустить себе API-ключ.
 *
 * Почему это не закрывается здесь и не считается дырой: маршрут работает ТОЛЬКО
 * пока таблица `users` пуста — сам Payload отвечает `Forbidden`, как только в
 * ней появляется первая запись. Пустая таблица — это установка системы, где
 * защищать ещё нечего и не от кого: тот, кто выполнил этот запрос, становится
 * единственным администратором, а «сделать себя администратором» — ровно то, чем
 * этот маршрут и является. Разграничение прав начинается с существования второго
 * аккаунта, и с этого момента правило действует без исключений.
 *
 * Практически окно закрыто ещё и тем, что первый администратор создаётся при
 * старте CMS из окружения (`seedFirstAdmin` в `onInit`, решение Ч-16): к моменту,
 * когда установка отвечает на запросы, таблица уже не пуста. Но это свойство
 * развёртывания, а не правило коллекции, поэтому названо отдельно — установка,
 * поднятая наружу без `PAYLOAD_ADMIN_PASSWORD`, оставляет окно открытым, и
 * закрыть его кодом здесь нельзя.
 */
const guardAccountFields: CollectionBeforeOperationHook = ({ args, operation, req }) => {
  if (operation !== 'create' && operation !== 'update' && operation !== 'updateByID') {
    return args;
  }

  const record: Record<string, unknown> =
    typeof args === 'object' && args !== null ? { ...args } : {};

  if (record.overrideAccess === true) {
    return args;
  }

  const incoming: Record<string, unknown> =
    typeof record.data === 'object' && record.data !== null
      ? { ...(record.data as Record<string, unknown>) }
      : {};

  const forbidden = forbiddenAccountFields(incoming, req.user);
  if (forbidden.length === 0) {
    return args;
  }

  throw new APIError(
    `Поля аккаунта (${forbidden.join(', ')}) задаёт только администратор (ТЗ §11: ` +
      'пользователей и ключи сервисный аккаунт не трогает). API-ключ принадлежит ' +
      'пользователю и наследует его роль, поэтому право выпустить, перевыпустить или ' +
      'отключить ключ — это то же самое право, что назначить роль. Запрос отклонён ' +
      'целиком, а не выполнен частично: молчаливое срезание поля оставило бы вызывающего ' +
      'в уверенности, что операция применена.',
    403,
    { rule: 'account-fields-require-admin' },
    true,
  );
};

/**
 * Приводит `apiKeyIndex` в согласие с флагом и присланным ключом.
 *
 * Стоит на фазе `beforeValidate` КОЛЛЕКЦИИ: она выполняется строго после всех
 * хуков и прав полей (порядок Payload: beforeValidate-поля → beforeValidate-
 * коллекция → beforeChange-коллекция → beforeChange-поля), поэтому здесь видно
 * итоговое состояние, а не гонку.
 */
const sealApiKeyIndex: CollectionBeforeValidateHook<UserRecord> = ({ data, originalDoc }) => {
  if (data === undefined) {
    return data;
  }
  const stored: Record<string, unknown> | null =
    typeof originalDoc === 'object' && originalDoc !== null
      ? { ...(originalDoc as Record<string, unknown>) }
      : null;

  return { ...data, apiKeyIndex: resolveApiKeyIndex({ incoming: data, stored }) };
};

export const Users: CollectionConfig = {
  slug: 'users',
  labels: {
    singular: 'Пользователь',
    plural: 'Пользователи',
  },
  admin: {
    defaultColumns: ['email', 'role', 'enableAPIKey'],
    description:
      'Две роли: admin (человек, полные права) и ai-editor (сервисный аккаунт с ' +
      'API-ключом, доводит контент до review).',
    useAsTitle: 'email',
  },
  auth: {
    // Ключ выпускается пользователю и действует с его ролью: сервисный аккаунт
    // ai-editor через API получает ровно те права, что записаны в матрице.
    useAPIKey: true,
  },
  access: {
    // Вход в интерфейс админки — только человек.
    admin: adminPanelAccess,
    create: adminOnlyAccess,
    delete: adminOnlyAccess,
    // Список пользователей виден аутентифицированным: без этого админка не
    // отрисует автора изменения (нужно для seo-history, Э1-07).
    read: authenticatedAccess,
    // Свою запись правит любой аутентифицированный (смена пароля), чужие — admin.
    // Роль при этом защищена отдельно, на уровне поля.
    update: ({ id, req }) => isAdmin(req.user) || (Boolean(req.user) && req.user?.id === id),
    unlock: adminOnlyAccess,
  },
  hooks: {
    // Громкий отказ на СЫРЫХ данных — до того, как права полей молча срежут
    // защищённые значения.
    beforeOperation: [guardAccountFields],
    // Порядок значим: роль подставляется первому пользователю, и только потом
    // приводится в согласие индекс ключа — он зависит от итоговых данных.
    beforeValidate: [assignFirstUserRole, sealApiKeyIndex],
  },
  fields: [
    /*
     * Поля API-ключа объявлены ЯВНО, хотя Payload добавляет их сам.
     *
     * Так к ним удаётся привязать access control: `mergeBaseFields` сливает
     * одноимённое поле конфига с базовым, и свойства конфига выигрывают
     * (проверено по `payload/dist/fields/mergeBaseFields.js`). Хуки базового
     * поля при этом сохраняются — здесь их нет, значит шифрование ключа
     * (`beforeChange`), расшифровка (`afterRead`) и расчёт индекса
     * (`beforeValidate`) остаются на месте.
     */
    {
      name: 'enableAPIKey',
      type: 'checkbox',
      access: {
        create: adminOnlyFieldAccess,
        update: adminOnlyFieldAccess,
        // `read` не ограничен намеренно: это флаг «у аккаунта есть ключ», а не
        // сам ключ. Закрывать его — значит прятать от админки колонку списка,
        // ничего при этом не защищая.
      },
      admin: {
        description:
          'Выдан ли аккаунту API-ключ. Включает и выключает только admin: ключ наследует ' +
          'роль владельца, поэтому распоряжаться им — то же право, что назначать роли.',
      },
    },
    {
      name: 'apiKey',
      type: 'text',
      access: {
        create: adminOnlyFieldAccess,
        // Значение расшифровывается хуком afterRead самого Payload, а список
        // пользователей читает любой аутентифицированный (это нужно, чтобы
        // админка показывала автора в seo-history). Без этого правила сервисный
        // аккаунт одним GET получал бы ключи всех, включая администраторов.
        read: adminOnlyFieldAccess,
        update: adminOnlyFieldAccess,
      },
      admin: {
        description:
          'Сам ключ. Читает и меняет только admin — в том числе у своей записи: ключ ' +
          'выдаётся аккаунту, а не принадлежит ему.',
      },
    },
    {
      name: 'apiKeyIndex',
      type: 'text',
      access: {
        create: adminOnlyFieldAccess,
        read: adminOnlyFieldAccess,
        update: adminOnlyFieldAccess,
      },
    },
    {
      name: 'role',
      type: 'select',
      required: true,
      // defaultValue отсутствует НАМЕРЕННО: см. шапку модуля. Дефолт «admin»
      // выдавал право публикации любому запросу, где роль не указана.
      options: [
        { label: 'Администратор (человек)', value: ROLES.admin },
        { label: 'AI-редактор (сервисный аккаунт)', value: ROLES.aiEditor },
      ],
      admin: {
        description:
          'admin — полные права, включая публикацию и index,follow. ' +
          'ai-editor — черновики, метаданные, привязка к подборкам и перевод draft → review. ' +
          'Значения по умолчанию нет: роль указывается явно при создании пользователя.',
      },
      access: {
        // Роль назначает только admin — и на создании, и на обновлении.
        create: adminOnlyFieldAccess,
        update: adminOnlyFieldAccess,
      },
    },
  ],
};
