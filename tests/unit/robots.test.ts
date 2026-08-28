/**
 * Набор значений robots-директивы — ОДИН на монорепозиторий (задача Э4-05).
 *
 * Почему набор переехал в `packages/shared`: до этого он лежал двумя копиями —
 * в `apps/cms/src/seo/robots.ts` (там он определяет поле записи и опции select
 * в админке) и в `apps/web/src/seo/robots-directive.ts` (там по нему проверяется
 * объявленная директива и отбираются страницы в sitemap). Копия появилась не по
 * небрежности: импортировать `.ts` чужого пакета в composite-проект `apps/web`
 * нельзя. Но два закрытых набора значений, управляющих индексацией, расходятся
 * молча: значение, добавленное в CMS и неизвестное вебу, дало бы либо
 * исключение на рендере, либо страницу, закрытую в разметке и открытую в карте
 * сайта.
 *
 * Что здесь проверяется:
 *   1. состав набора и его закрытость (никаких «похожих» написаний);
 *   2. дефолт закрывает, а не открывает — новая запись не попадает в индекс
 *      сама (CLAUDE.md, «Правила модели», ТЗ §7.1 и §8.2);
 *   3. копия в `apps/web` пока существует и обязана совпадать с общим набором.
 *      Этот пункт — временный: `apps/web` принадлежит другому агенту, и после
 *      того, как он перейдёт на импорт из `@otkritka/shared`, проверка станет
 *      тавтологией и её можно снять.
 *
 * Того же про `apps/cms` здесь НЕТ, и это не пробел: проект `tests` ссылается на
 * `packages/*` и на `apps/web/tsconfig.node.json`, но не на `apps/cms` — тот
 * собирается Next'ом и composite-проектом не является. Проверка тождества
 * реэкспорта живёт рядом с ним, в `apps/cms/src/seo/robots.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ROBOTS,
  isIndexableRobots,
  isRobotsDirective,
  ROBOTS_DIRECTIVES,
} from '@otkritka/shared';

import { ROBOTS_DIRECTIVES as WEB_ROBOTS_DIRECTIVES } from '../../apps/web/src/seo/robots-directive.js';

describe('набор значений robots-директивы', () => {
  it('состоит ровно из трёх значений ТЗ §8.1, от открытого к закрытому', () => {
    expect(ROBOTS_DIRECTIVES).toEqual(['index,follow', 'noindex,follow', 'noindex,nofollow']);
  });

  it('закрыт: похожие написания значением не являются', () => {
    for (const directive of ROBOTS_DIRECTIVES) {
      expect(isRobotsDirective(directive), directive).toBe(true);
    }
    // Пробел после запятой, верхний регистр и «половина» директивы — это
    // рассогласование схемы, а не синоним: подставить вместо них ближайшее
    // допустимое значение значит тихо изменить решение человека об индексации.
    for (const wrong of ['index, follow', 'INDEX,FOLLOW', 'noindex', 'follow', '', 'all']) {
      expect(isRobotsDirective(wrong), wrong).toBe(false);
    }
    for (const wrong of [null, undefined, 0, {}, ['index,follow']]) {
      expect(isRobotsDirective(wrong), JSON.stringify(wrong)).toBe(false);
    }
  });

  it('индексацию разрешает только «index,follow», и по равенству, а не по отсутствию «noindex»', () => {
    expect(isIndexableRobots('index,follow')).toBe(true);
    expect(isIndexableRobots('noindex,follow')).toBe(false);
    expect(isIndexableRobots('noindex,nofollow')).toBe(false);
    // Значение вне набора индексацию не разрешает: «всё, что не noindex» при
    // появлении нового значения молча пустило бы страницу в индекс.
    expect(isIndexableRobots('all')).toBe(false);
    expect(isIndexableRobots(undefined)).toBe(false);
  });

  it('дефолт закрывает: новая запись в индекс не попадает', () => {
    expect(DEFAULT_ROBOTS).toBe('noindex,follow');
    expect(isRobotsDirective(DEFAULT_ROBOTS)).toBe(true);
    expect(isIndexableRobots(DEFAULT_ROBOTS)).toBe(false);
  });
});

describe('единственность источника набора', () => {
  it('копия в apps/web совпадает с общим набором (сторож до перехода web на shared)', () => {
    expect(WEB_ROBOTS_DIRECTIVES).toEqual(ROBOTS_DIRECTIVES);
  });
});
