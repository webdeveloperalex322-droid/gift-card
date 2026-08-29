/**
 * Права очереди заданий (Э5-03).
 *
 * Тест целиком негативный, и это не стиль: очередь — служебная механика, у
 * которой нет ни одного продуктового сценария для `ai-editor`. Ценность здесь в
 * том, что закрыт КАЖДЫЙ из трёх входов, а не «очередь закрыта вообще»:
 *
 *   - ручки (`jobs.access`) — их читает ядро при `run`/`queue`/`cancel`;
 *   - коллекция `payload-jobs` — её ядро отдаёт через REST и GraphQL, и без
 *     `jobsCollectionOverrides` у неё дефолт «любой аутентифицированный». Ровно
 *     это и было найдено ревизией 2026-08-29;
 *   - глобал `payload-jobs-stats` — его нет в конфиге вовсе, он появляется в
 *     санитизации, и права ему тоже достаются дефолтные.
 *
 * Живьём то же самое проверяет `scripts/smoke-etap5-jobs-access.ts`: здесь
 * доказано, что предикаты верны, там — что они стоят на пути настоящего запроса.
 */
import type { CollectionConfig, PayloadRequest, SanitizedConfig } from 'payload';
import { describe, expect, it } from 'vitest';

import {
  JOBS_COLLECTION_SLUG,
  JOB_STATS_GLOBAL_SLUG,
  linkAuditJobsAccess,
  linkAuditJobsCollectionOverrides,
  sealJobsInternals,
} from './task';

const admin = { role: 'admin' };
const aiEditor = { role: 'ai-editor' };

function reqOf(user: unknown): PayloadRequest {
  return { user } as unknown as PayloadRequest;
}

/** Коллекция в том виде, в каком её отдаёт `getDefaultJobsCollection`: без access. */
const defaultJobsCollection = {
  slug: JOBS_COLLECTION_SLUG,
  admin: { group: 'System', hidden: true },
  fields: [{ name: 'input', type: 'json' }],
} as unknown as CollectionConfig;

describe('ручки очереди', () => {
  it('запускать, ставить и отменять задания вправе только admin', () => {
    for (const [name, gate] of Object.entries(linkAuditJobsAccess)) {
      expect(gate({ req: reqOf(admin) }), name).toBe(true);
      expect(gate({ req: reqOf(aiEditor) }), name).toBe(false);
      expect(gate({ req: reqOf(null) }), name).toBe(false);
    }
  });
});

describe('коллекция payload-jobs', () => {
  const overridden = linkAuditJobsCollectionOverrides({ defaultJobsCollection });

  it('все четыре глагола закрыты до admin', () => {
    const access = overridden.access ?? {};
    for (const verb of ['create', 'delete', 'read', 'update'] as const) {
      const gate = access[verb];
      expect(gate, verb).toBeTypeOf('function');
      expect(gate?.({ req: reqOf(admin) }), verb).toBe(true);
      expect(gate?.({ req: reqOf(aiEditor) }), verb).toBe(false);
      expect(gate?.({ req: reqOf(null) }), verb).toBe(false);
    }
  });

  it('остальное в коллекции не трогается: поля и слаг остаются ядерными', () => {
    expect(overridden.slug).toBe(JOBS_COLLECTION_SLUG);
    expect(overridden.fields).toBe(defaultJobsCollection.fields);
  });

  it('хуков не добавляется: при выключенном runHooks ядро их не выполнило бы', () => {
    expect(overridden.hooks).toBeUndefined();
  });
});

describe('глобал payload-jobs-stats', () => {
  function configWith(globals: unknown[]): Promise<SanitizedConfig> {
    return Promise.resolve({ globals } as unknown as SanitizedConfig);
  }

  it('чтение и запись статистики очереди сужаются до admin', async () => {
    const sealed = await sealJobsInternals(
      configWith([
        { slug: JOB_STATS_GLOBAL_SLUG, access: { read: () => true, update: () => true } },
      ]),
    );
    const stats = sealed.globals.find((global) => global.slug === JOB_STATS_GLOBAL_SLUG);

    expect(stats?.access.read({ req: reqOf(admin) })).toBe(true);
    expect(stats?.access.read({ req: reqOf(aiEditor) })).toBe(false);
    expect(stats?.access.update({ req: reqOf(aiEditor) })).toBe(false);
    expect(stats?.access.update({ req: reqOf(null) })).toBe(false);
  });

  it('чужие глобалы остаются как были: правится ровно один слаг', async () => {
    const own = { slug: 'seo-link-audit', access: { read: () => true, update: () => false } };
    const sealed = await sealJobsInternals(configWith([own]));

    expect(sealed.globals[0]).toBe(own);
  });
});
