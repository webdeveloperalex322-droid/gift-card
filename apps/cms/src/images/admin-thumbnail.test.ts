import { beforeEach, describe, expect, it, vi } from 'vitest';

const readDerivative = vi.fn<(key: string) => Promise<Buffer>>();

vi.mock('./storage-env', () => ({
  imageStorage: () => ({ readDerivative }),
}));

import { CardImages } from '../collections/card-images';

function thumbnailEndpoint() {
  const endpoints = Array.isArray(CardImages.endpoints) ? CardImages.endpoints : [];
  const endpoint = endpoints.find(
    (candidate) => candidate.method === 'get' && candidate.path === '/admin-thumbnail/:id',
  );
  expect(endpoint, 'endpoint миниатюры должен быть зарегистрирован в card-images').toBeDefined();
  return endpoint;
}

function request(input: {
  readonly doc?: Record<string, unknown>;
  readonly id?: unknown;
  readonly user?: Record<string, unknown> | null;
}) {
  const findByID = vi.fn().mockResolvedValue(input.doc ?? null);
  return {
    findByID,
    req: {
      payload: { findByID },
      routeParams: { id: input.id ?? '17' },
      user: input.user === undefined ? { id: 3, role: 'admin' } : input.user,
    },
  };
}

describe('card-images: миниатюра в админке', () => {
  beforeEach(() => {
    readDerivative.mockReset();
  });

  it('adminThumbnail строит same-origin URL по id записи, не по ключу файла', () => {
    const upload = typeof CardImages.upload === 'object' ? CardImages.upload : undefined;
    expect(typeof upload?.adminThumbnail).toBe('function');

    const thumbnail =
      typeof upload?.adminThumbnail === 'function'
        ? upload.adminThumbnail({ doc: { id: 17, originalKey: 'originals/secret.png' } })
        : null;

    expect(thumbnail).toBe('/api/card-images/admin-thumbnail/17');
    expect(String(thumbnail)).not.toContain('originals');
  });

  it('анониму не раскрывает ни запись, ни производную', async () => {
    const endpoint = thumbnailEndpoint();
    const { findByID, req } = request({ user: null });

    const response = await endpoint?.handler(req as never);

    expect(response?.status).toBe(403);
    expect(findByID).not.toHaveBeenCalled();
    expect(readDerivative).not.toHaveBeenCalled();
  });

  it('аутентифицированному отдаёт WebP минимальной ширины с приватными заголовками', async () => {
    const endpoint = thumbnailEndpoint();
    const { findByID, req } = request({
      doc: {
        id: 17,
        variants: [
          { byteSize: 111, format: 'jpeg', height: 480, key: 'cards/r/a-640.jpg', width: 640 },
          { byteSize: 55, format: 'jpeg', height: 240, key: 'cards/r/a-320.jpg', width: 320 },
          { byteSize: 44, format: 'webp', height: 240, key: 'cards/r/a-320.webp', width: 320 },
        ],
      },
    });
    readDerivative.mockResolvedValue(Buffer.from('preview'));

    const response = await endpoint?.handler(req as never);

    expect(response?.status).toBe(200);
    expect(response?.headers.get('Content-Type')).toBe('image/webp');
    expect(response?.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response?.headers.get('X-Robots-Tag')).toBe('noindex');
    await expect(response?.arrayBuffer()).resolves.toEqual(
      Uint8Array.from(Buffer.from('preview')).buffer,
    );
    expect(readDerivative).toHaveBeenCalledWith('cards/r/a-320.webp');
    expect(findByID).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'card-images',
        depth: 0,
        id: '17',
        overrideAccess: false,
        req,
        select: { variants: true },
      }),
    );
  });

  it('при отсутствии пригодной производной отвечает 404 и не читает оригинал', async () => {
    const endpoint = thumbnailEndpoint();
    const { req } = request({
      doc: {
        id: 17,
        originalKey: 'originals/secret.png',
        variants: [{ format: 'svg', key: 'originals/secret.png', width: 1 }],
      },
    });

    const response = await endpoint?.handler(req as never);

    expect(response?.status).toBe(404);
    expect(readDerivative).not.toHaveBeenCalled();
  });
});
