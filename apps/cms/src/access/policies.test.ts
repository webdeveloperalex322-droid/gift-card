/**
 * Матрица прав по ролям (задача Э1-03). Негативные проверки здесь важнее
 * позитивных: право, которого нет на бумаге, но есть в реальности, возникает
 * именно в этих функциях.
 *
 * Тестируются ЧИСТЫЕ предикаты, а не поведение Payload: предикаты — это то, из
 * чего собраны `access` во всех коллекциях, и они одинаково действуют для
 * админки, REST и GraphQL. Проверка через живой сервер — задача Э6-02
 * (негативные API-тесты), она эти проверки не заменяет, а дополняет.
 */
import type { PayloadRequest } from 'payload';
import { describe, expect, it } from 'vitest';

import {
  canCreateContent,
  canDeleteContent,
  canEditContent,
  canEditSlug,
  canManageRedirects,
  canManageUsers,
  canOverrideCanonical,
  canReadDraftContent,
  canSetContentUpdatedAt,
  canSetIndexFollow,
  canSetRobots,
  canSetStatus,
  canUseAdminPanel,
  contentDeleteAccess,
  contentReadAccess,
  contentStatusFieldAccess,
  slugFieldAccess,
  systemFieldAccess,
} from './policies';
import { ROLES } from './roles';

const admin = { role: ROLES.admin } as const;
const aiEditor = { role: ROLES.aiEditor } as const;
const anonymous = null;

describe('Э1-03: доступ в админку', () => {
  it('админку открывает только человек с ролью admin', () => {
    expect(canUseAdminPanel(admin)).toBe(true);
  });

  it('сервисный аккаунт и аноним в админку не входят', () => {
    // ai-editor работает только через API. Вход в админку ему не нужен, а
    // возможность войти означала бы, что часть правил можно обойти интерфейсом.
    expect(canUseAdminPanel(aiEditor)).toBe(false);
    expect(canUseAdminPanel(anonymous)).toBe(false);
  });
});

describe('Э1-03: управление пользователями и ключами', () => {
  it('только admin', () => {
    expect(canManageUsers(admin)).toBe(true);
    expect(canManageUsers(aiEditor)).toBe(false);
    expect(canManageUsers(anonymous)).toBe(false);
  });
});

describe('Э1-03: контент — создание и правка', () => {
  it('создавать и править может admin и ai-editor', () => {
    expect(canCreateContent(admin)).toBe(true);
    expect(canCreateContent(aiEditor)).toBe(true);
    expect(canEditContent(admin)).toBe(true);
    expect(canEditContent(aiEditor)).toBe(true);
  });

  it('аноним не создаёт и не правит', () => {
    expect(canCreateContent(anonymous)).toBe(false);
    expect(canEditContent(anonymous)).toBe(false);
  });

  it('черновики и review читает только аутентифицированный', () => {
    expect(canReadDraftContent(admin)).toBe(true);
    expect(canReadDraftContent(aiEditor)).toBe(true);
    expect(canReadDraftContent(anonymous)).toBe(false);
  });
});

describe('Э1-03: статус записи', () => {
  it('ai-editor доводит контент до review — это его граница', () => {
    expect(canSetStatus(aiEditor, 'draft')).toBe(true);
    expect(canSetStatus(aiEditor, 'review')).toBe(true);
  });

  it('ai-editor НЕ переводит в published', () => {
    expect(canSetStatus(aiEditor, 'published')).toBe(false);
  });

  it('публикует только admin', () => {
    expect(canSetStatus(admin, 'published')).toBe(true);
    expect(canSetStatus(anonymous, 'published')).toBe(false);
  });

  it('неизвестное значение статуса отклоняется у обеих ролей (fail closed)', () => {
    // Иначе опечатка в значении обходила бы проверку на 'published'.
    expect(canSetStatus(admin, 'live')).toBe(false);
    expect(canSetStatus(aiEditor, 'PUBLISHED')).toBe(false);
    expect(canSetStatus(aiEditor, '')).toBe(false);
  });
});

describe('Э1-03: robots и индексация', () => {
  it('менять robots-директиву может только admin', () => {
    expect(canSetRobots(admin)).toBe(true);
    expect(canSetRobots(aiEditor)).toBe(false);
    expect(canSetRobots(anonymous)).toBe(false);
  });

  it('index,follow — только admin и только для published', () => {
    expect(canSetIndexFollow(admin, 'published')).toBe(true);
    expect(canSetIndexFollow(admin, 'review')).toBe(false);
    expect(canSetIndexFollow(admin, 'draft')).toBe(false);
  });

  it('ai-editor не открывает страницу в индекс ни в одном статусе', () => {
    expect(canSetIndexFollow(aiEditor, 'published')).toBe(false);
    expect(canSetIndexFollow(aiEditor, 'draft')).toBe(false);
    expect(canSetIndexFollow(anonymous, 'published')).toBe(false);
  });
});

describe('Э1-03: canonical и lastmod', () => {
  it('переопределение canonical — только admin (ТЗ §8.1)', () => {
    expect(canOverrideCanonical(admin)).toBe(true);
    expect(canOverrideCanonical(aiEditor)).toBe(false);
    expect(canOverrideCanonical(anonymous)).toBe(false);
  });

  it('дату содержательного обновления правит только admin', () => {
    // updatedContentAt — источник lastmod в sitemap, а sitemap ai-editor не трогает.
    expect(canSetContentUpdatedAt(admin)).toBe(true);
    expect(canSetContentUpdatedAt(aiEditor)).toBe(false);
    expect(canSetContentUpdatedAt(anonymous)).toBe(false);
  });
});

describe('Э1-03: slug', () => {
  it('до первой публикации slug правят обе роли', () => {
    expect(canEditSlug(aiEditor, { publishedAt: null })).toBe(true);
    expect(canEditSlug(aiEditor, undefined)).toBe(true);
    expect(canEditSlug(admin, { publishedAt: null })).toBe(true);
  });

  it('ai-editor не меняет slug после первой публикации', () => {
    expect(canEditSlug(aiEditor, { publishedAt: '2026-08-22T10:00:00.000Z' })).toBe(false);
  });

  it('снятие с публикации не разблокирует slug для ai-editor', () => {
    // Признак — факт первой публикации (publishedAt), а не текущий статус:
    // иначе достаточно было бы вернуть запись в draft, чтобы сменить URL.
    expect(
      canEditSlug(aiEditor, { publishedAt: '2026-08-22T10:00:00.000Z', status: 'draft' }),
    ).toBe(false);
  });

  it('admin проходит проверку роли — но не проверку 301 (Э1-09)', () => {
    expect(canEditSlug(admin, { publishedAt: '2026-08-22T10:00:00.000Z' })).toBe(true);
  });

  it('аноним не правит slug никогда', () => {
    expect(canEditSlug(anonymous, { publishedAt: null })).toBe(false);
  });
});

describe('Э1-03: редиректы', () => {
  it('создавать и менять редиректы может только admin', () => {
    expect(canManageRedirects(admin)).toBe(true);
    expect(canManageRedirects(aiEditor)).toBe(false);
    expect(canManageRedirects(anonymous)).toBe(false);
  });
});

describe('Э1-03: удаление контента', () => {
  it('admin удаляет любую запись', () => {
    expect(canDeleteContent(admin, { publishedAt: '2026-08-22T10:00:00.000Z' })).toBe(true);
  });

  it('ai-editor удаляет только никогда не публиковавшийся черновик', () => {
    expect(canDeleteContent(aiEditor, { status: 'draft', publishedAt: null })).toBe(true);
    expect(canDeleteContent(aiEditor, { status: 'review', publishedAt: null })).toBe(false);
    expect(
      canDeleteContent(aiEditor, { status: 'draft', publishedAt: '2026-08-22T10:00:00.000Z' }),
    ).toBe(false);
  });

  it('аноним не удаляет ничего', () => {
    expect(canDeleteContent(anonymous, { status: 'draft', publishedAt: null })).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Адаптеры под Payload: та же матрица, но в форме, которую зовёт      */
/* Payload на каждом запросе — включая REST и GraphQL.                 */
/* ------------------------------------------------------------------ */

/** Минимальный запрос: правилам доступа нужен только пользователь. */
function requestOf(role: string | null): PayloadRequest {
  const user = role === null ? null : { id: 1, role };
  return { user } as unknown as PayloadRequest;
}

describe('адаптер доступа к полю status', () => {
  it('ai-editor не может записать published, но может review', () => {
    expect(
      contentStatusFieldAccess({
        req: requestOf(ROLES.aiEditor),
        siblingData: { status: 'published' },
      }),
    ).toBe(false);
    expect(
      contentStatusFieldAccess({
        req: requestOf(ROLES.aiEditor),
        siblingData: { status: 'review' },
      }),
    ).toBe(true);
  });

  it('admin может записать published', () => {
    expect(
      contentStatusFieldAccess({
        req: requestOf(ROLES.admin),
        siblingData: { status: 'published' },
      }),
    ).toBe(true);
  });

  it('если статус не передан, проверяется только право на правку', () => {
    expect(contentStatusFieldAccess({ req: requestOf(ROLES.aiEditor) })).toBe(true);
    expect(contentStatusFieldAccess({ req: requestOf(null) })).toBe(false);
  });
});

describe('адаптер чтения контента', () => {
  it('анониму отдаётся ЗАПРОС, ограничивающий выборку published', () => {
    // Ограничение запросом, а не логикой: иначе черновик можно было бы получить
    // подбором параметров REST или через GraphQL.
    expect(contentReadAccess({ req: requestOf(null) })).toEqual({
      status: { equals: 'published' },
    });
  });

  it('аутентифицированный видит черновики', () => {
    expect(contentReadAccess({ req: requestOf(ROLES.aiEditor) })).toBe(true);
  });
});

describe('адаптер удаления контента', () => {
  it('ai-editor ограничен запросом «черновик, никогда не публиковавшийся»', () => {
    expect(contentDeleteAccess({ req: requestOf(ROLES.aiEditor) })).toEqual({
      and: [{ status: { equals: 'draft' } }, { publishedAt: { exists: false } }],
    });
  });

  it('admin — без ограничений, аноним — отказ', () => {
    expect(contentDeleteAccess({ req: requestOf(ROLES.admin) })).toBe(true);
    expect(contentDeleteAccess({ req: requestOf(null) })).toBe(false);
  });
});

describe('адаптер доступа к slug', () => {
  it('ai-editor не правит slug опубликованной записи', () => {
    expect(
      slugFieldAccess({
        req: requestOf(ROLES.aiEditor),
        doc: { id: 1, publishedAt: '2026-08-22T10:00:00.000Z' },
      }),
    ).toBe(false);
  });

  it('до публикации правит', () => {
    expect(
      slugFieldAccess({ req: requestOf(ROLES.aiEditor), doc: { id: 1, publishedAt: null } }),
    ).toBe(true);
  });
});

describe('служебные поля', () => {
  it('не пишутся никем снаружи, включая admin', () => {
    // pHash, ключ производной, revision и суффикс имени заполняют серверные
    // хуки через Local API (overrideAccess), а не запрос редактора.
    expect(systemFieldAccess({ req: requestOf(ROLES.admin) })).toBe(false);
    expect(systemFieldAccess({ req: requestOf(ROLES.aiEditor) })).toBe(false);
  });
});
