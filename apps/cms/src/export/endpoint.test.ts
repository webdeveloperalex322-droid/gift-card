/**
 * Права ручки выгрузки (Э5-05).
 *
 * Проверяется одна развилка, зато с обеих сторон: ОТЧЁТ доступен любому
 * аутентифицированному (записи он и так читает через тот же access control), а
 * ОПРОС САЙТА — только `admin`. Разница содержательная: без опроса вызов стоит
 * двух запросов к базе, с опросом — до `MAX_INVENTORY_ROWS` запросов CMS к
 * собственному сайту, то есть является рычагом усиления. Находка ревизии от
 * 2026-08-29.
 *
 * Живьём то же самое проверяет `scripts/smoke-etap5-jobs-access.ts`.
 */
import { describe, expect, it } from 'vitest';

import { planSiteProbe, shouldProbeSite } from './endpoint';

const admin = { role: 'admin' };
const aiEditor = { role: 'ai-editor' };

describe('параметр probe', () => {
  it('по умолчанию опрос просят, выключает только явное 0/false', () => {
    expect(shouldProbeSite('/api/seo-inventory.csv')).toBe(true);
    expect(shouldProbeSite('/api/seo-inventory.csv?probe=1')).toBe(true);
    expect(shouldProbeSite('/api/seo-inventory.csv?probe=0')).toBe(false);
    expect(shouldProbeSite('/api/seo-inventory.csv?probe=false')).toBe(false);
  });
});

describe('кто вправе заставить CMS опрашивать сайт', () => {
  it('admin опрашивает', () => {
    expect(planSiteProbe({ requested: true, user: admin })).toEqual({
      absence: null,
      probe: true,
    });
  });

  it('сервисный аккаунт — нет, и причина названа', () => {
    expect(planSiteProbe({ requested: true, user: aiEditor })).toEqual({
      absence: 'forbidden',
      probe: false,
    });
  });

  it('пользователя нет — опроса нет (ручка до этого места не доходит, но правило одно)', () => {
    expect(planSiteProbe({ requested: true, user: null }).probe).toBe(false);
  });

  it('явный отказ от опроса называется «не просили», а не «нельзя»', () => {
    // Порядок причин значим: если вызывающий сам поставил probe=0, отказ по
    // роли ему не про что, и объяснение про admin было бы шумом.
    expect(planSiteProbe({ requested: false, user: aiEditor })).toEqual({
      absence: 'not-requested',
      probe: false,
    });
    expect(planSiteProbe({ requested: false, user: admin }).absence).toBe('not-requested');
  });
});
