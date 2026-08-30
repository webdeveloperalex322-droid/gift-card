import type { CollectionBeforeValidateHook, CollectionConfig, TypeWithID } from 'payload';

import {
  adminOnlyAccess,
  adminOnlyFieldAccess,
  adminPanelAccess,
  authenticatedAccess,
} from '../access/policies';
import { ROLES, isAdmin } from '../access/roles';

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
    beforeValidate: [assignFirstUserRole],
  },
  fields: [
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
