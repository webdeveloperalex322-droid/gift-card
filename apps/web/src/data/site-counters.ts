/**
 * Код сторонних счётчиков из настроек сайта (решение Ч-36).
 *
 * Функция здесь — не удобство, а ПРОВЕРКА ТИПОМ, та же, что `infoPageFacts`
 * (`./info-pages.ts`): предикат {@link siteCountersCode} описан структурным
 * интерфейсом, потому что его зовёт и `apps/cms`, и этот пакет, где данные
 * приходят из ответа Payload. Без такой прослойки переименованное поле глобала
 * разошлось бы с предикатом МОЛЧА — предикат увидел бы `undefined` и честно
 * сказал «печатать нечего», то есть счётчик просто перестал бы работать, а
 * админка показывала бы заполненное поле. Здесь расхождение ломает `pnpm check`.
 *
 * Трактовка «печатать или промолчать» своя НЕ ЗАВОДИТСЯ: она одна на
 * монорепозиторий и живёт в `@otkritka/shared`.
 */
import type { SiteSetting } from '@otkritka/cms/types';
import { siteCountersCode } from '@otkritka/shared';

/** Код для вставки в страницу либо `null`, если вставлять нечего. */
export function siteCountersFor(settings: SiteSetting): string | null {
  return siteCountersCode(settings.counters ?? {});
}
