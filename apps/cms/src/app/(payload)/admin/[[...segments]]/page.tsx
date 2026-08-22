/**
 * Маршрут админки Payload.
 *
 * Каталог называется `admin` ВСЕГДА, независимо от `PAYLOAD_ADMIN_PATH`:
 * Payload 3 привязывает админку к физическому маршруту Next, а файловую систему
 * из окружения не переименовать. Настроенный путь связывается с этим маршрутом
 * переписыванием запросов в `next.config.mjs` (см. `adminPathRewrites`).
 *
 * Состав файла задан Payload 3 (шаблон `create-payload-app`).
 */
import config from '@payload-config';
import { RootPage, generatePageMetadata } from '@payloadcms/next/views';
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

const Page = ({ params, searchParams }: Args) =>
  RootPage({ config, importMap, params, searchParams });

export default Page;
