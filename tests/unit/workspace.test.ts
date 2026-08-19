import { describe, expect, it } from 'vitest';
import {
  CONTENT_STATUSES,
  isIndexableStatus,
  TRAILING_SLASH,
} from '@otkritka/shared';
import { FALLBACK_FORMAT, OUTPUT_FORMATS } from '@otkritka/images';

// Тест скелета: проверяет, что монорепозиторий собран и пакеты видны друг другу.
// Заменяется настоящими тестами по мере реализации; удалять его не нужно —
// он ловит поломку workspace-резолвинга раньше, чем это заметит сборка.
describe('монорепозиторий', () => {
  it('резолвит workspace-пакеты', () => {
    expect(CONTENT_STATUSES).toEqual(['draft', 'review', 'published']);
    expect(OUTPUT_FORMATS).toContain(FALLBACK_FORMAT);
  });

  it('фиксирует единое правило завершающего слеша', () => {
    expect(TRAILING_SLASH).toBe(true);
  });

  it('не считает индексируемыми ни draft, ни review', () => {
    expect(isIndexableStatus('draft')).toBe(false);
    expect(isIndexableStatus('review')).toBe(false);
    expect(isIndexableStatus('published')).toBe(true);
  });
});
