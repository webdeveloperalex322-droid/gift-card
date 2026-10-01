# Единый образ монорепозитория otkritka.
# Из него запускаются ДВА сервиса (см. docker-compose.prod.yml):
#   - cms: Payload/Next  (next start --port 3011)  — админка /admin и API /api
#   - web: Astro node     (dist/server/entry.mjs)   — сайт и отдача /media
# web ходит в Payload через Local API (импортирует @otkritka/cms), поэтому
# обоим сервисам нужен один и тот же собранный репозиторий и одна БД.

# ---- base -------------------------------------------------------------------
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# ca-certificates нужен pnpm/fetch; остальное sharp 0.35 тянет prebuilt-бинарём.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

# ---- deps (кэшируемый слой установки) ---------------------------------------
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/cms/package.json apps/cms/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/images/package.json packages/images/package.json
RUN pnpm install --frozen-lockfile

# ---- build ------------------------------------------------------------------
FROM deps AS build
# SITE_URL обязателен на сборке: пререндеренные маршруты (например 404) собирают
# абсолютный canonical, а дефолта у хоста нет (packages/shared/site-url.ts).
# DATABASE_URL тоже обязателен: пререндер /404 проходит через middleware, а тот
# читает таблицу редиректов (apps/web/src/middleware.ts) — нужна ЖИВАЯ БД на
# сборке. Поэтому образ собирается с `--network` на поднятый контейнер db, а
# PAYLOAD_DB_PUSH=true даёт astro build создать схему через Payload Local API
# (на этой стадии drizzle-kit доступен как devDep, в отличие от собранного web).
ARG SITE_URL
ARG DATABASE_URL
ARG PAYLOAD_SECRET=build-time-placeholder
ARG PAYLOAD_ADMIN_PATH=/admin
ENV SITE_URL=$SITE_URL \
    DATABASE_URL=$DATABASE_URL \
    PAYLOAD_SECRET=$PAYLOAD_SECRET \
    PAYLOAD_ADMIN_PATH=$PAYLOAD_ADMIN_PATH \
    PAYLOAD_DB_PUSH=true \
    NODE_ENV=production
COPY . .
# build:libs (tsc -b) -> web build (astro build && tsc) -> cms build (next build)
RUN pnpm run build

# ---- runtime ----------------------------------------------------------------
# Оставляем весь собранный репозиторий со всеми зависимостями: web и cms
# подтягивают payload/drizzle/next/astro в рантайме, prune мог бы срезать нужное.
FROM build AS runtime
ENV NODE_ENV=production
# Общий корень хранилища изображений (монтируется томом в обоих сервисах).
RUN mkdir -p /data/media /data/uploads
EXPOSE 4321 3011
# Команда задаётся в compose на каждый сервис.
CMD ["node", "-e", "console.error('set command in compose'); process.exit(1)"]
