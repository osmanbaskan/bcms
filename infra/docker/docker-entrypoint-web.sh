#!/bin/sh
set -e
# Keycloak public URL'yi runtime-config.js'e yaz
envsubst '${BCMS_KEYCLOAK_PUBLIC_URL}' \
  < /etc/nginx/runtime-config.js.template \
  > /usr/share/nginx/html/assets/runtime-config.js
exec nginx -g 'daemon off;'
