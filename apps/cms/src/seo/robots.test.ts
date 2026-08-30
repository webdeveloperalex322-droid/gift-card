/**
 * `apps/cms/src/seo/robots.ts` — точка входа, а не второй источник (задача Э4-05).
 *
 * Набор значений robots-директивы переехал в `packages/shared`; модуль CMS
 * остался только реэкспортом, потому что от него зависят правила доступа,
 * определения полей и планировщик статусов. Проверяется ТОЖДЕСТВО объектов, а не
 * равенство значений: равные значения бывают и у двух разных списков — именно
 * так копия и жила до переезда, — а тождество бывает только у одного.
 *
 * Тест лежит рядом с модулем, а не в `tests/unit/`, по причине из устройства
 * сборки: проект `tests` ссылается на `packages/*` и на `apps/web`, но не на
 * `apps/cms` (тот собирается Next'ом и composite-проектом не является), поэтому
 * импорт файла CMS из общего теста не проходит `tsc -b`.
 */
import { describe, expect, it } from 'vitest';

import * as shared from '@otkritka/shared';

import * as cmsRobots from './robots';

describe('Э4-05: CMS реэкспортирует общий набор, а не держит свой', () => {
  it('константы — те же объекты, что в @otkritka/shared', () => {
    expect(cmsRobots.ROBOTS_DIRECTIVES).toBe(shared.ROBOTS_DIRECTIVES);
    expect(cmsRobots.DEFAULT_ROBOTS).toBe(shared.DEFAULT_ROBOTS);
  });

  it('предикаты — те же функции', () => {
    expect(cmsRobots.isRobotsDirective).toBe(shared.isRobotsDirective);
    expect(cmsRobots.isIndexableRobots).toBe(shared.isIndexableRobots);
  });

  it('дефолт по-прежнему закрывает: новая запись в индекс не попадает', () => {
    // Дублируется намеренно: это значение — часть защиты, и его смена обязана
    // ронять тест в ТОМ приложении, где заводится запись, а не только в общем.
    expect(cmsRobots.DEFAULT_ROBOTS).toBe('noindex,follow');
    expect(cmsRobots.isIndexableRobots(cmsRobots.DEFAULT_ROBOTS)).toBe(false);
  });
});
