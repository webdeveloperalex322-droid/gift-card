/**
 * Служебные информационные страницы: чтение глобала настроек (задача Э3-11).
 *
 * Разделение с `../seo/info-pages.ts` — по зависимостям, как у крошек, карточки и
 * подборки. Там живут ПРАВИЛА (имена страниц, сборка головы документа, крошки,
 * состав ссылок в подвале) — чистые функции без типов CMS. Здесь живёт ЧТЕНИЕ:
 * какая группа глобала соответствует какой странице. Модуль импортирует
 * сгенерированные типы Payload, поэтому в composite-проект
 * `../../tsconfig.node.json` войти не может.
 *
 * ## Зачем этот модуль вообще нужен
 *
 * `infoPageFacts` — не удобство, а ПРОВЕРКА ТИПОМ. Предикаты Ч-23 в
 * `@otkritka/shared` описаны структурным интерфейсом `InfoPageFacts` (их зовут и
 * `apps/cms`, и `apps/web`), поэтому переименованное поле глобала разошлось бы с
 * предикатом МОЛЧА: тот увидел бы `undefined` и честно сказал «не индексировать»,
 * то есть выключатель человека перестал бы работать без единой ошибки. Здесь
 * расхождение ломает `pnpm check`. Ровно та же функция и по той же причине есть в
 * `apps/cms` (`src/globals/site-settings.ts`) — она проверяет ту же связь со своей
 * стороны, а через границу пакетов экспортируются только типы (`@otkritka/cms/types`).
 */

import type { SiteSetting } from '@otkritka/cms/types';
import type { InfoPageFacts, InfoPageKey } from '@otkritka/shared';

import { readSiteSettings } from './content.js';
import { type InfoPageView, infoPageView } from '../seo/info-pages.js';

/**
 * Группа глобала, соответствующая служебной странице.
 *
 * Пустой объект при незаполненной группе — нормальное состояние, а не ошибка:
 * человек ещё не писал текст, и предикат Ч-23 обязан ответить «не индексировать»,
 * а не упасть.
 */
export function infoPageFacts(settings: SiteSetting, key: InfoPageKey): InfoPageFacts {
  return settings.infoPages?.[key] ?? {};
}

/**
 * Готовая служебная страница: голова документа и тело.
 *
 * Три маршрута (`/o-proekte`, `/usloviya`, `/kontakty`) отличаются одним
 * аргументом, поэтому решение собирается здесь, а не в каждом шаблоне: три копии
 * одного порядка вызовов однажды разошлись бы в canonical или в директиве робота,
 * и разошлись бы молча.
 *
 * Исхода «страницы нет» у этой функции НЕТ намеренно: незаполненная служебная
 * страница отвечает 200 с заглушкой и `noindex` — обоснование в шапке
 * `../seo/info-pages.ts`.
 */
export async function infoPage(key: InfoPageKey): Promise<InfoPageView> {
  const settings = await readSiteSettings();
  return infoPageView(key, infoPageFacts(settings, key));
}
