/**
 * Матрица HTTP-статусов как ОДИН проверяемый объект (задача Э4-06).
 *
 * Норма: `CLAUDE.md`, раздел «HTTP-статусы» — таблица «Ситуация → Ответ», два
 * запрета рядом с ней, и «Правила индексации» в части «пустая или слабая
 * страница не отдаёт 200 как полноценная посадочная».
 *
 * Здесь проверяется не поведение сервера — оно проверялось по строкам и раньше
 * (Э3-11, Э4-02, Э3-13), — а САМА матрица:
 *
 *   1. её состав совпадает с таблицей в `CLAUDE.md` дословно и построчно.
 *      Строка, добавленная в документ, роняет этот тест до того, как окажется
 *      непроверенной;
 *   2. у каждой строки есть ссылка на существующую проверку: файл открывается,
 *      якорь в нём ищется дословно. Удалённая или переименованная проверка видна
 *      так же, как отсутствующая;
 *   3. правила строк исполняются здесь же на чистых решениях — таблице
 *      редиректов, режиме обслуживания и телах 410 и 503, — а не только на живом
 *      сервере.
 *
 * Имена `it(...)` в этом файле являются ЯКОРЯМИ ссылок из матрицы. Переименование
 * теста без правки матрицы роняет пункт 2 — это и требовалось.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  GONE_STATUS,
  type RedirectRule,
  resolveRedirect,
} from '../../apps/web/src/routing/redirects.js';
import { GONE_PAGE_HTML } from '../../apps/web/src/server/gone-page.js';
import {
  HTTP_STATUS_MATRIX,
  httpStatusRow,
  liveRowsFor,
  statusViolations,
} from '../../apps/web/src/server/http-status-matrix.js';
import {
  MAINTENANCE_HTML,
  maintenanceMode,
} from '../../apps/web/src/server/maintenance.js';

const REPO_ROOT = new URL('../../', import.meta.url);

/**
 * Читает файл репозитория с приведением переводов строки.
 *
 * Нормализация обязательна: рабочие копии на Windows держат файлы в CRLF, и
 * разбор таблицы по `\n` на них молча не находил бы раздел — то есть проверка
 * зависела бы от настроек git у того, кто её запускает.
 */
function readRepoFile(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, REPO_ROOT)), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
}

const CLAUDE_MD = readRepoFile('CLAUDE.md');

/** Экранирует якорь: имя проверки ищется как текст, а не как выражение. */
function escapeForRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
}

/**
 * Есть ли в файле ПРОВЕРКА с таким именем.
 *
 * Ищется вызов `record(`, `it(` или `test(`, у которого имя начинается с якоря
 * (начинается, а не совпадает: имена смоуков и приёмки часто собираются
 * шаблонной строкой с адресом внутри).
 *
 * Строка, стоящая в комментарии, проверкой не считается — ни в строчном `//`,
 * ни в docstring `*`. До правки по вердикту `reviewer` от 2026-08-28 якорь
 * искался по всему файлу, и удовлетворить замок могла строка, уцелевшая в
 * комментарии после удаления самой проверки: ссылка становилась фикцией ровно в
 * том сценарии, ради которого она существует.
 */
function hasCheckNamed(source: string, anchor: string): boolean {
  const call = new RegExp(`(?:record|it|test)\\(\\s*['"\`]${escapeForRegExp(anchor)}`, 'gu');

  for (const match of source.matchAll(call)) {
    const lineStart = source.lastIndexOf('\n', match.index) + 1;
    const beforeOnLine = source.slice(lineStart, match.index).trimStart();
    if (!beforeOnLine.startsWith('//') && !beforeOnLine.startsWith('*')) {
      return true;
    }
  }
  return false;
}

/** Строки таблицы «Ситуация → Ответ» из раздела «HTTP-статусы» самого CLAUDE.md. */
function tableFromNorm(): readonly (readonly [string, string])[] {
  const section = /\n## HTTP-статусы\n([\s\S]*?)\n## /.exec(CLAUDE_MD)?.[1];
  if (section === undefined) {
    throw new Error(
      'В CLAUDE.md не найден раздел «## HTTP-статусы». Матрица собрана по нему, поэтому ' +
        'пропажа раздела — это не повод пропустить проверку, а повод остановиться.',
    );
  }

  return section
    .split('\n')
    .filter((line) => line.trimStart().startsWith('|'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter(
      (cells) =>
        cells.length === 2 &&
        cells[0] !== 'Ситуация' &&
        !/^-+$/.test(cells[0] ?? '') &&
        cells[0] !== undefined,
    )
    .map((cells) => [cells[0] ?? '', cells[1] ?? ''] as const);
}

describe('состав матрицы сверяется с таблицей CLAUDE.md', () => {
  it('строки таблицы и строки матрицы совпадают дословно и по порядку', () => {
    const norm = tableFromNorm();
    expect(norm.length).toBeGreaterThan(0);

    const declared = HTTP_STATUS_MATRIX.filter((row) => row.kind === 'table-row').map(
      (row) => [row.situation, row.answer] as const,
    );

    // Сравнение в обе стороны одним равенством: строка, добавленная в документ и
    // не добавленная в матрицу, и строка, придуманная в матрице, дают одну и ту
    // же ошибку — «перечень разошёлся с нормой».
    expect(declared).toEqual(norm.map((cells) => [cells[0], cells[1]]));
  });

  it('запреты процитированы из CLAUDE.md дословно', () => {
    const prohibitions = HTTP_STATUS_MATRIX.filter((row) => row.kind === 'prohibition');
    expect(prohibitions.length).toBeGreaterThan(0);

    for (const row of prohibitions) {
      expect(typeof row.quote, row.id).toBe('string');
      // Цитата ищется в документе целиком: пересказ «своими словами» здесь
      // означал бы, что матрица описывает не норму, а чьё-то её понимание.
      expect(CLAUDE_MD.includes(row.quote ?? ''), `${row.id}: ${String(row.quote)}`).toBe(true);
    }
  });

  it('ожидаемые статусы не расходятся с текстом ответа', () => {
    for (const row of HTTP_STATUS_MATRIX) {
      expect(row.statuses.length, row.id).toBeGreaterThan(0);
      for (const status of row.statuses) {
        // Число, которого нет в тексте нормы, — это уже не та строка.
        expect(row.answer.includes(String(status)), `${row.id}: ${row.answer}`).toBe(true);
      }
    }
  });

  it('заголовки требуются ровно там, где этого требует ответ', () => {
    for (const row of HTTP_STATUS_MATRIX) {
      const isRedirect = row.statuses.every((status) => status >= 300 && status < 400);
      // `Location` обязателен у переходов и запрещён у всего остального. Это
      // структурное правило, а не свойство отдельной строки: 200, 404, 410 и 503
      // с `Location` часть клиентов трактует как переход.
      expect(row.location, row.id).toBe(isRedirect ? 'required' : 'forbidden');
      expect(row.retryAfter, row.id).toBe(
        row.answer.includes('Retry-After') ? 'required' : 'forbidden',
      );
      expect(row.maxHops, row.id).toBe(isRedirect ? 1 : 0);
    }
  });
});

describe('строка без проверки заметна: ссылки машинные', () => {
  it('у каждой строки есть ссылка, и файл по ссылке содержит названную проверку', () => {
    for (const row of HTTP_STATUS_MATRIX) {
      expect(row.coverage.length, `${row.id}: строка без единой проверки`).toBeGreaterThan(0);

      for (const entry of row.coverage) {
        const source = readRepoFile(entry.file);
        expect(
          hasCheckNamed(source, entry.anchor),
          `${row.id}: в ${entry.file} нет проверки «${entry.anchor}»`,
        ).toBe(true);
      }
    }
  });

  it('якорь ищется ВНУТРИ вызова проверки, а не где угодно в файле', () => {
    // Ровно тот сценарий, от которого замок и защищает: проверку удалили, а
    // строка уцелела в комментарии — и поиск по всему файлу удовлетворялся ею.
    const source = [
      '// Раньше здесь была проверка «удалённая строка».',
      "//    record('закомментированная строка', true);",
      " *    it('строка из docstring', () => {});",
      "record('живая проверка смоука', ok);",
      "  it('живая проверка юнит-теста', () => {});",
      '  test(`живая проверка приёмки: ${page.path}`, async () => {});',
    ].join('\n');

    expect(hasCheckNamed(source, 'живая проверка смоука')).toBe(true);
    expect(hasCheckNamed(source, 'живая проверка юнит-теста')).toBe(true);
    expect(hasCheckNamed(source, 'живая проверка приёмки')).toBe(true);

    expect(hasCheckNamed(source, 'удалённая строка')).toBe(false);
    expect(hasCheckNamed(source, 'закомментированная строка')).toBe(false);
    expect(hasCheckNamed(source, 'строка из docstring')).toBe(false);
  });

  it('у каждой строки есть проверка, которую исполняет pnpm verify', () => {
    // Смоуки в `verify` не входят: им нужна наполненная база и они запускаются
    // руками. Строка, проверенная ТОЛЬКО смоуком, при зелёном шлюзе не проверена
    // ничем — а матрица при этом рапортует полное покрытие.
    for (const row of HTTP_STATUS_MATRIX) {
      const blocking = row.coverage.filter(
        (entry) => entry.kind === 'unit' || entry.kind === 'acceptance',
      );

      expect(
        blocking.length,
        `${row.id}: только смоуки (${row.coverage.map((entry) => entry.kind).join(', ')}), ` +
          'то есть блокирующий шлюз строку не исполняет',
      ).toBeGreaterThan(0);
    }
  });

  it('приёмочные ссылки ведут в tests/seo, а не куда попало', () => {
    // Приёмка — зона `seo-auditor`; матрица на неё ссылается и её не правит.
    // Ссылка на файл вне `tests/seo/` означала бы, что вид проверки указан
    // неверно, и правило «исполняется шлюзом» перестало бы быть правдой.
    const acceptance = HTTP_STATUS_MATRIX.flatMap((row) =>
      row.coverage.filter((entry) => entry.kind === 'acceptance'),
    );
    expect(acceptance.length).toBeGreaterThan(0);

    for (const entry of acceptance) {
      expect(entry.file.startsWith('tests/seo/'), entry.file).toBe(true);
      expect(entry.file.endsWith('.spec.ts'), entry.file).toBe(true);
    }
  });

  it('каждый смоук с живыми строками сверяет свой список с матрицей', () => {
    const files = [
      ...new Set(
        HTTP_STATUS_MATRIX.flatMap((row) =>
          row.coverage.filter((entry) => entry.kind === 'live').map((entry) => entry.file),
        ),
      ),
    ];
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const smoke = readRepoFile(file);
      const assigned = liveRowsFor(file);
      expect(assigned.length, file).toBeGreaterThan(0);

      // Вторая половина замка. Первая (якорь существует) проверена выше; здесь —
      // что смоук СВЕРЯЕТ свой список с матрицей в конце прогона и отрабатывает
      // каждую поручённую строку по идентификатору. Без этого строка, добавленная
      // в матрицу, оставалась бы непроверенной на живом сервере.
      expect(smoke, file).toContain('createStatusMatrixHarness');
      expect(smoke, file).toContain('assertAllRowsExercised');
      for (const row of assigned) {
        expect(smoke.includes(`'${row.id}'`), `${file} не отрабатывает строку ${row.id}`).toBe(
          true,
        );
      }
    }
  });

  it('неизвестный идентификатор строки — ошибка, а не молчание', () => {
    expect(() => httpStatusRow('takoy-stroki-net' as never)).toThrow(/матрице HTTP-статусов/);
  });
});

describe('правила строк исполняются, а не описываются', () => {
  const lookup =
    (table: Readonly<Record<string, RedirectRule>>) =>
    (path: string): Promise<RedirectRule | null> =>
      Promise.resolve(table[path] ?? null);

  const env = { PAYLOAD_ADMIN_PATH: '/admin' };

  it('перенос: один переход на конечный адрес', async () => {
    const decision = await resolveRedirect({
      env,
      lookup: lookup({
        '/otkrytki/staraya': { code: '301', from: '/otkrytki/staraya', to: '/otkrytki/novaya' },
      }),
      pathname: '/otkrytki/staraya',
    });

    expect(decision.action).toBe('redirect');
    if (decision.action !== 'redirect') return;

    expect(
      statusViolations(httpStatusRow('moved-301'), {
        hops: decision.hops,
        location: decision.location,
        status: decision.status,
      }),
    ).toEqual([]);
  });

  it('удалено без замены: 410 с навигацией', async () => {
    const decision = await resolveRedirect({
      env,
      lookup: lookup({
        '/otkrytki/udalennaya': { code: '410', from: '/otkrytki/udalennaya', to: null },
      }),
      pathname: '/otkrytki/udalennaya',
    });

    expect(decision.action).toBe('gone');
    if (decision.action !== 'gone') return;
    expect(decision.status).toBe(GONE_STATUS);

    // Тело берётся то же, что отдаёт middleware: у ответа 410 источник один.
    expect(
      statusViolations(httpStatusRow('deleted-gone'), {
        body: GONE_PAGE_HTML,
        status: decision.status,
      }),
    ).toEqual([]);
  });

  it('удалено с заменой: 301 на названный адрес', async () => {
    const decision = await resolveRedirect({
      env,
      lookup: lookup({
        '/otkrytki/zamenennaya': {
          code: '301',
          from: '/otkrytki/zamenennaya',
          to: '/otkrytki/zamena',
        },
      }),
      pathname: '/otkrytki/zamenennaya',
    });

    expect(decision.action).toBe('redirect');
    if (decision.action !== 'redirect') return;

    expect(
      statusViolations(httpStatusRow('replaced-301'), {
        hops: decision.hops,
        location: decision.location,
        status: decision.status,
      }),
    ).toEqual([]);
  });

  it('правило 301 без цели не подставляет главную', async () => {
    const decision = await resolveRedirect({
      env,
      lookup: lookup({
        '/otkrytki/bez-tseli': { code: '301', from: '/otkrytki/bez-tseli', to: '   ' },
      }),
      pathname: '/otkrytki/bez-tseli',
    });

    // Правильного ответа из такого правила не следует, поэтому его нет вовсе:
    // адрес отвечает так, как будто правила нет. Подстановка главной здесь и
    // была бы тем самым массовым редиректом, который запрещает п. 23.
    expect(decision.action).toBe('broken');
    if (decision.action !== 'broken') return;
    expect(decision.reason).toContain('главную');

    // И контрольный выстрел по самой проверке: 301 на главную строку матрицы не
    // проходит, даже будучи одиночным и с заголовком.
    expect(
      statusViolations(httpStatusRow('no-blanket-home-redirect'), {
        hops: 1,
        location: '/',
        status: 301,
      }),
    ).toHaveLength(1);
  });

  it('сервис недоступен: 503 с Retry-After', () => {
    const decision = maintenanceMode({ MAINTENANCE_MODE: 'on' });

    expect(decision.action).toBe('unavailable');
    if (decision.action !== 'unavailable') return;

    expect(
      statusViolations(httpStatusRow('service-unavailable-503'), {
        body: MAINTENANCE_HTML,
        retryAfter: decision.retryAfterSeconds,
        status: decision.status,
      }),
    ).toEqual([]);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe('проверка строки ловит нарушение, а не подтверждает ожидаемое', () => {
  it('Location там, где его быть не должно, — нарушение на каждой такой строке', () => {
    for (const row of HTTP_STATUS_MATRIX.filter((entry) => entry.location === 'forbidden')) {
      const violations = statusViolations(row, {
        body: row.bodyMustContain.join(' '),
        location: '/',
        retryAfter: row.retryAfter === 'required' ? 300 : undefined,
        status: row.statuses[0] ?? 0,
      });
      expect(violations.join(' '), row.id).toContain('Location');
    }
  });

  it('перечисляет ВСЕ нарушения ответа, а не первое', () => {
    // 503 без Retry-After, с Location и с чужим статусом: администратор обязан
    // увидеть все три причины сразу, иначе он будет чинить их по одной.
    const violations = statusViolations(httpStatusRow('service-unavailable-503'), {
      body: MAINTENANCE_HTML,
      location: '/',
      status: 200,
    });
    expect(violations.length).toBe(3);
  });

  it('лишний переход на переносе — нарушение', () => {
    const violations = statusViolations(httpStatusRow('moved-301'), {
      hops: 2,
      location: '/otkrytki/novaya',
      status: 301,
    });
    expect(violations.join(' ')).toContain('цепочки редиректов запрещены');
  });

  it('тело без навигации не проходит строку 410', () => {
    const violations = statusViolations(httpStatusRow('deleted-gone'), {
      body: '<!doctype html><h1>Удалено</h1>',
      status: 410,
    });
    expect(violations.length).toBeGreaterThan(0);
  });

  it('непредъявленное тело не считается пройденной проверкой', () => {
    const violations = statusViolations(httpStatusRow('deleted-gone'), { status: 410 });
    expect(violations.join(' ')).toContain('тело ответа не предъявлено');
  });
});
