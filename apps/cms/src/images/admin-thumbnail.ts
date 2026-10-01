import type { Endpoint, PayloadRequest } from 'payload';

import { imageStorage } from './storage-env';

export const CARD_IMAGE_ADMIN_THUMBNAIL_PATH = '/admin-thumbnail/:id';

const MIME_BY_FORMAT = {
  avif: 'image/avif',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
} as const;

type PreviewFormat = keyof typeof MIME_BY_FORMAT;

interface PreviewVariant {
  readonly format: PreviewFormat;
  readonly key: string;
  readonly width: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function previewVariant(doc: Record<string, unknown>): PreviewVariant | null {
  if (!Array.isArray(doc.variants)) return null;

  const variants: PreviewVariant[] = [];
  for (const value of doc.variants) {
    const row = asRecord(value);
    const format = row.format;
    const key = row.key;
    const width = row.width;
    if (
      (format === 'avif' || format === 'jpeg' || format === 'webp') &&
      typeof key === 'string' &&
      key.trim() !== '' &&
      typeof width === 'number' &&
      Number.isInteger(width) &&
      width > 0
    ) {
      variants.push({ format, key, width });
    }
  }

  const formatPriority: Readonly<Record<PreviewFormat, number>> = {
    webp: 0,
    avif: 1,
    jpeg: 2,
  };
  variants.sort(
    (left, right) =>
      left.width - right.width || formatPriority[left.format] - formatPriority[right.format],
  );
  return variants[0] ?? null;
}

function notFound(): Response {
  return Response.json({ errors: [{ message: 'Миниатюра не найдена.' }] }, { status: 404 });
}

export function cardImageAdminThumbnailUrl(doc: Record<string, unknown>): false | null | string {
  const id = doc.id;
  if ((typeof id !== 'number' && typeof id !== 'string') || String(id).trim() === '') return null;
  return `/api/card-images/admin-thumbnail/${encodeURIComponent(String(id))}`;
}

async function handleAdminThumbnail(req: PayloadRequest): Promise<Response> {
  if (!req.user) {
    return Response.json(
      { errors: [{ message: 'Миниатюра доступна только авторизованному редактору.' }] },
      { status: 403 },
    );
  }

  const id = req.routeParams?.id;
  if ((typeof id !== 'number' && typeof id !== 'string') || String(id).trim() === '') {
    return notFound();
  }

  let doc: Record<string, unknown>;
  try {
    doc = await req.payload.findByID({
      collection: 'card-images',
      depth: 0,
      id,
      overrideAccess: false,
      req,
      select: { variants: true },
    });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      (error as { status?: unknown }).status === 404
    ) {
      return notFound();
    }
    throw error;
  }

  const variant = previewVariant(doc);
  if (variant === null) return notFound();

  let bytes: Buffer;
  try {
    bytes = await imageStorage().readDerivative(variant.key);
  } catch {
    return notFound();
  }

  return new Response(Uint8Array.from(bytes), {
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Type': MIME_BY_FORMAT[variant.format],
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex',
    },
    status: 200,
  });
}

export const cardImageAdminThumbnailEndpoint: Endpoint = {
  handler: handleAdminThumbnail,
  method: 'get',
  path: CARD_IMAGE_ADMIN_THUMBNAIL_PATH,
};
