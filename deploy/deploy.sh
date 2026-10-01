#!/usr/bin/env bash
# Серверный деплой otkritka. Живёт на сервере как ~/otkritka/deploy.sh,
# вызывается из GitHub Actions: `ssh deploy@host 'bash ~/otkritka/deploy.sh'`.
#
# Пароль sudo читается ПЕРВОЙ строкой stdin (CI: `... <<< "$DEPLOY_SUDO_PASS"`),
# поэтому в argv и в логах его нет. Исходники приезжают tarball-ом в
# ~/otkritka/incoming.tgz (CI делает scp перед вызовом).
#
# docker/compose идут через sudo -S: пользователь deploy не в docker-группе.
set -euo pipefail

read -r SUDO_PASS
S() { printf '%s\n' "$SUDO_PASS" | sudo -S -p '' "$@"; }

ROOT="$HOME/otkritka"
ENV_FILE="$ROOT/otkritka.prod.env"
cd "$ROOT"

[ -f incoming.tgz ] || { echo "НЕТ incoming.tgz — CI не доставил исходники"; exit 2; }
[ -f "$ENV_FILE" ] || { echo "НЕТ $ENV_FILE"; exit 2; }

# Распаковка свежих исходников рядом, атомарная замена в конце.
rm -rf src.new && mkdir src.new && tar xzf incoming.tgz -C src.new
# Самообновление скрипта на следующий запуск.
if [ -f src.new/deploy/deploy.sh ]; then cp src.new/deploy/deploy.sh "$ROOT/deploy.sh.next"; fi

set -a; . "$ENV_FILE"; set +a
COMPOSE="deploy/docker-compose.prod.yml"

cd "$ROOT/src.new"

# db должен быть поднят ДО сборки: astro build пререндерит /404, middleware
# читает таблицу редиректов — образ собирается с --network на контейнер db.
S docker compose -p otkritka --env-file "$ENV_FILE" -f "$COMPOSE" up -d db
echo "--- ждём healthy db ---"
for i in $(seq 1 40); do
  st=$(S docker inspect -f '{{.State.Health.Status}}' otkritka-db-1 2>/dev/null || echo none)
  [ "$st" = healthy ] && break
  sleep 3
done
[ "${st:-}" = healthy ] || { echo "db не стал healthy"; exit 3; }

echo "--- build образа ---"
S docker build --network otkritka_internal \
  --build-arg SITE_URL="$SITE_URL" \
  --build-arg DATABASE_URL="$DATABASE_URL" \
  --build-arg PAYLOAD_SECRET="$PAYLOAD_SECRET" \
  --build-arg PAYLOAD_ADMIN_PATH="$PAYLOAD_ADMIN_PATH" \
  -f deploy/Dockerfile -t otkritka:latest .

echo "--- up cms + web ---"
S docker compose -p otkritka --env-file "$ENV_FILE" -f "$COMPOSE" up -d cms web
S docker image prune -f >/dev/null 2>&1 || true

# Атомарная замена каталога исходников и самообновление скрипта.
cd "$ROOT"
rm -rf src.old && (mv src src.old 2>/dev/null || true) && mv src.new src && rm -rf src.old
[ -f deploy.sh.next ] && mv deploy.sh.next deploy.sh && chmod +x deploy.sh
rm -f incoming.tgz

echo "--- статус ---"
S docker compose -p otkritka --env-file "$ENV_FILE" -f "src/$COMPOSE" ps --format '{{.Name}} {{.Status}}'
echo DEPLOY_DONE
