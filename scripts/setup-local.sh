#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
# .env (API anahtari/panel sifresi tasir) ve data/ yalniz sahibine acik olsun.
umask 077
[ -f .env ] || : > .env  # içeriği ilk `npm start` kurulum sihirbazı doldurur
mkdir -p data
chmod 600 .env
chmod 700 data
npm install
printf '\nHazır. Paper modunda başlatmak için: npm start\nPanel: http://127.0.0.1:8787\n'
