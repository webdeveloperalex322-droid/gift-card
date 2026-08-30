/**
 * Страница 404 внутри админки. Состав задан Payload 3.
 *
 * Отдаёт настоящий 404 (Next выставляет статус для not-found), а не 200 с
 * пустым содержимым — требование раздела «HTTP-статусы» CLAUDE.md.
 */
import config from '@payload-config';
import { NotFoundPage, generatePageMetadata } from '@payloadcms/next/views';
import type { Metadata } from 'next';

import { importMap } from '../importMap.js';

type Args = {
  readonly params: Promise<{
    segments: string[];
  }>;
  readonly searchParams: Promise<{
    [key: string]: string | string[];
  }>;
};

export const generateMetadata = ({ params, searchParams }: Args): Promise<Metadata> =>
  generatePageMetadata({ config, params, searchParams });

const NotFound = ({ params, searchParams }: Args) =>
  NotFoundPage({ config, importMap, params, searchParams });

export default NotFound;
