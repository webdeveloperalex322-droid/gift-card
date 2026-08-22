/**
 * Статусная модель (задача Э1-08) и блокировка URL (задача Э1-09): чистое ядро.
 *
 * Тесты негативные по преимуществу — это не перекос, а суть задачи: правило
 * «публикует только человек» проверяется не тем, что админ смог опубликовать, а
 * тем, что не смог никто другой и ни одним путём.
 */
import { describe, expect, it } from 'vitest';

import { ROLES } from '../access/roles';
import { DEFAULT_ROBOTS } from '../seo/robots';
import {
  ALLOWED_STATUS_TRANSITIONS,
  CARD_REVIEW_REQUIREMENTS,
  COLLECTION_REVIEW_REQUIREMENTS,
  ContentRuleError,
  MAX_BATCH_SELECTION,
  assertBulkChangeAllowed,
  assertCreateStatus,
  assertIncomingChangeAllowed,
  assertUrlShapeChangeAllowed,
  isFilledContentValue,
  missingReviewFields,
  planStatusTransition,
  readExplicitIdSelection,
  urlShapeChanges,
} from './status-model';

const admin = { id: 1, role: ROLES.admin };
const aiEditor = { id: 2, role: ROLES.aiEditor };

/** Отказ по ТОЙ причине: иначе зелёный негативный тест держится на опечатке. */
function expectRule(run: () => unknown, rule: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ContentRuleError);
    expect((error as ContentRuleError).rule).toBe(rule);
    return;
  }
  throw new Error(`Ожидался отказ с причиной «${rule}», но исключения не было`);
}

describe('создание записи: только draft', () => {
  it('пустой статус — это draft (дефолт коллекции)', () => {
    expect(assertCreateStatus(undefined)).toBe('draft');
    expect(assertCreateStatus(null)).toBe('draft');
    expect(assertCreateStatus('draft')).toBe('draft');
  });

  it('создание сразу в review отклоняется', () => {
    expectRule(() => assertCreateStatus('review'), 'create-not-draft');
  });

  it('создание сразу в published отклоняется', () => {
    expectRule(() => assertCreateStatus('published'), 'create-not-draft');
  });

  it('неизвестный статус отклоняется, а не трактуется как «не published»', () => {
    expectRule(() => assertCreateStatus('Draft'), 'unknown-status');
    expectRule(() => assertCreateStatus(''), 'unknown-status');
  });
});

describe('матрица переходов', () => {
  it('перескок draft → published запрещён: review не обходится', () => {
    expect(ALLOWED_STATUS_TRANSITIONS.draft).toEqual(['review']);
  });

  it('снятие с публикации возможно и в draft, и в review', () => {
    expect([...ALLOWED_STATUS_TRANSITIONS.published]).toEqual(
      expect.arrayContaining(['draft', 'review']),
    );
  });
});

describe('полнота перед review', () => {
  const knownCardFields = new Set(['title', 'alt', 'caption', 'collections', 'image']);

  it('перечень обязательных полей карточки — из ТЗ §8.2', () => {
    expect(CARD_REVIEW_REQUIREMENTS.map((item) => item.field)).toEqual([
      'image',
      'alt',
      'title',
      'collections',
      'caption',
    ]);
  });

  it('перечень обязательных полей подборки — из ТЗ §8.2', () => {
    expect(COLLECTION_REVIEW_REQUIREMENTS.map((item) => item.field)).toEqual([
      'intro',
      'metaDescription',
      'related',
      'responsibleEditor',
    ]);
  });

  it('пустые значения считаются незаполненными', () => {
    expect(isFilledContentValue('')).toBe(false);
    expect(isFilledContentValue('   ')).toBe(false);
    expect(isFilledContentValue(null)).toBe(false);
    expect(isFilledContentValue(undefined)).toBe(false);
    expect(isFilledContentValue([])).toBe(false);
    expect(isFilledContentValue('текст')).toBe(true);
    expect(isFilledContentValue([1])).toBe(true);
    expect(isFilledContentValue(0)).toBe(true);
  });

  it('пустой richText (один пустой абзац) не считается заполненным', () => {
    const empty = { root: { type: 'root', children: [{ type: 'paragraph', children: [] }] } };
    const filled = {
      root: {
        type: 'root',
        children: [{ type: 'paragraph', children: [{ type: 'text', text: 'Вводный текст' }] }],
      },
    };
    expect(isFilledContentValue(empty)).toBe(false);
    expect(isFilledContentValue(filled)).toBe(true);
  });

  it('незаполненные обязательные поля перечисляются все, а не первое', () => {
    const missing = missingReviewFields({
      data: { title: 'Открытка', alt: '', caption: null, collections: [], image: 7 },
      knownFields: knownCardFields,
      requirements: CARD_REVIEW_REQUIREMENTS,
    });
    expect(missing.map((item) => item.field)).toEqual(['alt', 'collections', 'caption']);
  });

  it('требование к полю, которого в коллекции ещё нет, пропускается (image до Э2-04)', () => {
    const missing = missingReviewFields({
      data: { title: 'Открытка', alt: 'Тюльпаны', caption: 'С 8 Марта', collections: [3] },
      knownFields: new Set(['title', 'alt', 'caption', 'collections']),
      requirements: CARD_REVIEW_REQUIREMENTS,
    });
    expect(missing).toEqual([]);
  });

  it('как только поле image появится в схеме, пустое значение закроет переход в review', () => {
    const missing = missingReviewFields({
      data: { title: 'Открытка', alt: 'Тюльпаны', caption: 'С 8 Марта', collections: [3] },
      knownFields: knownCardFields,
      requirements: CARD_REVIEW_REQUIREMENTS,
    });
    expect(missing.map((item) => item.field)).toEqual(['image']);
  });
});

describe('переход draft → review', () => {
  const complete = {
    missingForReview: [],
    previous: { publishedAt: null, robots: DEFAULT_ROBOTS, status: 'draft' },
  } as const;

  it('доступен сервисному аккаунту: агент доводит контент до review', () => {
    const plan = planStatusTransition({
      ...complete,
      next: { robots: DEFAULT_ROBOTS, status: 'review' },
      user: aiEditor,
    });
    expect(plan.status).toBe('review');
    expect(plan.firstPublish).toBe(false);
  });

  it('незаполненные обязательные поля отклоняют переход', () => {
    expectRule(
      () =>
        planStatusTransition({
          missingForReview: [{ field: 'alt', label: 'alt изображения' }],
          next: { robots: DEFAULT_ROBOTS, status: 'review' },
          previous: { publishedAt: null, robots: DEFAULT_ROBOTS, status: 'draft' },
          user: aiEditor,
        }),
      'incomplete-for-review',
    );
  });

  it('текст отказа перечисляет незаполненные поля', () => {
    try {
      planStatusTransition({
        missingForReview: [
          { field: 'alt', label: 'alt изображения' },
          { field: 'caption', label: 'подпись' },
        ],
        next: { robots: DEFAULT_ROBOTS, status: 'review' },
        previous: { publishedAt: null, robots: DEFAULT_ROBOTS, status: 'draft' },
        user: aiEditor,
      });
      throw new Error('ожидался отказ');
    } catch (error) {
      expect((error as Error).message).toContain('alt изображения');
      expect((error as Error).message).toContain('подпись');
    }
  });
});

describe('переход review → published', () => {
  const fromReview = {
    missingForReview: [],
    previous: { publishedAt: null, robots: DEFAULT_ROBOTS, status: 'review' },
  } as const;

  it('администратор публикует, publishedAt ставится первой публикацией', () => {
    const plan = planStatusTransition({
      ...fromReview,
      next: { robots: DEFAULT_ROBOTS, status: 'published' },
      user: admin,
    });
    expect(plan.status).toBe('published');
    expect(plan.firstPublish).toBe(true);
    expect(plan.robots).toBe(DEFAULT_ROBOTS);
  });

  it('повторная публикация не сбрасывает дату первой', () => {
    const plan = planStatusTransition({
      missingForReview: [],
      next: { robots: DEFAULT_ROBOTS, status: 'published' },
      previous: { publishedAt: '2026-01-01T00:00:00.000Z', robots: DEFAULT_ROBOTS, status: 'review' },
      user: admin,
    });
    expect(plan.firstPublish).toBe(false);
  });

  it('сервисный аккаунт ai-editor не публикует', () => {
    expectRule(
      () =>
        planStatusTransition({
          ...fromReview,
          next: { robots: DEFAULT_ROBOTS, status: 'published' },
          user: aiEditor,
        }),
      'publish-requires-admin',
    );
  });

  it('публикация без пользователя (код, расписание, воркер) отклоняется', () => {
    expectRule(
      () =>
        planStatusTransition({
          ...fromReview,
          next: { robots: DEFAULT_ROBOTS, status: 'published' },
          user: null,
        }),
      'publish-requires-admin',
    );
  });

  it('перескок draft → published отклоняется даже у администратора', () => {
    expectRule(
      () =>
        planStatusTransition({
          missingForReview: [],
          next: { robots: DEFAULT_ROBOTS, status: 'published' },
          previous: { publishedAt: null, robots: DEFAULT_ROBOTS, status: 'draft' },
          user: admin,
        }),
      'forbidden-transition',
    );
  });

  it('публикация записи с незаполненными обязательными полями отклоняется', () => {
    expectRule(
      () =>
        planStatusTransition({
          missingForReview: [{ field: 'alt', label: 'alt изображения' }],
          next: { robots: DEFAULT_ROBOTS, status: 'published' },
          previous: { publishedAt: null, robots: DEFAULT_ROBOTS, status: 'review' },
          user: admin,
        }),
      'incomplete-for-review',
    );
  });
});

describe('index,follow — отдельное действие, а не побочный эффект публикации', () => {
  it('публикация с одновременным index,follow отклоняется', () => {
    expectRule(
      () =>
        planStatusTransition({
          missingForReview: [],
          next: { robots: 'index,follow', status: 'published' },
          previous: { publishedAt: null, robots: DEFAULT_ROBOTS, status: 'review' },
          user: admin,
        }),
      'index-not-separate',
    );
  });

  it('вторым действием, без смены статуса, администратор открывает индексацию', () => {
    const plan = planStatusTransition({
      missingForReview: [],
      next: { robots: 'index,follow', status: 'published' },
      previous: {
        publishedAt: '2026-01-01T00:00:00.000Z',
        robots: DEFAULT_ROBOTS,
        status: 'published',
      },
      user: admin,
    });
    expect(plan.robots).toBe('index,follow');
  });

  it('ai-editor не открывает индексацию даже у опубликованной записи', () => {
    expectRule(
      () =>
        planStatusTransition({
          missingForReview: [],
          next: { robots: 'index,follow', status: 'published' },
          previous: {
            publishedAt: '2026-01-01T00:00:00.000Z',
            robots: DEFAULT_ROBOTS,
            status: 'published',
          },
          user: aiEditor,
        }),
      'index-requires-admin',
    );
  });

  it('index,follow у неопубликованной записи отклоняется', () => {
    expectRule(
      () =>
        planStatusTransition({
          missingForReview: [],
          next: { robots: 'index,follow', status: 'review' },
          previous: { publishedAt: null, robots: DEFAULT_ROBOTS, status: 'review' },
          user: admin,
        }),
      'index-requires-published',
    );
  });
});

describe('снятие с публикации: решение 301 или 404 обязательно', () => {
  const published = {
    missingForReview: [],
    previous: {
      publishedAt: '2026-01-01T00:00:00.000Z',
      robots: 'index,follow',
      status: 'published',
    },
  } as const;

  it('без решения о судьбе URL переход вниз отклоняется', () => {
    expectRule(
      () =>
        planStatusTransition({
          ...published,
          next: { robots: 'index,follow', status: 'draft' },
          user: admin,
        }),
      'unpublish-requires-decision',
    );
  });

  it('ai-editor не снимает с публикации', () => {
    expectRule(
      () =>
        planStatusTransition({
          ...published,
          next: {
            robots: 'index,follow',
            status: 'draft',
            withdrawal: { mode: '404', redirectTo: null },
          },
          user: aiEditor,
        }),
      'unpublish-requires-admin',
    );
  });

  it('301 требует пути замены', () => {
    expectRule(
      () =>
        planStatusTransition({
          ...published,
          next: { robots: 'index,follow', status: 'draft', withdrawal: { mode: '301' } },
          user: admin,
        }),
      'unpublish-requires-decision',
    );
  });

  it('решение 301 сохраняется в плане, robots принудительно понижается', () => {
    const plan = planStatusTransition({
      ...published,
      next: {
        robots: 'index,follow',
        status: 'draft',
        withdrawal: { mode: '301', redirectTo: '/otkrytki/novaya' },
      },
      user: admin,
    });
    expect(plan.withdrawn).toEqual({ mode: '301', redirectTo: '/otkrytki/novaya' });
    expect(plan.robots).toBe(DEFAULT_ROBOTS);
    expect(plan.robotsCoerced).toBe(true);
  });

  it('решение 404 (снять без записи в redirects) — допустимый явный выбор', () => {
    const plan = planStatusTransition({
      ...published,
      next: { robots: 'index,follow', status: 'review', withdrawal: { mode: '404' } },
      user: admin,
    });
    expect(plan.withdrawn).toEqual({ mode: '404', redirectTo: null });
  });

  it('410 с указанной целью — противоречие, отклоняется', () => {
    expectRule(
      () =>
        planStatusTransition({
          ...published,
          next: {
            robots: 'index,follow',
            status: 'draft',
            withdrawal: { mode: '410', redirectTo: '/otkrytki/novaya' },
          },
          user: admin,
        }),
      'unpublish-requires-decision',
    );
  });
});

describe('неизменяемость URL после первой публикации (Э1-09)', () => {
  const publishedNode = {
    nodeKind: 'occasion',
    parent: 5,
    publishedAt: '2026-01-01T00:00:00.000Z',
    slug: '8-marta',
    status: 'published',
  };
  const draftNode = { ...publishedNode, publishedAt: null, status: 'draft' };

  it('изменение любого из трёх полей формы URL распознаётся', () => {
    expect(urlShapeChanges(publishedNode, { ...publishedNode, slug: '8-marta-2027' })).toEqual([
      'slug',
    ]);
    expect(urlShapeChanges(publishedNode, { ...publishedNode, parent: 9 })).toEqual(['parent']);
    expect(urlShapeChanges(publishedNode, { ...publishedNode, nodeKind: 'recipient' })).toEqual([
      'nodeKind',
    ]);
  });

  it('связь, отданная документом, а не id, изменением не считается', () => {
    expect(urlShapeChanges(publishedNode, { ...publishedNode, parent: { id: 5 } })).toEqual([]);
  });

  it('до первой публикации slug меняется свободно', () => {
    expect(
      assertUrlShapeChangeAllowed({
        confirmed: false,
        next: { ...draftNode, slug: 'drugoy' },
        previous: draftNode,
        user: aiEditor,
      }),
    ).toEqual(['slug']);
  });

  it('после публикации смена slug без подтверждения 301 отклоняется', () => {
    expectRule(
      () =>
        assertUrlShapeChangeAllowed({
          confirmed: false,
          next: { ...publishedNode, slug: 'drugoy' },
          previous: publishedNode,
          user: admin,
        }),
      'url-locked',
    );
  });

  it('после публикации перенос узла (parent) без подтверждения 301 отклоняется', () => {
    expectRule(
      () =>
        assertUrlShapeChangeAllowed({
          confirmed: false,
          next: { ...publishedNode, parent: 42 },
          previous: publishedNode,
          user: admin,
        }),
      'url-locked',
    );
  });

  it('после публикации смена nodeKind тоже заблокирована', () => {
    expectRule(
      () =>
        assertUrlShapeChangeAllowed({
          confirmed: false,
          next: { ...publishedNode, nodeKind: 'recipient' },
          previous: publishedNode,
          user: admin,
        }),
      'url-locked',
    );
  });

  it('подтверждение от ai-editor не работает: смена URL — операция админа', () => {
    expectRule(
      () =>
        assertUrlShapeChangeAllowed({
          confirmed: true,
          next: { ...publishedNode, slug: 'drugoy' },
          previous: publishedNode,
          user: aiEditor,
        }),
      'url-change-requires-admin',
    );
  });

  it('администратор с подтверждением меняет URL — операция разрешена', () => {
    expect(
      assertUrlShapeChangeAllowed({
        confirmed: true,
        next: { ...publishedNode, slug: 'drugoy' },
        previous: publishedNode,
        user: admin,
      }),
    ).toEqual(['slug']);
  });
});

describe('сырые входные данные: громкий отказ вместо молчаливого срезания поля', () => {
  const storedDraft = { publishedAt: null, robots: DEFAULT_ROBOTS, slug: 'mame', status: 'draft' };
  const storedPublished = {
    publishedAt: '2026-01-01T00:00:00.000Z',
    robots: DEFAULT_ROBOTS,
    slug: 'mame',
    status: 'published',
  };

  it('создание сразу в review отклоняется на входе', () => {
    expectRule(
      () =>
        assertIncomingChangeAllowed({
          incoming: { status: 'review', title: 'Открытка' },
          operation: 'create',
          stored: null,
          user: aiEditor,
        }),
      'create-not-draft',
    );
  });

  it('создание с index,follow отклоняется на входе', () => {
    expectRule(
      () =>
        assertIncomingChangeAllowed({
          incoming: { robots: 'index,follow', title: 'Открытка' },
          operation: 'create',
          stored: null,
          user: admin,
        }),
      'index-requires-published',
    );
  });

  it('попытка ai-editor опубликовать через API получает отказ, а не тихое 200', () => {
    expectRule(
      () =>
        assertIncomingChangeAllowed({
          incoming: { status: 'published' },
          operation: 'update',
          stored: { ...storedDraft, status: 'review' },
          user: aiEditor,
        }),
      'publish-requires-admin',
    );
  });

  it('попытка ai-editor включить index,follow получает отказ', () => {
    expectRule(
      () =>
        assertIncomingChangeAllowed({
          incoming: { robots: 'index,follow' },
          operation: 'update',
          stored: { ...storedPublished, status: 'published' },
          user: aiEditor,
        }),
      'index-requires-admin',
    );
  });

  it('попытка ai-editor сменить slug опубликованной записи получает отказ', () => {
    expectRule(
      () =>
        assertIncomingChangeAllowed({
          incoming: { slug: 'drugoy' },
          operation: 'update',
          stored: storedPublished,
          user: aiEditor,
        }),
      'url-change-requires-admin',
    );
  });

  it('данные без спорных полей проходят: обычная правка контента не трогается', () => {
    expect(() =>
      assertIncomingChangeAllowed({
        incoming: { caption: 'С 8 Марта', slug: 'mame' },
        operation: 'update',
        stored: storedPublished,
        user: aiEditor,
      }),
    ).not.toThrow();
  });
});

describe('пакетная операция (решение Ч-07, точка вето V11)', () => {
  const selection = { id: { in: [1, 2, 3] } };

  it('явная выборка по id распознаётся', () => {
    expect(readExplicitIdSelection(selection)).toEqual([1, 2, 3]);
    expect(readExplicitIdSelection({ id: { equals: 7 } })).toEqual([7]);
    // Так строит запрос сама админка Payload для выбранных строк списка.
    expect(readExplicitIdSelection({ and: [{ id: { in: ['4', '5'] } }] })).toEqual(['4', '5']);
  });

  it('активный фильтр рядом с перечислением id допустим: and только сужает набор', () => {
    expect(
      readExplicitIdSelection({ and: [{ status: { equals: 'review' } }, { id: { in: [1, 2] } }] }),
    ).toEqual([1, 2]);
  });

  it('фильтр по чему-либо, кроме id, выборкой человека не считается', () => {
    expect(readExplicitIdSelection({ status: { equals: 'review' } })).toBeNull();
    expect(readExplicitIdSelection({ id: { not_in: [1] } })).toBeNull();
    // «Выбрать все доступные» админка передаёт именно так.
    expect(readExplicitIdSelection({ and: [{ id: { not_equals: '' } }] })).toBeNull();
    expect(readExplicitIdSelection({ or: [{ id: { in: [1] } }] })).toBeNull();
    expect(readExplicitIdSelection({})).toBeNull();
    expect(readExplicitIdSelection(undefined)).toBeNull();
  });

  it('администратор публикует выбранную им выборку одной операцией', () => {
    const intent = assertBulkChangeAllowed({
      incoming: { status: 'published' },
      user: admin,
      where: selection,
    });
    expect(intent).toEqual({ ids: [1, 2, 3], kind: 'publish' });
  });

  it('ai-editor не публикует пакетно', () => {
    expectRule(
      () =>
        assertBulkChangeAllowed({
          incoming: { status: 'published' },
          user: aiEditor,
          where: selection,
        }),
      'bulk-requires-admin',
    );
  });

  it('вызов без пользователя (расписание, воркер) не публикует пакетно', () => {
    expectRule(
      () =>
        assertBulkChangeAllowed({
          incoming: { status: 'published' },
          user: null,
          where: selection,
        }),
      'bulk-requires-admin',
    );
  });

  it('массовая публикация по фильтру из кода отклоняется даже у администратора', () => {
    expectRule(
      () =>
        assertBulkChangeAllowed({
          incoming: { status: 'published' },
          user: admin,
          where: { status: { equals: 'review' } },
        }),
      'bulk-requires-explicit-selection',
    );
  });

  it('выборка больше предела — это уже не выбор человека', () => {
    const ids = Array.from({ length: MAX_BATCH_SELECTION + 1 }, (_, index) => index + 1);
    expectRule(
      () =>
        assertBulkChangeAllowed({
          incoming: { status: 'published' },
          user: admin,
          where: { id: { in: ids } },
        }),
      'bulk-too-large',
    );
  });

  it('пакетное включение index,follow — отдельная операция, вместе с публикацией нельзя', () => {
    expectRule(
      () =>
        assertBulkChangeAllowed({
          incoming: { robots: 'index,follow', status: 'published' },
          user: admin,
          where: selection,
        }),
      'index-not-separate',
    );
  });

  it('пакетное включение index,follow требует явной выборки и роли admin', () => {
    expect(
      assertBulkChangeAllowed({
        incoming: { robots: 'index,follow' },
        user: admin,
        where: selection,
      }),
    ).toEqual({ ids: [1, 2, 3], kind: 'index' });

    expectRule(
      () =>
        assertBulkChangeAllowed({
          incoming: { robots: 'index,follow' },
          user: aiEditor,
          where: selection,
        }),
      'bulk-requires-admin',
    );

    expectRule(
      () =>
        assertBulkChangeAllowed({
          incoming: { robots: 'index,follow' },
          user: admin,
          where: { robots: { equals: 'noindex,follow' } },
        }),
      'bulk-requires-explicit-selection',
    );
  });

  it('пакетная смена draft ↔ review остаётся доступной (ТЗ §8.5) и не требует id-выборки', () => {
    expect(
      assertBulkChangeAllowed({
        incoming: { status: 'review' },
        user: aiEditor,
        where: { status: { equals: 'draft' } },
      }),
    ).toEqual({ ids: null, kind: 'other' });
  });

  it('пакетная смена URL запрещена: 301 создаётся на каждый путь поштучно', () => {
    expectRule(
      () =>
        assertBulkChangeAllowed({
          incoming: { slug: 'obshchiy' },
          user: admin,
          where: selection,
        }),
      'bulk-url-change',
    );
  });
});
