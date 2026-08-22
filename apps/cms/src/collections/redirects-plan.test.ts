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
 */
import { describe, expect, it } from 'vitest';

import {
  RedirectRuleError,
  normalizeRedirectPath,
  planRedirect,
  type RedirectRecord,
} from './redirects-plan';

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
      planRedirect({
        candidate: { from: '/otkrytki/a', to: '/otkrytki/a', code: '301' },
        existing: [],
      }),
    ).toThrow(RedirectRuleError);
  });

  it('отклоняется и после нормализации хвостового слеша', () => {
    // Иначе «/a/» → «/a» выглядит как разные пути и создаёт бесконечный редирект.
    try {
      planRedirect({
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
      planRedirect({
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
    const plan = planRedirect({
      candidate: { id: 1, from: '/otkrytki/a', to: '/otkrytki/c', code: '301' },
      existing: [existingRedirect(1, '/otkrytki/a', '/otkrytki/b')],
    });
    expect(plan.redirect).toEqual({ from: '/otkrytki/a', to: '/otkrytki/c', code: '301' });
    expect(plan.rewrites).toHaveLength(0);
  });

  it('дублем считается и путь, отличающийся только хвостовым слешем', () => {
    expect(() =>
      planRedirect({
        candidate: { from: '/otkrytki/a/', to: '/otkrytki/c', code: '301' },
        existing: [existingRedirect(1, '/otkrytki/a', '/otkrytki/b')],
      }),
    ).toThrow(RedirectRuleError);
  });
});

describe('Э1-06: цепочка A→B→C схлопывается в A→C', () => {
  it('новый редирект B→C переписывает существующий A→B в A→C, с предупреждением', () => {
    const plan = planRedirect({
      candidate: { from: '/otkrytki/b', to: '/otkrytki/c', code: '301' },
      existing: [existingRedirect(1, '/otkrytki/a', '/otkrytki/b')],
    });

    expect(plan.redirect).toEqual({ from: '/otkrytki/b', to: '/otkrytki/c', code: '301' });
    expect(plan.rewrites).toHaveLength(1);
    expect(plan.rewrites[0]).toMatchObject({
      id: 1,
      from: '/otkrytki/a',
      previousTo: '/otkrytki/b',
      to: '/otkrytki/c',
      code: '301',
    });
    expect(typeof plan.rewrites[0]?.reason).toBe('string');
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('/otkrytki/a');
  });

  it('новый редирект A→B, где B уже ведёт на C, сразу становится A→C', () => {
    const plan = planRedirect({
      candidate: { from: '/otkrytki/a', to: '/otkrytki/b', code: '301' },
      existing: [existingRedirect(1, '/otkrytki/b', '/otkrytki/c')],
    });

    expect(plan.redirect).toEqual({ from: '/otkrytki/a', to: '/otkrytki/c', code: '301' });
    expect(plan.rewrites).toHaveLength(0);
    expect(plan.warnings).toHaveLength(1);
  });

  it('схлопывание транзитивно: и X→A, и Y→X получают конечную цель', () => {
    const plan = planRedirect({
      candidate: { from: '/otkrytki/a', to: '/otkrytki/c', code: '301' },
      existing: [
        existingRedirect(1, '/otkrytki/x', '/otkrytki/a'),
        existingRedirect(2, '/otkrytki/y', '/otkrytki/x'),
      ],
    });

    expect(plan.redirect.to).toBe('/otkrytki/c');
    expect(plan.rewrites.map((rewrite) => [rewrite.from, rewrite.to])).toEqual([
      ['/otkrytki/x', '/otkrytki/c'],
      ['/otkrytki/y', '/otkrytki/c'],
    ]);
  });

  it('цепочка, ведущая на удалённый URL, схлопывается в 410', () => {
    const plan = planRedirect({
      candidate: { from: '/otkrytki/b', to: null, code: '410' },
      existing: [existingRedirect(1, '/otkrytki/a', '/otkrytki/b')],
    });

    expect(plan.redirect).toEqual({ from: '/otkrytki/b', to: null, code: '410' });
    expect(plan.rewrites).toHaveLength(1);
    expect(plan.rewrites[0]).toMatchObject({
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
      planRedirect({
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
      planRedirect({
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
      planRedirect({ candidate: { from: '/otkrytki/a', to: null, code: '301' }, existing: [] });
      throw new Error('ожидался отказ');
    } catch (error) {
      expect((error as RedirectRuleError).rule).toBe('missing-target');
    }
  });

  it('410 с целью отклоняется', () => {
    try {
      planRedirect({
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
      planRedirect({
        candidate: { from: '/otkrytki/a', to: '/otkrytki/b', code: '302' },
        existing: [],
      }),
    ).toThrow(RedirectRuleError);
  });
});
