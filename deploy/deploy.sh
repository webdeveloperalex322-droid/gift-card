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

# Путь админки записан в vhost nginx строкой (location /admin). При другом
# значении настоящая админка уедет в location / (web) — отдаст 404 и окажется
# БЕЗ Basic Auth. Лучше остановить деплой, чем молча снять защиту.
if [ "${PAYLOAD_ADMIN_PATH:-}" != "/admin" ]; then
  echo "PAYLOAD_ADMIN_PATH=${PAYLOAD_ADMIN_PATH:-<пусто>} не совпадает с location /admin в deploy/nginx/dobrye-otkrytki.ru.conf"
  echo "Поправь vhost и этот guard вместе, иначе админка останется без Basic Auth"
  exit 4
fi

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

psql_db() { S docker exec otkritka-db-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -Atc "$1"; }

# Работающий образ — точка отката, если новый не пройдёт smoke-проверку ниже.
if S docker image inspect otkritka:latest >/dev/null 2>&1; then
  S docker tag otkritka:latest otkritka:prev
fi

# ---- Миграции схемы: ДО сборки основного образа ----------------------------
# В production Payload схему не пушит, и без этого шага новое поле доезжает до
# прода кодом, но не колонкой — 2026-10-04 так упал весь сайт. До сборки —
# потому что сама сборка читает БД (пререндер /404). Старые контейнеры всё это
# время работают на новой схеме: миграция обязана быть совместимой со старым
# кодом (добавлять можно сразу, удалять и переименовывать — вторым деплоем).
echo "--- образ миграций ---"
S docker build --target migrate -f deploy/Dockerfile -t otkritka:migrate .

echo "--- дамп БД перед миграциями ---"
BACKUP_DIR=/home/deploy/otkritka/backups
# В дампе users — хеши паролей и API-ключи: только владельцу.
umask 077
mkdir -p "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/pre-migrate-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
S docker exec otkritka-db-1 pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" | gzip > "$BACKUP"
[ -s "$BACKUP" ] || { echo "дамп пуст: $BACKUP — миграции не запускаю"; exit 5; }
ls -1t "$BACKUP_DIR"/pre-migrate-*.sql.gz | tail -n +11 | xargs -r rm -f
echo "дамп: $BACKUP"

# Строка batch=-1 в payload_migrations — след `push` из dev-режима. При ней
# `payload migrate` задаёт вопрос «данные будут потеряны, продолжить?», без TTY
# получает отказ и выходит с кодом 0, НЕ применив ничего. Останавливаемся явно.
if [ "$(psql_db "select count(*) from pg_tables where schemaname='public' and tablename='payload_migrations'")" = 1 ]; then
  if [ "$(psql_db "select count(*) from payload_migrations where batch = -1")" != 0 ]; then
    echo "в payload_migrations есть строка dev-push (batch = -1): payload migrate молча ничего не применит."
    echo "Одного удаления строки мало: тогда migrate запустит baseline на непустой схеме и упадёт"
    echo "на CREATE TYPE ... already exists. Разово, ПОСЛЕ сверки схемы прода со снимком baseline:"
    echo "  delete from payload_migrations where batch = -1;"
    echo "  insert into payload_migrations (name, batch, updated_at, created_at)"
    echo "    values ('20261009_165231_baseline', 1, now(), now());"
    exit 5
  fi
fi

echo "--- payload migrate ---"
# stdin закрывается ВНУТРИ sudo: при закэшированном sudo строка пароля из S()
# иначе ушла бы в prompts процесса payload migrate.
S sh -c 'exec docker compose -p otkritka --env-file "$1" -f "$2" --profile tools run --rm -T migrate </dev/null' _ "$ENV_FILE" "$COMPOSE"

# Код выхода 0 не доказывает, что миграции применены (см. вопрос выше), поэтому
# сверяем: каждый файл миграции из образа обязан иметь строку в БД.
# Список — из того же контекста сборки, что ушёл в образ (мы в src.new).
EXPECTED=$(find apps/cms/src/migrations -maxdepth 1 -name '*.ts' ! -name index.ts -printf '%f\n' | sed 's/\.ts$//' | sort)
APPLIED=$(psql_db "select name from payload_migrations where batch > 0" | sort)
MISSING=$(comm -23 <(printf '%s\n' "$EXPECTED") <(printf '%s\n' "$APPLIED") | sed '/^$/d')
if [ -n "$MISSING" ]; then
  echo "миграции не применены:"; printf '  %s\n' $MISSING
  exit 6
fi
echo "миграции применены: $(printf '%s\n' "$EXPECTED" | sed '/^$/d' | wc -l)"

echo "--- build образа ---"
S docker build --network otkritka_internal \
  --build-arg SITE_URL="$SITE_URL" \
  --build-arg DATABASE_URL="$DATABASE_URL" \
  --build-arg PAYLOAD_SECRET="$PAYLOAD_SECRET" \
  --build-arg PAYLOAD_ADMIN_PATH="$PAYLOAD_ADMIN_PATH" \
  -f deploy/Dockerfile -t otkritka:latest .

echo "--- up cms + web ---"
S docker compose -p otkritka --env-file "$ENV_FILE" -f "$COMPOSE" up -d cms web

# ---- Smoke-проверка и откат ------------------------------------------------
# Сайт, отдающий 404 на всех страницах, раньше считался успешным деплоем. Здесь
# главная обязана отдать 200 (читает глобал настроек). Каталог — 200 или 404:
# без опубликованного контента 404 у него штатный (правило проекта), но 5xx и
# обрыв — нет. API cms — не 5xx на выборке карточек (читает все их колонки).
smoke() {
  local i code ok
  for i in $(seq 1 30); do
    ok=1
    code=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:4321/" || true)
    [ "$code" = 200 ] || ok=0
    code=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:4321/otkrytki" || true)
    case "$code" in 200|404) ;; *) ok=0 ;; esac
    code=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:3011/api/cards?limit=1&depth=0" || true)
    case "$code" in 2??|401|403) ;; *) ok=0 ;; esac
    [ "$ok" = 1 ] && return 0
    sleep 4
  done
  return 1
}
if ! smoke; then
  echo "SMOKE FAIL: главная не 200, каталог не 200/404 или API cms отвечает 5xx"
  S docker compose -p otkritka --env-file "$ENV_FILE" -f "$COMPOSE" logs --tail 40 cms web || true
  if S docker image inspect otkritka:prev >/dev/null 2>&1; then
    echo "--- откат на otkritka:prev ---"
    S docker tag otkritka:prev otkritka:latest
    S docker compose -p otkritka --env-file "$ENV_FILE" -f "$COMPOSE" up -d cms web
    if smoke; then
      echo "ОТКАТ УДАЛСЯ: работает предыдущий образ, новый код не выкачен"
    else
      echo "ОТКАТ НЕ ПОДНЯЛСЯ: сайт не отвечает и на предыдущем образе — нужен человек"
    fi
  else
    echo "образа otkritka:prev нет — откатывать не на что, нужен человек"
  fi
  exit 7
fi
echo "smoke ok"
S docker image prune -f >/dev/null 2>&1 || true

# Атомарная замена каталога исходников и самообновление скрипта.
cd "$ROOT"
rm -rf src.old && (mv src src.old 2>/dev/null || true) && mv src.new src && rm -rf src.old
[ -f deploy.sh.next ] && mv deploy.sh.next deploy.sh && chmod +x deploy.sh
rm -f incoming.tgz

echo "--- статус ---"
S docker compose -p otkritka --env-file "$ENV_FILE" -f "src/$COMPOSE" ps --format '{{.Name}} {{.Status}}'
echo DEPLOY_DONE
