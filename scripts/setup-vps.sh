#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
# .env (API anahtari/panel sifresi tasir) ve data/ yalniz sahibine acik olsun.
umask 077
[ -f .env ] || : > .env  # içeriği ilk `npm start` kurulum sihirbazı doldurur
mkdir -p data
chmod 600 .env
chmod 700 data
if [ ! -f data/auth.json ]; then
  echo 'Panel kimliği henüz oluşturulmamış. Önce: npm run auth:setup' >&2
fi
printf '\nVPS için: docker compose up -d --build\nDurum: docker compose ps\nLog: docker compose logs -f bot\nHealth: curl http://127.0.0.1:8787/api/health\n'
