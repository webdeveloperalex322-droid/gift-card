/**
 * Реестр зарезервированных маршрутов — единственный машинный источник.
 *
 * Норма — `CLAUDE.md`, раздел «Правила URL», пункт «Зарезервированные
 * маршруты». Проверка выполняется по ИТОГОВОМУ пути записи, а не по «уровню»
 * slug, и состоит ровно из трёх правил:
 *
 *   1. сегмент `page` запрещён на любой позиции — иначе запись сталкивается с
 *      пагинацией `/page/N`;
 *   2. каждая запись реестра помечена видом, и вид определяет проверку. Плоский
 *      список строк без пометки — ошибка реализации: «занят целиком» и
 *      «контейнер» проверяются по-разному, и склеивание их в один список либо
 *      закрыло бы весь каталог, либо пустило бы запись на служебный маршрут:
 *        - `occupied` (занят целиком): запрещено и совпадение, и любой путь под
 *          ним. `/search/istoriya` отклоняется;
 *        - `container`: запрещено только совпадение (собственная запись с таким
 *          путём), пути под ним — норма, это и есть место для записей;
 *   3. корневые сегменты реестра резервируются дополнительно по имени сегмента
 *      на первом уровне: slug `sitemap` даёт `/sitemap`, который формально не
 *      совпадает ни с чем, но путается с `/sitemap.xml`.
 *
 * Для файловых маршрутов резервируется имя БЕЗ расширения: заняты и
 * `/sitemap.xml`, и `/sitemap`.
 *
 * Пути хранятся в канонической форме БЕЗ завершающего слеша (решение Ч-21).
 * Форма директив `Disallow` из реестра НЕ выводится: она задана решением Ч-22 и
 * относится к генерации robots.txt (там же решено, что путь админки в robots.txt
 * не публикуется вовсе). Поэтому запись реестра — это путь, вид и причина, и
 * ничего про robots.
 *
 * Путь админки попадает в реестр ВЫЧИСЛЕННЫМ из `PAYLOAD_ADMIN_PATH`, а не
 * записанным строкой: при нестандартном значении подборка с таким slug иначе
 * заняла бы тот же путь, что админка, и коллизию заметил бы уже пользователь.
 *
 * Спор двух записей на одном пути разводится по видам записи, и это два РАЗНЫХ
 * случая (находка ревизии от 2026-08-22):
 *   - ЯВНАЯ против ПРОИЗВОДНОЙ (корневой сегмент, имя без расширения): побеждает
 *     явная. Иначе производный резерв корневого сегмента превратил бы контейнер
 *     `/otkrytki` в «занят целиком» и закрыл бы весь каталог;
 *   - ЯВНАЯ против ЯВНОЙ (путь админки совпал с записью реестра или поглотил
 *     её): не решается приоритетом вовсе — реестр отказывается собираться. При
 *     прежнем правиле «первая запись побеждает» путь админки, равный
 *     контейнеру, оставался «контейнером», и весь его подмаршрут считался
 *     свободным: запись CMS занимала адрес внутри админки, а проверка отвечала
 *     «можно». Админка не делит пространство путей с записями.
 *
 * Чего реестр НЕ решает (граница ответственности, зафиксирована намеренно):
 * группирующие узлы таксономии (`/podborki/prazdniki`, решения Ч-04-5 и Ч-04-9)
 * — это ДАННЫЕ, а не маршруты, поэтому реестр не знает ни одного из них и
 * коллизию двух узлов на одном пути не видит. Её закрывает уникальность
 * сохранённого пути подборки (уникальный индекс БД на `path`, Э1-05) и
 * уникальность slug карточки (Э1-09). Между коллекциями коллизии нет
 * структурно: пространства имён разведены решением от 2026-08-22 —
 * `/otkrytki/<slug>` для карточек, `/podborki/...` для подборок, — и это два
 * РАЗНЫХ контейнера реестра.
 */

import { currentEnv, type SharedEnv } from './env.js';
import { canonicalizePath, pathSegments } from './routes.js';
import { isValidSlug } from './slug.js';

/** Сегмент пагинации. Запрещён на любой позиции пути записи (правило 1). */
export const PAGINATION_SEGMENT = 'page';

/** Имя переменной окружения с путём админки Payload. */
export const PAYLOAD_ADMIN_PATH_ENV_KEY = 'PAYLOAD_ADMIN_PATH';

/**
 * Вид записи реестра. Вид определяет проверку — см. правило 2 в шапке модуля.
 */
export type ReservedRouteKind = 'container' | 'occupied';

/**
 * Откуда запись взялась. Нужен для диагностики: «занят целиком» по реестру и
 * «занят как корневой сегмент» — разные поводы, и редактору полезно видеть, что
 * именно конфликтует.
 */
export type ReservedRouteSource = 'registry' | 'extensionless' | 'root-segment';

export interface ReservedRoute {
  /** Путь в канонической форме: с ведущим слешем, без завершающего. */
  readonly path: string;
  readonly kind: ReservedRouteKind;
  readonly source: ReservedRouteSource;
  /** Зачем зарезервирован — попадает в текст ошибки. */
  readonly reason: string;
}

/** Правило, по которому путь отклонён. */
export type ReservedRule = 'pagination-segment' | 'occupied-path' | 'container-path';

export type PathAvailability =
  | { readonly available: true }
  | {
      readonly available: false;
      readonly rule: ReservedRule;
      /** Конкретный маршрут (или сегмент) из-за которого путь отклонён. */
      readonly conflict: string;
      readonly reason: string;
    };

interface RegistryEntry {
  readonly path: string;
  readonly kind: ReservedRouteKind;
  readonly reason: string;
}

/**
 * Стартовое наполнение реестра. Перенесено из `CLAUDE.md` ОДИН раз: дальше
 * правится только здесь, остальные документы ссылаются, а не копируют.
 *
 * Путь админки в этом списке отсутствует намеренно — он вычисляется из
 * окружения, см. {@link resolveAdminRoute}.
 */
const STATIC_REGISTRY: readonly RegistryEntry[] = [
  {
    path: '/',
    kind: 'container',
    reason: 'главная страница сайта',
  },
  {
    path: '/otkrytki',
    kind: 'container',
    reason: 'каталог открыток: под ним живут карточки и подборки',
  },
  {
    path: '/podborki',
    kind: 'container',
    reason: 'раздел подборок: под ним живут подборки',
  },
  {
    path: '/search',
    kind: 'occupied',
    reason: 'внутренний поиск: noindex и вне sitemap на всей глубине',
  },
  {
    path: '/account',
    kind: 'occupied',
    reason: 'личный кабинет: noindex и вне sitemap на всей глубине',
  },
  {
    path: '/o-proekte',
    kind: 'occupied',
    reason: 'информационная страница: статический маршрут Astro, не запись CMS',
  },
  {
    path: '/usloviya',
    kind: 'occupied',
    reason: 'информационная страница: статический маршрут Astro, не запись CMS',
  },
  {
    path: '/kontakty',
    kind: 'occupied',
    reason: 'информационная страница: статический маршрут Astro, не запись CMS',
  },
  {
    path: '/generator/preview',
    kind: 'occupied',
    reason: 'страницы генерации и превью: noindex и вне sitemap',
  },
  {
    path: '/pozdravleniya',
    kind: 'occupied',
    reason:
      'резерв под этап 2 развития: резерв в реестре не разрешает создавать страницу, ' +
      'запрет по Ч-20 остаётся в силе',
  },
  {
    path: '/media',
    kind: 'occupied',
    reason:
      'публичный префикс производных изображений (решение Ч-03): по нему отдаются файлы, ' +
      'а не страницы, поэтому путь закрыт целиком — маршрут появится на этапе 3',
  },
  {
    path: '/robots.txt',
    kind: 'occupied',
    reason: 'файловый маршрут robots',
  },
  {
    path: '/sitemap.xml',
    kind: 'occupied',
    reason: 'sitemap-индекс',
  },
  {
    path: '/sitemap-sections.xml',
    kind: 'occupied',
    reason: 'sitemap разделов и подборок',
  },
  {
    path: '/sitemap-cards.xml',
    kind: 'occupied',
    reason: 'sitemap карточек',
  },
  {
    path: '/sitemap-images.xml',
    kind: 'occupied',
    reason: 'image sitemap',
  },
];

function stripExtension(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  const lastDot = path.lastIndexOf('.');
  if (lastDot <= lastSlash + 1) {
    return path;
  }
  return path.slice(0, lastDot);
}

/**
 * Разбирает значение `PAYLOAD_ADMIN_PATH` — ЕДИНСТВЕННЫЙ разбор этого параметра
 * в монорепозитории.
 *
 * Почему функция экспортируется из общего пакета, а не живёт внутри реестра:
 * из одного значения выводятся ДВА адреса одного и того же — путь, по которому
 * админку обслуживает Next (`apps/cms/src/env.mjs`, он же попадает в
 * `routes.admin` и в правила rewrite), и запись резерва в этом реестре. Разбор
 * был написан дважды, и правила успели разойтись: сегмент пагинации отклоняла
 * только копия из `env.mjs` (находка ревизии от 2026-08-22). Расхождение здесь
 * означает, что CMS обслуживает один путь, а зарезервирован другой, — то есть
 * запись CMS может занять адрес админки, и заметит это пользователь.
 *
 * Значения по умолчанию нет намеренно: дефолт означал бы, что при нестандартном
 * значении реальный путь админки в резерв не попал, а в резерве оказался путь,
 * которого не существует.
 *
 * Ведущий и хвостовой слеш нормализуются здесь, а не в `.env`: это забота кода
 * (то же правило, что у `SITE_URL`).
 *
 * @throws Error с именем переменной в тексте — на пустом и на негодном значении.
 */
export function parseAdminPath(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim();

  if (trimmed === '') {
    throw new Error(
      `${PAYLOAD_ADMIN_PATH_ENV_KEY} не задан, поэтому путь админки неизвестен: его нельзя ` +
        'ни обслужить, ни внести в реестр зарезервированных маршрутов. Значения по ' +
        'умолчанию у него нет намеренно — при нестандартном пути дефолт зарезервировал бы ' +
        'не тот путь, и запись CMS заняла бы адрес админки (CLAUDE.md, правила URL). ' +
        'Заполните .env по шаблону .env.example.',
    );
  }

  const reject = (reason: string): never => {
    throw new Error(
      `${PAYLOAD_ADMIN_PATH_ENV_KEY} задан некорректно: «${trimmed}» — ${reason}. ` +
        'Ожидается путь из сегментов [a-z0-9-], например один сегмент верхнего уровня. ' +
        'Тихая нормализация здесь недопустима: это значение задаёт и адрес админки, и его ' +
        'запись в реестре зарезервированных маршрутов.',
    );
  };

  if (trimmed.includes('?') || trimmed.includes('#')) {
    reject('путь не может содержать параметров и фрагмента');
  }

  const segments = trimmed.split('/').filter((segment) => segment !== '');

  if (segments.length === 0) {
    reject('админка не может занимать корень сайта');
  }

  for (const segment of segments) {
    if (segment === PAGINATION_SEGMENT) {
      reject(
        `сегмент «${PAGINATION_SEGMENT}» зарезервирован под пагинацию /${PAGINATION_SEGMENT}/N`,
      );
    }
    if (!isValidSlug(segment)) {
      reject(`сегмент «${segment}» не проходит правила slug`);
    }
  }

  return `/${segments.join('/')}`;
}

/** Запись реестра для пути админки. Разбор — {@link parseAdminPath}. */
function resolveAdminRoute(env: SharedEnv): RegistryEntry {
  return {
    path: parseAdminPath(env[PAYLOAD_ADMIN_PATH_ENV_KEY]),
    kind: 'occupied',
    reason: `путь админки Payload из ${PAYLOAD_ADMIN_PATH_ENV_KEY}`,
  };
}

/**
 * Проверяет, что путь админки не спорит с ЯВНОЙ записью реестра.
 *
 * Спор явной записи с явной записью приоритетом не решается: правильного исхода
 * нет ни одного, поэтому реестр отказывается собираться.
 *
 *   - совпадение с контейнером (`PAYLOAD_ADMIN_PATH` равен пути каталога):
 *     контейнер ОБЯЗАН принимать записи, а путь админки не может принять ни
 *     одной. Прежнее правило «первая запись по пути побеждает» оставляло вид
 *     `container`, и весь подмаршрут админки считался свободным — запись CMS
 *     занимала адрес внутри админки, причём проверка отвечала «можно»;
 *   - совпадение с занятым целиком маршрутом: два разных обработчика на одном
 *     пути;
 *   - поглощение служебного маршрута (`PAYLOAD_ADMIN_PATH` — родитель записи
 *     реестра): роутер админки забирает префикс целиком, и служебный маршрут
 *     перестаёт существовать.
 *
 * Это НЕ распространяется на производные записи (корневой сегмент, имя без
 * расширения): они держат от имени записи CMS, а не админку, страницы по таким
 * путям сайт не отдаёт, и поглощать там нечего. Там явная запись побеждает
 * производную — см. {@link reservedRoutes}.
 */
function assertAdminRouteFree(admin: RegistryEntry): void {
  const clash = STATIC_REGISTRY.find(
    (entry) => entry.path === admin.path || entry.path.startsWith(`${admin.path}/`),
  );
  if (clash === undefined) {
    return;
  }

  const why =
    clash.path === admin.path
      ? clash.kind === 'container'
        ? 'контейнер обязан принимать записи, а путь админки не может принять ни одной: ' +
          'разрешить этот спор приоритетом значит либо закрыть весь каталог, либо тихо ' +
          'пустить запись на подмаршрут админки'
        : 'на одном пути оказались два разных обработчика'
      : 'служебный маршрут оказался бы ПОД админкой: её роутер забирает префикс целиком';

  throw new Error(
    `${PAYLOAD_ADMIN_PATH_ENV_KEY} задан как «${admin.path}», но этот путь спорит с ` +
      `зарезервированным маршрутом «${clash.path}» (${clash.reason}): ${why}. ` +
      'Это ошибка конфигурации, а не режим работы, поэтому реестр зарезервированных ' +
      `маршрутов не собирается. Задайте ${PAYLOAD_ADMIN_PATH_ENV_KEY} путём, которого в ` +
      'реестре нет, — например отдельным сегментом верхнего уровня.',
  );
}

/**
 * Полный реестр: явные записи + производные по правилам 3 и «имя без
 * расширения».
 *
 * Явных записей на одном пути быть не может: спор пути админки с наполнением
 * реестра отсекает {@link assertAdminRouteFree} до сборки. Поэтому порядок
 * вставки решает только спор ЯВНОЙ записи с ПРОИЗВОДНОЙ: явные кладутся
 * первыми, и вид контейнера побеждает производный резерв корневого сегмента.
 * Иначе `/otkrytki`, чей корневой сегмент совпадает с самим контейнером,
 * оказался бы «занят целиком», и весь каталог перестал бы принимать записи.
 *
 * Производный резерв корневого сегмента — всегда `occupied`: под именем,
 * которое путается со служебным маршрутом, не должно жить ничего, и это
 * единственное толкование правила 3, которое его не обесценивает.
 */
export function reservedRoutes(env: SharedEnv = currentEnv()): readonly ReservedRoute[] {
  const admin = resolveAdminRoute(env);
  assertAdminRouteFree(admin);
  const entries: readonly RegistryEntry[] = [...STATIC_REGISTRY, admin];
  const routes = new Map<string, ReservedRoute>();

  const put = (route: ReservedRoute): void => {
    if (!routes.has(route.path)) {
      routes.set(route.path, route);
    }
  };

  for (const entry of entries) {
    put({ path: entry.path, kind: entry.kind, source: 'registry', reason: entry.reason });
  }

  for (const entry of entries) {
    const withoutExtension = stripExtension(entry.path);
    if (withoutExtension !== entry.path && withoutExtension !== '') {
      put({
        path: withoutExtension,
        kind: 'occupied',
        source: 'extensionless',
        reason: `имя файлового маршрута «${entry.path}» без расширения: путается с ним`,
      });
    }
  }

  for (const entry of entries) {
    const [firstSegment] = pathSegments(entry.path);
    if (firstSegment === undefined) {
      continue;
    }
    const rootPath = stripExtension(`/${firstSegment}`);
    put({
      path: rootPath,
      kind: 'occupied',
      source: 'root-segment',
      reason: `корневой сегмент зарезервированного маршрута «${entry.path}»`,
    });
  }

  return [...routes.values()];
}

function unavailable(rule: ReservedRule, conflict: string, reason: string): PathAvailability {
  return { available: false, rule, conflict, reason };
}

/**
 * Проверяет ИТОГОВЫЙ путь записи по трём правилам реестра.
 *
 * Форма сегментов здесь не проверяется — это `isValidSlug`. Завершающий слеш и
 * повторные слеши на входе нормализуются: проверять надо тот путь, который
 * запись реально займёт.
 *
 * @throws Error если `PAYLOAD_ADMIN_PATH` не задан или некорректен, а также если
 *   на вход дали не путь (параметры, фрагмент).
 */
export function checkReservedPath(
  path: string,
  env: SharedEnv = currentEnv(),
): PathAvailability {
  const routes = reservedRoutes(env);
  const target = canonicalizePath(path);
  const segments = pathSegments(target);

  if (segments.includes(PAGINATION_SEGMENT)) {
    return unavailable(
      'pagination-segment',
      PAGINATION_SEGMENT,
      `сегмент «${PAGINATION_SEGMENT}» запрещён на любой позиции пути: он занят пагинацией ` +
        `/${PAGINATION_SEGMENT}/N`,
    );
  }

  const exact = routes.find((route) => route.path === target);
  if (exact !== undefined) {
    return unavailable(
      exact.kind === 'container' ? 'container-path' : 'occupied-path',
      exact.path,
      exact.kind === 'container'
        ? `путь совпадает с контейнером «${exact.path}» (${exact.reason}); записи живут под ним, ` +
          'а не на его месте'
        : `путь занят целиком: «${exact.path}» — ${exact.reason}`,
    );
  }

  const parents = routes
    .filter(
      (route) =>
        route.kind === 'occupied' && route.path !== '/' && target.startsWith(`${route.path}/`),
    )
    .sort((left, right) => right.path.length - left.path.length);

  const parent = parents[0];
  if (parent !== undefined) {
    return unavailable(
      'occupied-path',
      parent.path,
      `путь лежит под занятым целиком маршрутом «${parent.path}» — ${parent.reason}`,
    );
  }

  return { available: true };
}

/** Короткая форма {@link checkReservedPath} для условий. */
export function isReservedPath(path: string, env: SharedEnv = currentEnv()): boolean {
  return !checkReservedPath(path, env).available;
}

/**
 * Бросает исключение, если путь зарезервирован. Форма для хуков Payload: в
 * админке и через REST/GraphQL сообщение одно и то же, потому что правило одно.
 */
export function assertPathNotReserved(path: string, env: SharedEnv = currentEnv()): void {
  const result = checkReservedPath(path, env);
  if (result.available) {
    return;
  }
  throw new Error(
    `Путь «${canonicalizePath(path)}» недоступен (правило ${result.rule}): ${result.reason}.`,
  );
}
