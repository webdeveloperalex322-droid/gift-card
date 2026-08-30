import type { Payload } from 'payload';

import { ROLES } from './access/roles';

/**
 * Создаёт первого администратора из окружения при первом запуске (решение Ч-16).
 *
 * Правила, которые здесь важны:
 *   - создаётся РОВНО ОДИН раз: если в коллекции `users` уже есть хоть одна
 *     запись, функция ничего не делает. Пароль из env не перезаписывает пароль
 *     существующего пользователя;
 *   - без `PAYLOAD_ADMIN_PASSWORD` пользователь не создаётся — работает штатный
 *     экран Payload «создать первого пользователя». Пароль по умолчанию был бы
 *     общеизвестным и открывал бы админку на любом стенде;
 *   - роль всегда `admin`: сервисный аккаунт `ai-editor` заводится отдельно
 *     (задача Э1-03/Э6-01) и никогда не бывает первым.
 *
 * Функция не бросает исключений на отсутствие переменных: `onInit` выполняется
 * при каждом старте, и падение здесь означало бы, что CMS не поднимается на
 * стенде, где первый администратор уже создан руками.
 */
export async function seedFirstAdmin(payload: Payload): Promise<void> {
  const email = process.env.PAYLOAD_ADMIN_EMAIL?.trim() ?? '';
  const password = process.env.PAYLOAD_ADMIN_PASSWORD?.trim() ?? '';

  const { totalDocs } = await payload.count({ collection: 'users' });

  if (totalDocs > 0) {
    return;
  }

  if (email === '' || password === '') {
    payload.logger.warn(
      'Пользователей нет, и первый администратор из окружения не создан: ' +
        'нужны PAYLOAD_ADMIN_EMAIL и PAYLOAD_ADMIN_PASSWORD. ' +
        'Создайте первого пользователя через экран админки.',
    );
    return;
  }

  await payload.create({
    collection: 'users',
    data: {
      email,
      password,
      role: ROLES.admin,
    },
  });

  payload.logger.info(`Создан первый администратор из окружения: ${email}`);
}
