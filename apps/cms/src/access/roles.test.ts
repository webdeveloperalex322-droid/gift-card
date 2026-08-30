/**
 * Предикаты ролей: негативные проверки важнее позитивных.
 *
 * Право, которого нет на бумаге, но есть в реальности, появляется именно здесь:
 * если `isAdmin` вернёт `true` для сервисного аккаунта или для анонима, вся
 * граница автоматизации (публикация, index/noindex, редиректы) окажется
 * открытой, а тест на неё будет зелёным по другой причине.
 */
import { describe, expect, it } from 'vitest';

import { ROLES, isAdmin, isAiEditor } from './roles';

describe('роли', () => {
  it('решение Ч-16: ровно две роли с ожидаемыми строками', () => {
    expect(Object.values(ROLES)).toEqual(['admin', 'ai-editor']);
  });
});

describe('isAdmin', () => {
  it('истина только для роли admin', () => {
    expect(isAdmin({ role: ROLES.admin })).toBe(true);
  });

  it('ложь для сервисного аккаунта, анонима и мусора', () => {
    expect(isAdmin({ role: ROLES.aiEditor })).toBe(false);
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
    expect(isAdmin({})).toBe(false);
    expect(isAdmin({ role: null })).toBe(false);
    expect(isAdmin({ role: '' })).toBe(false);
    expect(isAdmin({ role: 'Admin' })).toBe(false);
    expect(isAdmin({ role: 'administrator' })).toBe(false);
  });
});

describe('isAiEditor', () => {
  it('истина только для роли ai-editor', () => {
    expect(isAiEditor({ role: ROLES.aiEditor })).toBe(true);
  });

  it('ложь для admin, анонима и мусора', () => {
    expect(isAiEditor({ role: ROLES.admin })).toBe(false);
    expect(isAiEditor(null)).toBe(false);
    expect(isAiEditor(undefined)).toBe(false);
    expect(isAiEditor({ role: 'ai_editor' })).toBe(false);
  });
});
