/**
 * Robots-директивы записи — РЕЭКСПОРТ общего набора из `@otkritka/shared`.
 *
 * Определение переехало в `packages/shared/src/robots.ts` (задача Э4-05):
 * тот же закрытый набор значений держал у себя и `apps/web`
 * (`src/seo/robots-directive.ts`), а два закрытых набора, управляющих
 * индексацией, расходятся молча — значение, известное CMS и неизвестное вебу,
 * даёт страницу, закрытую в разметке и открытую в карте сайта.
 *
 * Модуль оставлен точкой входа, а не удалён, ровно по той причине, по которой он
 * появился: от него зависят и правила доступа (`access/policies.ts`), и
 * определения полей (`collections/seo-fields.ts`), и планировщик статусов
 * (`collections/status-model.ts`). Собственных значений здесь больше нет —
 * тождество реэкспорта и общего набора проверяется тестом
 * `tests/unit/robots.test.ts`, поэтому вернуть сюда копию незаметно нельзя.
 */
export {
  DEFAULT_ROBOTS,
  isIndexableRobots,
  isRobotsDirective,
  ROBOTS_DIRECTIVES,
  type RobotsDirective,
} from '@otkritka/shared';
