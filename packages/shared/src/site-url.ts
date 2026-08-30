/**
 * Сборка абсолютного URL — ЕДИНСТВЕННЫЙ хелпер на весь монорепозиторий.
 *
 * Норма — `CLAUDE.md`, раздел «Правила URL»: любой абсолютный URL (canonical,
 * sitemap, robots.txt, JSON-LD, `contentUrl` в `ImageObject`) собирается только
 * здесь и только из env-параметра `SITE_URL`. Второго места, где появляется
 * хост, быть не должно: расхождение между canonical и sitemap обнаруживается
 * уже после индексации, и лечится оно переиндексацией, а не правкой кода.
 *
 * Хост не хардкодится: ни дефолта, ни фолбэка — ни локального, ни тестового.
 * Пустое значение обязано валить сборку с внятной ошибкой; подставленный
 * плейсхолдер означал бы, что canonical и sitemap молча собрались не на том
 * хосте. Значение на время разработки принято решением Ч-02 и живёт в `.env`,
 * в код оно не переносится.
 *
 * Домена изображений здесь нет намеренно: решение Ч-03 (2026-08-21) убрало
 * отдельный `IMAGES_CDN_ORIGIN` — производные отдаются с собственного домена по
 * пути `/media/...`, поэтому их абсолютные URL собирает этот же хелпер.
 */

import { currentEnv, type SharedEnv } from './env.js';
import { canonicalizePath, looksLikeAbsoluteUrl } from './routes.js';

/** Имя переменной окружения. Экспортируется, чтобы тексты ошибок и тесты не расходились. */
export const SITE_URL_ENV_KEY = 'SITE_URL';

const ALLOWED_PROTOCOLS: readonly string[] = ['http:', 'https:'];

function invalidValue(raw: string, why: string): Error {
  return new Error(
    `${SITE_URL_ENV_KEY} задан некорректно: ${why} Получено: «${raw}». ` +
      'Контракт значения: схема + хост без завершающего слеша, ровно один хост на весь сайт ' +
      '(CLAUDE.md, правила URL).',
  );
}

/**
 * Схема и хост из `SITE_URL`, без завершающего слеша.
 *
 * Нормализация хвостового слеша — обязанность этого кода, а не автора `.env`:
 * иначе `https://host/` дал бы `https://host//otkrytki`, то есть второй URL той
 * же страницы.
 *
 * @throws Error если значение пустое или не является «схема + хост».
 */
export function resolveSiteOrigin(env: SharedEnv = currentEnv()): string {
  const raw = env[SITE_URL_ENV_KEY]?.trim() ?? '';
  if (raw === '') {
    throw new Error(
      `${SITE_URL_ENV_KEY} не задан. Значения по умолчанию у хоста нет и быть не может: ` +
        'ни локального, ни тестового, ни синтетического (CLAUDE.md, правила URL). ' +
        'Хост подставленный вместо ошибки означал бы canonical и sitemap на чужом хосте, ' +
        'а это необратимо после индексации. Задайте параметр в .env.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalidValue(raw, 'значение не разбирается как абсолютный адрес.');
  }

  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    throw invalidValue(raw, `допустимы только схемы ${ALLOWED_PROTOCOLS.join(' и ')}.`);
  }
  if (parsed.hostname === '') {
    throw invalidValue(raw, 'в значении нет хоста.');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw invalidValue(raw, 'логин и пароль в адресе сайта недопустимы.');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw invalidValue(raw, 'параметры запроса и фрагмент в адресе сайта недопустимы.');
  }
  if (parsed.pathname.replace(/\/+$/, '') !== '') {
    throw invalidValue(
      raw,
      'базовый путь недопустим — сайт живёт в корне хоста, иначе пути записей перестали бы ' +
        'совпадать с реестром зарезервированных маршрутов.',
    );
  }

  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Абсолютный URL страницы или файла.
 *
 * Путь склеивается по правилу слеша из `./routes.ts`: у маршрута страницы
 * завершающего слеша нет (решение Ч-21), URL файла остаётся как есть. Ведущий
 * слеш необязателен — ключи объектов из `packages/images` приходят без него.
 * Главная даёт `<origin>/`.
 *
 * @throws Error если `SITE_URL` не задан или некорректен; если во входе
 *   параметры/фрагмент; если вместо пути дали абсолютный URL (второй хост в
 *   абсолютный URL попасть не должен даже случайно).
 */
export function buildAbsoluteUrl(path: string, env: SharedEnv = currentEnv()): string {
  const origin = resolveSiteOrigin(env);

  if (looksLikeAbsoluteUrl(path)) {
    throw new Error(
      `Ожидается путь, а не абсолютный URL: «${path}». Хост берётся только из ` +
        `${SITE_URL_ENV_KEY}, второй хост в канонический URL попасть не должен.`,
    );
  }

  return `${origin}${canonicalizePath(path)}`;
}
