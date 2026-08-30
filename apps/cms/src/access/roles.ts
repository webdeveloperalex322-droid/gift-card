/**
 * Роли системы (решение Ч-16: ровно две) и предикаты для access control.
 *
 * Строки ролей объявлены здесь один раз, чтобы права нигде не сравнивались с
 * литералом: опечатка в литерале даёт не ошибку компиляции, а тихо разрешённое
 * действие.
 *
 * ГРАНИЦА ЗАДАЧИ Э1-02: здесь только предикаты. Матрица прав по коллекциям —
 * задача Э1-03; правила статусной модели (`draft` → `review` → `published`) —
 * Э1-08. Ни одно из них не должно жить в UI админки: Payload сам отдаёт REST и
 * GraphQL, поэтому правило, которого нет в access control и хуках, обходится
 * внешним клиентом.
 */

export const ROLES = {
  /** Человек. Полные права, включая публикацию и переключение index/noindex. */
  admin: 'admin',
  /** Сервисный аккаунт AI-редактора. Доводит контент до `review`, не дальше. */
  aiEditor: 'ai-editor',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/**
 * Минимальный контракт пользователя для проверки роли.
 *
 * Намеренно шире сгенерированного `User`: предикаты вызываются из access
 * control, где `req.user` может быть `null`, и должны компилироваться до первого
 * `pnpm generate:types`.
 */
export interface RoledUser {
  readonly role?: string | null;
}

export function isAdmin(user: RoledUser | null | undefined): boolean {
  return user?.role === ROLES.admin;
}

export function isAiEditor(user: RoledUser | null | undefined): boolean {
  return user?.role === ROLES.aiEditor;
}
