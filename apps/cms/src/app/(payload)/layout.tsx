/**
 * Корневой layout группы маршрутов Payload.
 *
 * Файл целиком инфраструктурный: его состав задан Payload 3 (шаблон
 * `create-payload-app`). Правится только вместе с обновлением Payload.
 */
import config from '@payload-config';
import '@payloadcms/next/css';
import { RootLayout, handleServerFunctions } from '@payloadcms/next/layouts';
import type { ServerFunctionClient } from 'payload';
import type React from 'react';

import { importMap } from './admin/importMap.js';

type Args = {
  readonly children: React.ReactNode;
};

const serverFunction: ServerFunctionClient = async function (args) {
  'use server';
  return handleServerFunctions({
    ...args,
    config,
    importMap,
  });
};

const Layout = ({ children }: Args) => (
  <RootLayout config={config} importMap={importMap} serverFunction={serverFunction}>
    {children}
  </RootLayout>
);

export default Layout;
