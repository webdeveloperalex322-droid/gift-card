import { withPayload } from '@payloadcms/next/withPayload';

import { adminPath, adminPathRewrites, loadEnvFiles } from './src/env.mjs';

// Корневой .env поднимается явно: Next сам читает только apps/cms/.env, а
// единственный .env монорепозитория лежит в корне (шаблон — .env.example).
loadEnvFiles();

const configuredAdminPath = adminPath();
const { redirects, rewrites } = adminPathRewrites(configuredAdminPath);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // `next dev` иначе создаёт apps/cms/AGENTS.md и apps/cms/CLAUDE.md на каждом
  // запуске. Вложенный CLAUDE.md — это дополнительные инструкции для агентов,
  // появившиеся не решением человека, а побочным эффектом dev-сервера; в
  // проекте единственный CLAUDE.md лежит в корне. Полезное содержание того
  // файла (Next 16 расходится с обучающими данными, документация — в
  // node_modules/next/dist/docs/) перенесено в apps/cms/README.md.
  agentRules: false,

  // Админка не индексируется никогда и ни при каких значениях
  // PAYLOAD_ADMIN_PATH: заголовок ставится на все ответы этого приложения,
  // потому что оно целиком состоит из админки и API (решение Ч-22 — путь
  // админки в robots.txt не публикуется, закрытие делается заголовком).
  headers: async () => [
    {
      headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      source: '/:path*',
    },
  ],

  // Физический /admin не остаётся вторым живым адресом той же админки.
  redirects: async () => redirects,

  // Настроенный PAYLOAD_ADMIN_PATH связывается с физическим маршрутом Next.
  // beforeFiles: переписать нужно ДО файловых маршрутов, иначе Next ответит 404.
  rewrites: async () => ({ afterFiles: [], beforeFiles: rewrites, fallback: [] }),
};

export default withPayload(nextConfig);
