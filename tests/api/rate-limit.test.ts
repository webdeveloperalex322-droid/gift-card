/**
 * Э6-03 — ограничение частоты запросов на API-ключ (ТЗ §9, решение Ч-14) на
 * живых маршрутах.
 *
 * ЧТО ДОКАЗЫВАЕТСЯ ЗДЕСЬ, ЧЕГО НЕ ДОКАЖЕТ ЮНИТ-ТЕСТ. Алгоритм бакета и разбор
 * параметров проверены чистыми тестами рядом с кодом
 * (`apps/cms/src/http/*.test.ts`). Они остаются зелёными и в том случае, если
 * обёртку забыли навесить на маршрут, — а именно проводка и есть предмет задачи:
 * ограничение, не стоящее на пути внешнего клиента, не ограничивает ничего.
 * Поэтому каждое утверждение ниже — это ЗАПРОС по тому же пути, которым ходит
 * AI-редактор, и КАЖДЫЙ из трёх файлов маршрутов под `src/app/(payload)/api`
 * проверяется отдельно: REST, GraphQL и GraphQL Playground. Третий попал сюда не
 * ради полноты списка — его обработчик аутентифицирует предъявленный ключ
 * запросом к Postgres прежде, чем решить, отдавать ли страницу, поэтому вход,
 * оставленный без обёртки, был бы дырой в квоте Ч-14, спрятанной за ответом,
 * который никто не разглядывает.
 *
 * ПОЧЕМУ ЗНАЧЕНИЯ ПЕРЕОПРЕДЕЛЯЮТСЯ. Утверждённый всплеск — 120 запросов
 * (Ч-14). Набор, выбирающий его честно, стоил бы 121 запроса к базе на каждый
 * сценарий и минут прогона. Поэтому предел на время теста сужается через ТЕ ЖЕ
 * переменные окружения, которыми он настраивается в бою: заодно это и есть
 * доказательство требования «лимит настраивается» — при значениях из кода ни
 * один сценарий ниже не покраснел бы.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  RATE_LIMIT_BURST_ENV_KEY,
  RATE_LIMIT_QUOTA_ENV_KEY,
  RATE_LIMIT_WINDOW_ENV_KEY,
  apiKeyFingerprint,
  resetApiRateLimit,
} from '../../apps/cms/src/http/api-rate-limit';
import { requireEnv } from '../../apps/cms/src/env.mjs';
import {
  ANONYMOUS,
  type ApiActor,
  type TestUser,
  createUserWithKey,
  getTestPayload,
  graphqlHttp,
  graphqlNames,
  openSession,
  playgroundHttp,
  removeUsers,
  restRaw,
  stamp,
} from '../../apps/cms/src/testing/api-harness';

const RUN = stamp();

let aiEditor: TestUser;
let admin: TestUser;
/** Cookie сессии администратора — та же, с которой работает браузер админки. */
let adminCookie: string;

const ENV_KEYS = [
  RATE_LIMIT_BURST_ENV_KEY,
  RATE_LIMIT_QUOTA_ENV_KEY,
  RATE_LIMIT_WINDOW_ENV_KEY,
] as const;
const savedEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]] as const),
);

/**
 * Сужает предел и сбрасывает счётчики.
 *
 * Сброс обязателен: параметры читаются один раз при первом запросе, и без него
 * тест проверял бы конфигурацию, сложившуюся до него.
 */
function tighten(args: { readonly burst: number; readonly quota: number; readonly windowSeconds?: number }): void {
  process.env[RATE_LIMIT_QUOTA_ENV_KEY] = String(args.quota);
  process.env[RATE_LIMIT_BURST_ENV_KEY] = String(args.burst);
  process.env[RATE_LIMIT_WINDOW_ENV_KEY] = String(args.windowSeconds ?? 60);
  resetApiRateLimit();
}

/** Самый дешёвый запрос, который всё же проходит весь путь: «кто я». */
async function ping(actor: ApiActor): Promise<Response> {
  return restRaw({ actor, method: 'GET', segments: ['users', 'me'] });
}

/** Тот же запрос, но сессией-cookie: так ходит человек в админке. */
async function pingWithCookie(): Promise<Response> {
  return restRaw({
    actor: ANONYMOUS,
    headers: { Cookie: adminCookie },
    method: 'GET',
    segments: ['users', 'me'],
  });
}

/**
 * Простейшая выборка через GraphQL — второй транспорт того же API.
 *
 * Имя поля выборки берётся из `graphqlNames`, а не пишется строкой: неверное имя
 * дало бы ошибку разбора документа, ответ 200 с `errors`, и сценарий про 429
 * остался бы зелёным, ничего не спрашивая у Payload.
 */
async function pingGraphql(actor: ApiActor): Promise<Response> {
  const { plural } = graphqlNames('cards');
  return graphqlHttp({ actor, query: `{ ${plural}(limit: 1) { totalDocs } }` });
}

beforeAll(async () => {
  await getTestPayload();
  aiEditor = await createUserWithKey({
    email: `e603-ai-${RUN}@otkritka.test`,
    label: 'ai-editor',
    role: 'ai-editor',
  });
  admin = await createUserWithKey({
    email: `e603-admin-${RUN}@otkritka.test`,
    label: 'admin',
    role: 'admin',
  });

  // Настоящий вход по паролю: без живой сессии нечем доказать, что ограничение
  // считает ключи, а не людей.
  adminCookie = await openSession(admin);
});

beforeEach(() => {
  resetApiRateLimit();
});

afterAll(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  // Счётчики сбрасываются вместе с окружением: суженный предел, оставшийся в
  // памяти процесса, ронял бы следующие файлы набора на чужом правиле.
  resetApiRateLimit();
  await removeUsers([aiEditor.id, admin.id]);
});

describe('Э6-03: отпечаток ключа', () => {
  it('совпадает с тем, что Payload положил в users.apiKeyIndex', async () => {
    const payload = await getTestPayload();
    // `showHiddenFields` обязателен: Payload объявляет `apiKeyIndex` скрытым
    // полем и вырезает его из любого ответа, включая Local API.
    const stored = await payload.findByID({
      collection: 'users',
      id: aiEditor.id,
      overrideAccess: true,
      showHiddenFields: true,
    });
    const expected = apiKeyFingerprint(aiEditor.apiKey, requireEnv('PAYLOAD_SECRET'));

    // Ключ бакета вычисляется по той же формуле, по которой Payload находит
    // владельца ключа. Совпадение проверяется с ФАКТИЧЕСКИМ значением из базы, а
    // не с повторением формулы: формула воспроизведена из чужого кода, и
    // разойтись она может только молча.
    expect(stored.apiKeyIndex).toBe(expected);
    expect(stored.apiKeyIndex).not.toBe(aiEditor.apiKey);
  });
});

describe('Э6-03: превышение предела', () => {
  it('REST: запрос сверх всплеска получает 429 с Retry-After', async () => {
    tighten({ burst: 3, quota: 2 });

    for (let request = 0; request < 3; request += 1) {
      const response = await ping(aiEditor);
      expect(response.status, `запрос №${String(request + 1)} в пределах всплеска`).toBe(200);
    }

    const denied = await ping(aiEditor);
    expect(denied.status).toBe(429);

    const retryAfter = denied.headers.get('Retry-After');
    expect(retryAfter).not.toBeNull();
    expect(retryAfter).toMatch(/^\d+$/);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
  });

  it('отклонённая мутация НЕ доходит до Payload: записи в базе не появляется', async () => {
    tighten({ burst: 1, quota: 1 });
    const slug = `e603-otklonennaya-${RUN}`;

    expect((await ping(aiEditor)).status).toBe(200);

    const denied = await restRaw({
      actor: aiEditor,
      body: {
        metaDescription: `Э6-03: описание отклонённой попытки ${RUN}`,
        robots: 'noindex,follow',
        slug,
        status: 'draft',
        title: `Э6-03: отклонённая по частоте ${RUN}`,
      },
      method: 'POST',
      segments: ['cards'],
    });
    expect(denied.status).toBe(429);

    // Код ответа сам по себе ничего не доказывает: отказ мог бы прийти и после
    // записи. Состояние базы читается правами системы.
    const payload = await getTestPayload();
    const found = await payload.find({
      collection: 'cards',
      overrideAccess: true,
      where: { slug: { equals: slug } },
    });
    expect(found.totalDocs).toBe(0);
  });

  it('GraphQL: тот же отказ на втором транспорте', async () => {
    tighten({ burst: 2, quota: 2 });

    const first = await pingGraphql(aiEditor);
    expect(first.status).toBe(200);
    // Ответ разобран: без этого «200» получал бы и запрос, отклонённый разбором
    // документа, — то есть тот, который до Payload не дошёл.
    const body = (await first.json()) as { data?: Record<string, unknown> | null; errors?: unknown[] };
    expect(body.errors ?? []).toEqual([]);
    expect(body.data?.[graphqlNames('cards').plural]).toBeDefined();

    expect((await pingGraphql(aiEditor)).status).toBe(200);

    const denied = await pingGraphql(aiEditor);
    expect(denied.status).toBe(429);
    expect(denied.headers.get('Retry-After')).toMatch(/^\d+$/);
  });

  it('GraphQL Playground: третий вход считается так же, как остальные', async () => {
    tighten({ burst: 2, quota: 2 });

    // Песочница выглядит страницей, но её обработчик начинается с
    // `createPayloadRequest` → `executeAuthStrategies`: предъявленный ключ ищется
    // в Postgres ДО решения о том, отдавать страницу или 404. Вход, который
    // стоит запроса к базе, обязан считаться независимо от того, чем он
    // отвечает.
    const first = await playgroundHttp(aiEditor);
    expect(first.status).not.toBe(429);
    expect((await playgroundHttp(aiEditor)).status).not.toBe(429);

    const denied = await playgroundHttp(aiEditor);
    expect(denied.status).toBe(429);
    expect(denied.headers.get('Retry-After')).toMatch(/^\d+$/);
  });

  it('счёт общий для ВСЕХ ТРЁХ маршрутов: смена транспорта предела не обходит', async () => {
    tighten({ burst: 3, quota: 3 });

    // Всплеск выбирается тремя запросами по трём РАЗНЫМ маршрутам одним и тем же
    // ключом. Если бы счётчик заводился на маршрут, а не на отпечаток ключа, ни
    // один из них не израсходовал бы чужую квоту и четвёртый запрос прошёл бы.
    expect((await ping(aiEditor)).status).toBe(200);
    expect((await pingGraphql(aiEditor)).status).toBe(200);
    expect((await playgroundHttp(aiEditor)).status).not.toBe(429);

    // Дальше отклоняется любой из трёх — бакет один.
    expect((await ping(aiEditor)).status).toBe(429);
    expect((await pingGraphql(aiEditor)).status).toBe(429);
    expect((await playgroundHttp(aiEditor)).status).toBe(429);
  });

  it('предел считается НА КЛЮЧ: соседний аккаунт не задет', async () => {
    tighten({ burst: 1, quota: 1 });

    expect((await ping(aiEditor)).status).toBe(200);
    expect((await ping(aiEditor)).status).toBe(429);

    // Ключ администратора — другой бакет. Иначе один шумный клиент выключал бы
    // API для всех остальных.
    expect((await ping(admin)).status).toBe(200);
  });
});

describe('Э6-03: границы применения', () => {
  it('сессия-cookie НЕ троттлится, а ключ в тех же условиях троттлится', async () => {
    tighten({ burst: 1, quota: 1 });

    // Десять запросов подряд при пределе в один — человек в админке работает
    // как обычно. Это выбор, а не побочный эффект: Ч-14 задаёт предел «на ключ»,
    // а один экран админки делает десятки запросов, и общий счётчик означал бы,
    // что администратор блокирует сам себя обычной работой.
    for (let request = 0; request < 10; request += 1) {
      const response = await pingWithCookie();
      expect(response.status, `запрос сессией №${String(request + 1)}`).toBe(200);
    }

    // Контроль в тех же условиях и в том же состоянии счётчиков: по ключу предел
    // действует. Без этой половины «не троттлится» доказывалось бы и выключенным
    // ограничением.
    expect((await ping(aiEditor)).status).toBe(200);
    expect((await ping(aiEditor)).status).toBe(429);
  });

  it('аноним без ключа под ограничение не попадает (отказ у него другой — по правам)', async () => {
    tighten({ burst: 1, quota: 1 });

    for (let request = 0; request < 5; request += 1) {
      const response = await restRaw({ actor: ANONYMOUS, method: 'GET', segments: ['users', 'me'] });
      // `users/me` анониму отвечает 200 с `user: null` — важно здесь другое: ни
      // один из пяти запросов не получил 429.
      expect(response.status).not.toBe(429);
    }
  });
});

describe('Э6-03: предел настраивается', () => {
  it('число пропущенных запросов меняется вместе со значением в окружении', async () => {
    tighten({ burst: 5, quota: 5 });
    for (let request = 0; request < 5; request += 1) {
      expect((await ping(aiEditor)).status).toBe(200);
    }
    expect((await ping(aiEditor)).status).toBe(429);

    // То же самое при другом значении: предел приходит из окружения, а не из
    // константы в коде — иначе оба прогона дали бы одно и то же число.
    tighten({ burst: 2, quota: 2 });
    for (let request = 0; request < 2; request += 1) {
      expect((await ping(aiEditor)).status).toBe(200);
    }
    expect((await ping(aiEditor)).status).toBe(429);
  });

  it('Retry-After считается по окну и квоте, а не подставляется числом', async () => {
    // Две квоты по 20 с — один токен раз в десять секунд.
    tighten({ burst: 2, quota: 2, windowSeconds: 20 });
    for (let request = 0; request < 2; request += 1) {
      expect((await ping(aiEditor)).status).toBe(200);
    }
    expect((await ping(aiEditor)).headers.get('Retry-After')).toBe('10');

    // Та же квота, окно короче в десять раз — токен раз в секунду. Значение
    // заголовка меняется вместе с окном, то есть считается, а не задано.
    tighten({ burst: 2, quota: 2, windowSeconds: 2 });
    for (let request = 0; request < 2; request += 1) {
      expect((await ping(aiEditor)).status).toBe(200);
    }
    expect((await ping(aiEditor)).headers.get('Retry-After')).toBe('1');
  });
});
