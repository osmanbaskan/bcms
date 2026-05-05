#!/bin/sh
set -e

# DÜŞÜK-INF (2026-05-04): env zorunlu doğrulama. Boş/eksik bırakılırsa runtime
# config "${BCMS_KEYCLOAK_PUBLIC_URL}" template literal sızar; environment.prod.ts
# bu durumu tespit edip fallback yapıyor (FE-2.2.4 fix), ama daha açık fail-fast
# image entrypoint seviyesinde de yararlı.
if [ -z "${BCMS_KEYCLOAK_PUBLIC_URL:-}" ]; then
  echo "[entrypoint] WARN: BCMS_KEYCLOAK_PUBLIC_URL set edilmemiş; runtime-config.js'de boş string kullanılacak."
fi

# Keycloak public URL'yi runtime-config.js'e yaz
envsubst '${BCMS_KEYCLOAK_PUBLIC_URL}' \
  < /etc/nginx/runtime-config.js.template \
  > /usr/share/nginx/html/assets/runtime-config.js
exec nginx -g 'daemon off;'
