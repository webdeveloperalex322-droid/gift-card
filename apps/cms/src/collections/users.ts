import type { CollectionConfig } from 'payload';

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
 */
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
  fields: [
    {
      name: 'role',
      type: 'select',
      required: true,
      defaultValue: ROLES.admin,
      options: [
        { label: 'Администратор (человек)', value: ROLES.admin },
        { label: 'AI-редактор (сервисный аккаунт)', value: ROLES.aiEditor },
      ],
      admin: {
        description:
          'admin — полные права, включая публикацию и index,follow. ' +
          'ai-editor — черновики, метаданные, привязка к подборкам и перевод draft → review.',
      },
      access: {
        // Роль назначает только admin — и на создании, и на обновлении.
        create: adminOnlyFieldAccess,
        update: adminOnlyFieldAccess,
      },
    },
  ],
};
