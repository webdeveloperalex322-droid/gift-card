import type { PayloadRequest } from 'payload';
import { describe, expect, it } from 'vitest';

import { GATEWAY_LIMIT_CEILING, type McpActor, cappedLimit, createGateway } from './gateway';

interface RecordedCall {
  readonly args: Readonly<Record<string, unknown>>;
  readonly operation: string;
}

const ACTOR: McpActor = { id: 42, role: 'ai-editor' };

function fakeRequest(): { calls: RecordedCall[]; req: PayloadRequest } {
  const calls: RecordedCall[] = [];
  const record = (operation: string) => (args: Readonly<Record<string, unknown>>) => {
    calls.push({ args, operation });
    return Promise.resolve({ docs: [], id: 1, totalDocs: 0 });
  };
  const req = {
    payload: { create: record('create'), find: record('find'), update: record('update') },
    user: { id: 42, role: 'ai-editor' },
  } as unknown as PayloadRequest;
  return { calls, req };
}

describe('createGateway', () => {
  it('каждая операция идёт с overrideAccess: false и пользователем актора', async () => {
    const { calls, req } = fakeRequest();
    const gateway = createGateway({ actor: ACTOR, req });

    await gateway.findCards({});
    await gateway.findCollections({});
    await gateway.findCardImages({});
    await gateway.createCard({ title: 'a' });
    await gateway.updateCard({ data: { title: 'b' }, id: 1 });
    await gateway.createCollection({ title: 'c' });
    await gateway.updateCollection({ data: { title: 'd' }, id: 2 });

    expect(calls).toHaveLength(7);
    for (const call of calls) {
      expect(call.args.overrideAccess).toBe(false);
      expect(call.args.user).toEqual({ id: 42, role: 'ai-editor' });
    }
  });

  it('незаданный лимит заменяется потолком, а не оставляется Payload на усмотрение', async () => {
    const { calls, req } = fakeRequest();
    await createGateway({ actor: ACTOR, req }).findCards({});
    expect(calls[0]?.args.limit).toBe(GATEWAY_LIMIT_CEILING);
  });

  it('лимит выше потолка урезается', async () => {
    const { calls, req } = fakeRequest();
    await createGateway({ actor: ACTOR, req }).findCards({ limit: 100_000 });
    expect(calls[0]?.args.limit).toBe(GATEWAY_LIMIT_CEILING);
  });

  it('depth по умолчанию нулевой: связи отдаются идентификаторами', async () => {
    const { calls, req } = fakeRequest();
    await createGateway({ actor: ACTOR, req }).findCards({});
    expect(calls[0]?.args.depth).toBe(0);
  });

  it('ходит именно в те коллекции, которые названы', async () => {
    const { calls, req } = fakeRequest();
    const gateway = createGateway({ actor: ACTOR, req });
    await gateway.findCards({});
    await gateway.findCollections({});
    await gateway.findCardImages({});
    expect(calls.map((c) => c.args.collection)).toEqual(['cards', 'collections', 'card-images']);
  });
});

describe('cappedLimit', () => {
  it('держит потолок и нижнюю границу', () => {
    expect(cappedLimit(undefined)).toBe(GATEWAY_LIMIT_CEILING);
    expect(cappedLimit(10)).toBe(10);
    expect(cappedLimit(0)).toBe(1);
    expect(cappedLimit(-5)).toBe(1);
    expect(cappedLimit(GATEWAY_LIMIT_CEILING + 1)).toBe(GATEWAY_LIMIT_CEILING);
  });
});
