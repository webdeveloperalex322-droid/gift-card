/**
 * Ссылки «поделиться» для страницы карточки (задача Э3-05, ТЗ §5.4).
 *
 * Требование ТЗ дословно: «Кнопки шаринга (WhatsApp, Telegram, VK,
 * Одноклассники) — без загрузки внешних SDK, через share-URL». Из этого следует
 * вся конструкция модуля:
 *
 *   - никакого клиентского JS. Каждая «кнопка» — обычная `<a href>` на
 *     share-эндпоинт сервиса; страница остаётся полноценной при отключённом JS,
 *     а инвариант «ноль клиентского JS» не нарушается;
 *   - никаких виджетов и счётчиков. Виджет — это чужой скрипт на каждой карточке
 *     сайта, то есть чужой код в критическом пути LCP;
 *   - адрес страницы приходит АБСОЛЮТНЫМ (собранным единственным хелпером над
 *     `SITE_URL`). Относительный путь в параметре share-URL означал бы ссылку на
 *     хост самого сервиса.
 *
 * Модуль ЧИСТЫЙ, входит в composite-проект `../../tsconfig.node.json` и
 * проверяется юнит-тестом: правильность кодирования параметров глазом не
 * проверяется, а неэкранированный `&` в заголовке ломает второй параметр.
 */

import { looksLikeAbsoluteUrl } from '@otkritka/shared';

/** Сервисы из ТЗ §5.4. Набор закрыт: произвольный адрес шаринга не добавляется. */
export const SHARE_SERVICES = ['whatsapp', 'telegram', 'vk', 'odnoklassniki'] as const;

export type ShareService = (typeof SHARE_SERVICES)[number];

/** Видимый текст ссылки. Иконок-шрифтов и картинок здесь нет: это текст. */
export const SHARE_SERVICE_LABELS: Readonly<Record<ShareService, string>> = Object.freeze({
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  vk: 'ВКонтакте',
  odnoklassniki: 'Одноклассники',
});

export interface ShareTarget {
  readonly service: ShareService;
  readonly label: string;
  /** Готовый абсолютный адрес share-эндпоинта сервиса. */
  readonly href: string;
}

export interface ShareInput {
  /** Абсолютный канонический адрес страницы карточки. */
  readonly url: string;
  /** Заголовок, который посетитель увидит в сообщении. Обычно H1 карточки. */
  readonly title: string;
}

/**
 * Шаблоны share-URL.
 *
 * Формы взяты официальными точками «поделиться» самих сервисов и не содержат ни
 * идентификаторов приложений, ни ключей: у ссылки, требующей ключа, появился бы
 * второй владелец — настройки, — и она молча перестала бы работать при их
 * изменении. WhatsApp единственный принимает один параметр `text`, поэтому
 * заголовок и адрес там склеиваются в одну строку.
 */
const SHARE_URL_BUILDERS: Readonly<Record<ShareService, (input: ShareInput) => string>> =
  Object.freeze({
    whatsapp: (input) =>
      `https://api.whatsapp.com/send?text=${encodeURIComponent(`${input.title} ${input.url}`)}`,
    telegram: (input) =>
      `https://t.me/share/url?url=${encodeURIComponent(input.url)}&text=${encodeURIComponent(input.title)}`,
    vk: (input) =>
      `https://vk.com/share.php?url=${encodeURIComponent(input.url)}&title=${encodeURIComponent(input.title)}`,
    odnoklassniki: (input) =>
      `https://connect.ok.ru/offer?url=${encodeURIComponent(input.url)}&title=${encodeURIComponent(input.title)}`,
  });

/**
 * Ссылки «поделиться» в порядке из ТЗ.
 *
 * @throws Error если адрес страницы не абсолютный или заголовок пуст. Оба случая
 *   дали бы работающую с виду ссылку с бессмысленным содержимым: относительный
 *   путь превратился бы в адрес на хосте сервиса, а пустой заголовок — в
 *   сообщение из одного адреса.
 */
export function shareTargets(input: ShareInput): readonly ShareTarget[] {
  if (!looksLikeAbsoluteUrl(input.url)) {
    throw new Error(
      `Адрес «${input.url}» для ссылок «поделиться» не абсолютный. Сервис открывает его на ` +
        'своём хосте, поэтому путь от корня превратился бы в ссылку на страницу сервиса. ' +
        'Абсолютный адрес собирает единственный хелпер над SITE_URL.',
    );
  }
  const title = input.title.trim();
  if (title === '') {
    throw new Error(
      'Заголовок для ссылок «поделиться» пуст: в сообщении остался бы один адрес. ' +
        'Заголовок — это H1 карточки, и его отсутствие означает незаполненную запись.',
    );
  }

  return SHARE_SERVICES.map((service) => ({
    service,
    label: SHARE_SERVICE_LABELS[service],
    href: SHARE_URL_BUILDERS[service]({ title, url: input.url }),
  }));
}
