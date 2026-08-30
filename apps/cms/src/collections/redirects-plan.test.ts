/**
 * Планировщик редиректов (задача Э1-06) — ядро защиты URL.
 *
 * Три обязательных случая из плана: петля `A→A` отклоняется, дубль `from`
 * отклоняется, цепочка `A→B→C` схлопывается в `A→C` с предупреждением. К ним
 * добавлены случаи, без которых защита неполна: замыкание цепочки в петлю,
 * схлопывание в 410 и транзитивное схлопывание.
 *
 * Тестируется чистая функция: она получает уже прочитанные записи и не знает о
 * базе. Хук коллекции только читает существующие редиректы, зовёт её и
 * применяет результат — поэтому правило одинаково работает в админке, REST и
 * GraphQL.
 *
 * Окружение передаётся АРГУМЕНТОМ (задача Э4-06): планировщику нужен реестр
 * зарезервированных маршрутов, а путь админки в реестре вычисляется из
 * `PAYLOAD_ADMIN_PATH`. Читать `process.env` из теста нельзя — тесты начали бы
 * влиять друг на друга, и нестандартное значение было бы нечем проверить.
 */
import { describe, expect, it } from 'vitest';

import {
  RedirectRuleError,
  type RedirectInput,
  type RedirectPlan,
  type RedirectRecord,
  normalizeRedirectPath,
  planRedirect,
  validateRedirectFrom,
} from './redirects-plan';

/** Штатный путь админки: значение из `.env.example`. */
const ADMIN_ENV = { PAYLOAD_ADMIN_PATH: '/admin' } as const;

/** Нестандартный путь админки: он обязан участвовать в проверке наравне со штатным. */
const CUSTOM_ADMIN_ENV = { PAYLOAD_ADMIN_PATH: '/upravlenie-sajtom' } as const;

/** Вызов планировщика со штатным окружением: env в каждом тесте — шум. */
function plan(input: {
  readonly candidate: RedirectInput;
  readonly existing: readonly RedirectRecord[];
}): RedirectPlan {
  return planRedirect({ ...input, env: ADMIN_ENV });
}

/** Отказ планировщика с ожидаемым машинным признаком. */
function refusalOf(run: () => unknown): RedirectRuleError {
  try {
    run();
  } catch (error) {
    if (error instanceof RedirectRuleError) {
      return error;
    }
    throw error;
  }
  throw new Error('ожидался отказ, но операция прошла');
}

const existingRedirect = (
  id: number,
  from: string,
  to: string | null,
  code: '301' | '410' = '301',
): RedirectRecord => ({ id, from, to, code });

describe('normalizeRedirectPath', () => {
  it('приводит путь к канонической форме', () => {
    expect(normalizeRedirectPath('/otkrytki/staraya/')).toBe('/otkrytki/staraya');
    expect(normalizeRedirectPath('otkrytki//novaya')).toBe('/otkrytki/novaya');
  });

  it('отклоняет абсолютный URL: редирект внутри сайта задаётся путём', () => {
    expect(() => normalizeRedirectPath('https://otkritka.test/otkrytki/x')).toThrow(
      RedirectRuleError,
    );
  });

  it('отклоняет протокольно-относительный адрес: это другой хост', () => {
    // «//host/path» не содержит схемы и проходит проверку на абсолютный URL, а
    // схлопывание слешей превратило бы чужой хост в первый сегмент пути.
    expect(() => normalizeRedirectPath('//otkritka.test/otkrytki/x')).toThrow(RedirectRuleError);
  });

  it('отклоняет параметры, фрагмент и пустое значение', () => {
    expect(() => normalizeRedirectPath('/otkrytki/x?utm=1')).toThrow(RedirectRuleError);
    expect(() => normalizeRedirectPath('/otkrytki/x#top')).toThrow(RedirectRuleError);
    expect(() => normalizeRedirectPath('   ')).toThrow(RedirectRuleError);
  });
});

describe('Э1-06: петля A→A', () => {
  it('отклоняется', () => {
    expect(() =>
      plan({
        candidate: { from: '/otkrytki/a', to: '/otkrytki/a', code: '301' },
        existing: [],
      }),
    ).toThrow(RedirectRuleError);
  });

  it('отклоняется и после нормализации хвостового слеша', () => {
    // Иначе «/a/» → «/a» выглядит как разные пути и создаёт бесконечный редирект.
    try {
      plan({
        candidate: { from: '/otkrytki/a/', to: '/otkrytki/a', code: '301' },
        existing: [],
      });
      throw new Error('ожидался отказ');
    } catch (error) {
      expect(error).toBeInstanceOf(RedirectRuleError);
      expect((error as RedirectRuleError).rule).toBe('loop');
    }
  });
});

describe('Э1-06: дубль from', () => {
  it('отклоняется', () => {
    try {
      plan({
        candidate: { from: '/otkrytki/a', to: '/otkrytki/c', code: '301' },
        existing: [existingRedirect(1, '/otkrytki/a', '/otkrytki/b')],
      });
      throw new Error('ожидался отказ');
    } catch (error) {
      expect(error).toBeInstanceOf(RedirectRuleError);
      expect((error as RedirectRuleError).rule).toBe('duplicate-from');
    }
  });

  it('дублем не считается правка той же записи', () => {
    const result = plan({
      candidate: { id: 1, from: '/otkrytki/a', to: '/otkrytki/c', code: '301' },
      existing: [existingRedirect(1, '/otkrytki/a', '/otkrytki/b')],
    });
    expect(result.redirect).toEqual({ from: '/otkrytki/a', to: '/otkrytki/c', code: '301' });
    expect(result.rewrites).toHaveLength(0);
  });

  it('дублем считается и путь, отличающийся только хвостовым слешем', () => {
    expect(() =>
      plan({
        candidate: { from: '/otkrytki/a/', to: '/otkrytki/c', code: '301' },
        existing: [existingRedirect(1, '/otkrytki/a', '/otkrytki/b')],
      }),
    ).toThrow(RedirectRuleError);
  });
});

describe('Э1-06: цепочка A→B→C схлопывается в A→C', () => {
  it('новый редирект B→C переписывает существующий A→B в A→C, с предупреждением', () => {
    const result = plan({
      candidate: { from: '/otkrytki/b', to: '/otkrytki/c', code: '301' },
      existing: [existingRedirect(1, '/otkrytki/a', '/otkrytki/b')],
    });

    expect(result.redirect).toEqual({ from: '/otkrytki/b', to: '/otkrytki/c', code: '301' });
    expect(result.rewrites).toHaveLength(1);
    expect(result.rewrites[0]).toMatchObject({
      id: 1,
      from: '/otkrytki/a',
      previousTo: '/otkrytki/b',
      to: '/otkrytki/c',
      code: '301',
    });
    expect(typeof result.rewrites[0]?.reason).toBe('string');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('/otkrytki/a');
  });

  it('новый редирект A→B, где B уже ведёт на C, сразу становится A→C', () => {
    const result = plan({
      candidate: { from: '/otkrytki/a', to: '/otkrytki/b', code: '301' },
      existing: [existingRedirect(1, '/otkrytki/b', '/otkrytki/c')],
    });

    expect(result.redirect).toEqual({ from: '/otkrytki/a', to: '/otkrytki/c', code: '301' });
    expect(result.rewrites).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
  });

  it('схлопывание транзитивно: и X→A, и Y→X получают конечную цель', () => {
    const result = plan({
      candidate: { from: '/otkrytki/a', to: '/otkrytki/c', code: '301' },
      existing: [
        existingRedirect(1, '/otkrytki/x', '/otkrytki/a'),
        existingRedirect(2, '/otkrytki/y', '/otkrytki/x'),
      ],
    });

    expect(result.redirect.to).toBe('/otkrytki/c');
    expect(result.rewrites.map((rewrite) => [rewrite.from, rewrite.to])).toEqual([
      ['/otkrytki/x', '/otkrytki/c'],
      ['/otkrytki/y', '/otkrytki/c'],
    ]);
  });

  it('цепочка, ведущая на удалённый URL, схлопывается в 410', () => {
    const result = plan({
      candidate: { from: '/otkrytki/b', to: null, code: '410' },
      existing: [existingRedirect(1, '/otkrytki/a', '/otkrytki/b')],
    });

    expect(result.redirect).toEqual({ from: '/otkrytki/b', to: null, code: '410' });
    expect(result.rewrites).toHaveLength(1);
    expect(result.rewrites[0]).toMatchObject({
      id: 1,
      from: '/otkrytki/a',
      previousTo: '/otkrytki/b',
      to: null,
      code: '410',
    });
  });
});

describe('Э1-06: цепочка, замыкающаяся в петлю', () => {
  it('B→A при существующем A→B отклоняется', () => {
    try {
      plan({
        candidate: { from: '/otkrytki/b', to: '/otkrytki/a', code: '301' },
        existing: [existingRedirect(1, '/otkrytki/a', '/otkrytki/b')],
      });
      throw new Error('ожидался отказ');
    } catch (error) {
      expect(error).toBeInstanceOf(RedirectRuleError);
      expect((error as RedirectRuleError).rule).toBe('cycle');
    }
  });

  it('схлопывание, которое дало бы X→X, отклоняется', () => {
    // existing: X→A. Новый A→X замкнул бы X на себя после схлопывания.
    try {
      plan({
        candidate: { from: '/otkrytki/a', to: '/otkrytki/x', code: '301' },
        existing: [existingRedirect(1, '/otkrytki/x', '/otkrytki/a')],
      });
      throw new Error('ожидался отказ');
    } catch (error) {
      expect(error).toBeInstanceOf(RedirectRuleError);
      expect((error as RedirectRuleError).rule).toBe('cycle');
    }
  });
});

describe('Э1-06: соответствие кода и цели', () => {
  it('301 без цели отклоняется', () => {
    try {
      plan({ candidate: { from: '/otkrytki/a', to: null, code: '301' }, existing: [] });
      throw new Error('ожидался отказ');
    } catch (error) {
      expect((error as RedirectRuleError).rule).toBe('missing-target');
    }
  });

  it('410 с целью отклоняется', () => {
    try {
      plan({
        candidate: { from: '/otkrytki/a', to: '/otkrytki/b', code: '410' },
        existing: [],
      });
      throw new Error('ожидался отказ');
    } catch (error) {
      expect((error as RedirectRuleError).rule).toBe('unexpected-target');
    }
  });

  it('неизвестный код отклоняется (302 и 307 в модели не существуют)', () => {
    expect(() =>
      plan({
        candidate: { from: '/otkrytki/a', to: '/otkrytki/b', code: '302' },
        existing: [],
      }),
    ).toThrow(RedirectRuleError);
  });
});

/**
 * Э4-06: источник редиректа не может быть маршрутом, который сайт обслуживает
 * сам.
 *
 * Находка Э4-01/Э4-02: правило с `from = /`, `/search` или `/o-proekte`
 * создавалось без возражений, а нейтрализовал его уже рантайм middleware —
 * игнорировал и писал в лог. Место неверное: 301 с адреса живой страницы делает
 * её недостижимой, и причина не видна ни в шаблоне, ни в записи, а только в
 * логе, куда никто не смотрит. Отказ обязан произойти при сохранении — то есть
 * одинаково в админке, REST и GraphQL.
 *
 * Граница правила — та же, что у реестра, и она НЕ шире:
 *   - «занят целиком» и «контейнер» запрещены НА САМОМ пути;
 *   - пути ПОД контейнером (`/otkrytki/...`, `/podborki/...`) разрешены: это
 *     обычные адреса записей, и без редиректа с них перенос карточки был бы
 *     невозможен;
 *   - на поле `to` правило не распространяется вовсе: цель редиректа обязана
 *     быть достижимой, а служебная страница и каталог достижимы.
 */
describe('Э4-06: from не может быть зарезервированным маршрутом', () => {
  it('контейнер отклоняется: редирект увёл бы с каталога', () => {
    for (const container of ['/', '/otkrytki', '/podborki']) {
      const refusal = refusalOf(() =>
        plan({ candidate: { from: container, to: '/otkrytki/zamena', code: '301' }, existing: [] }),
      );
      expect(refusal.rule, container).toBe('reserved-from');
      expect(refusal.message, container).toContain(container);
    }
  });

  it('занятый целиком маршрут отклоняется — и сам, и путь под ним', () => {
    for (const occupied of [
      '/search',
      '/search/istoriya',
      '/account',
      '/o-proekte',
      '/usloviya',
      '/kontakty',
      '/generator/preview',
      '/pozdravleniya',
      '/media/kartinka.webp',
      '/robots.txt',
      '/sitemap.xml',
      '/sitemap',
    ]) {
      const refusal = refusalOf(() =>
        plan({ candidate: { from: occupied, to: '/otkrytki/zamena', code: '301' }, existing: [] }),
      );
      expect(refusal.rule, occupied).toBe('reserved-from');
    }
  });

  it('410 с зарезервированного пути отклоняется так же, как 301', () => {
    // Иначе живую страницу можно было бы «удалить» правилом 410 — тот же вред,
    // только без нового адреса.
    const refusal = refusalOf(() =>
      plan({ candidate: { from: '/o-proekte', to: null, code: '410' }, existing: [] }),
    );
    expect(refusal.rule).toBe('reserved-from');
  });

  it('сегмент пагинации в источнике отклоняется: страницы /page/N отдаёт сайт', () => {
    const refusal = refusalOf(() =>
      plan({
        candidate: { from: '/podborki/prazdniki/8-marta/page/2', to: '/otkrytki/x', code: '301' },
        existing: [],
      }),
    );
    expect(refusal.rule).toBe('reserved-from');
  });

  it('хвостовой слеш и повторные слеши не обходят проверку', () => {
    // «//search» здесь не проверяется намеренно: это протокольно-относительный
    // адрес, и его отклоняет более раннее правило (`invalid-path`) — чужой хост
    // вместо пути. Проверять надо маскировку ПУТИ, а не адреса.
    for (const disguised of ['/search/', '/generator//preview', '/otkrytki/']) {
      expect(
        refusalOf(() =>
          plan({
            candidate: { from: disguised, to: '/otkrytki/zamena', code: '301' },
            existing: [],
          }),
        ).rule,
        disguised,
      ).toBe('reserved-from');
    }
  });

  it('путь админки вычисляется, а не записан строкой: нестандартное значение тоже закрыто', () => {
    // При нестандартном PAYLOAD_ADMIN_PATH закрыт именно он, а прежний штатный
    // `/admin` маршрутом быть перестаёт — реестр не знает его строкой.
    expect(
      refusalOf(() =>
        planRedirect({
          candidate: { from: '/upravlenie-sajtom', to: '/otkrytki/zamena', code: '301' },
          env: CUSTOM_ADMIN_ENV,
          existing: [],
        }),
      ).rule,
    ).toBe('reserved-from');

    expect(
      refusalOf(() =>
        planRedirect({
          candidate: {
            from: '/upravlenie-sajtom/collections',
            to: '/otkrytki/zamena',
            code: '301',
          },
          env: CUSTOM_ADMIN_ENV,
          existing: [],
        }),
      ).rule,
    ).toBe('reserved-from');

    expect(
      refusalOf(() =>
        plan({ candidate: { from: '/admin', to: '/otkrytki/zamena', code: '301' }, existing: [] }),
      ).rule,
    ).toBe('reserved-from');

    const free = planRedirect({
      candidate: { from: '/admin', to: '/otkrytki/zamena', code: '301' },
      env: CUSTOM_ADMIN_ENV,
      existing: [],
    });
    expect(free.redirect.from).toBe('/admin');
  });

  it('незаданный PAYLOAD_ADMIN_PATH даёт отказ по конфигурации, а не запись без проверки', () => {
    // Подставить дефолт нельзя: редирект занял бы путь реальной админки. И это
    // не 500 — отказ обязан дойти до редактора текстом с именем параметра.
    const refusal = refusalOf(() =>
      planRedirect({
        candidate: { from: '/otkrytki/staraya', to: '/otkrytki/novaya', code: '301' },
        env: {},
        existing: [],
      }),
    );
    expect(refusal.rule).toBe('registry-unavailable');
    expect(refusal.message).toContain('PAYLOAD_ADMIN_PATH');
  });
});

describe('Э4-06: что осталось разрешено', () => {
  it('пути ПОД контейнером — обычные адреса записей, перенос с них законен', () => {
    for (const from of [
      '/otkrytki/staraya-otkrytka',
      '/podborki/prazdniki',
      '/podborki/prazdniki/8-marta',
      '/podborki/prazdniki/8-marta/mame',
    ]) {
      const result = plan({
        candidate: { from, to: '/otkrytki/novaya-otkrytka', code: '301' },
        existing: [],
      });
      expect(result.redirect.from, from).toBe(from);
    }
  });

  it('цель редиректа на зарезервированном пути допустима: правило только про источник', () => {
    // Перенос на каталог, на служебную страницу и на главную — законные решения
    // человека. Запрет здесь сделал бы часть переносов невыполнимой.
    for (const to of ['/otkrytki', '/podborki', '/o-proekte', '/']) {
      const result = plan({
        candidate: { from: '/otkrytki/staraya-otkrytka', to, code: '301' },
        existing: [],
      });
      expect(result.redirect.to, to).toBe(to);
    }
  });

  it('схлопывание цепочки не спотыкается о зарезервированную цель', () => {
    const result = plan({
      candidate: { from: '/otkrytki/a', to: '/otkrytki/b', code: '301' },
      existing: [existingRedirect(1, '/otkrytki/b', '/o-proekte')],
    });
    expect(result.redirect).toEqual({ code: '301', from: '/otkrytki/a', to: '/o-proekte' });
  });
});

describe('Э4-06: та же формулировка отказа для поля админки', () => {
  it('validateRedirectFrom возвращает текст отказа, а не бросает исключение', () => {
    const refusal = validateRedirectFrom('/search', ADMIN_ENV);
    expect(typeof refusal).toBe('string');
    expect(String(refusal)).toContain('/search');
  });

  it('validateRedirectFrom пропускает адрес записи', () => {
    expect(validateRedirectFrom('/otkrytki/staraya-otkrytka', ADMIN_ENV)).toBe(true);
  });

  it('validateRedirectFrom сообщает текстом и о негодной конфигурации, и о негодном пути', () => {
    expect(String(validateRedirectFrom('/otkrytki/x', {}))).toContain('PAYLOAD_ADMIN_PATH');
    expect(String(validateRedirectFrom('https://otkritka.test/x', ADMIN_ENV))).toContain(
      'SITE_URL',
    );
    expect(String(validateRedirectFrom('', ADMIN_ENV))).toContain('путь');
  });
});
