import type { CollectionConfig } from 'payload';

import { ROLES, isAdmin } from '../access/roles';

/**
 * Пользователи админки (bootstrap-минимум задачи Э1-02).
 *
 * ГРАНИЦА ЗАДАЧИ: полная матрица прав по ролям и её тесты — задача Э1-03.
 * Здесь ровно то, без чего админка не поднимается и без чего bootstrap оставил
 * бы дыру:
 *
 *   - коллекция аутентификации (`auth: true`), иначе входить некуда;
 *   - поле `role` с двумя значениями по решению Ч-16 (`admin` — человек,
 *     `ai-editor` — сервисный аккаунт). Поле заведено сразу, потому что схема
 *     таблицы создаётся при первом запуске, а первый администратор создаётся
 *     уже с ролью: добавить роль позже означало бы строку с пустой ролью;
 *   - запрет на самостоятельное повышение роли и на создание пользователей
 *     кем-либо кроме `admin`. Без этого сервисный аккаунт `ai-editor` мог бы
 *     выдать себе `admin` через REST API и обойти всю границу автоматизации —
 *     то есть bootstrap поставлял бы дыру, а не «минимум».
 *
 * Чего здесь СОЗНАТЕЛЬНО нет (делает Э1-03): выпуск API-ключей, привязка ключа
 * к роли, права на контентные коллекции, полная матрица позитивных и
 * негативных проверок.
 */
export const Users: CollectionConfig = {
  slug: 'users',
  admin: {
    defaultColumns: ['email', 'role'],
    useAsTitle: 'email',
  },
  auth: true,
  access: {
    // Пользователей создаёт и удаляет только человек с ролью admin: сервисный
    // аккаунт не должен уметь заводить себе второй аккаунт с другой ролью.
    create: ({ req }) => isAdmin(req.user),
    delete: ({ req }) => isAdmin(req.user),
    // Список пользователей виден всем аутентифицированным: без этого админка
    // не может отрисовать «кто автор изменения» (нужно для seo-history, Э1-07).
    read: ({ req }) => Boolean(req.user),
    // Свою запись правит любой аутентифицированный (смена пароля), чужие — admin.
    update: ({ id, req }) => isAdmin(req.user) || (Boolean(req.user) && req.user?.id === id),
  },
  fields: [
    {
      name: 'role',
      type: 'select',
      required: true,
      defaultValue: 'admin',
      options: [
        { label: 'Администратор (человек)', value: ROLES.admin },
        { label: 'AI-редактор (сервисный аккаунт)', value: ROLES.aiEditor },
      ],
      admin: {
        description:
          'admin — полные права, включая публикацию и index/follow. ' +
          'ai-editor — только черновики и перевод draft → review.',
      },
      access: {
        // Роль меняет только admin. Иначе ai-editor выдал бы себе admin через
        // PATCH /api/users/<id> — правило, живущее лишь в UI, обходится через API.
        create: ({ req }) => isAdmin(req.user),
        update: ({ req }) => isAdmin(req.user),
      },
    },
  ],
};
