# Keycloak Theme — `beinport`

Konum: `infra/keycloak/themes/beinport/`
Mount: `docker-compose.yml` web servisinde Keycloak container'a `/opt/keycloak/themes/beinport:ro` olarak bağlı.
Parent: `keycloak` (yani Keycloak base theme).

## Override edilen template'ler

### `login/login.ftl` — **base template override**

Bu dosya Keycloak base `theme/base/login/login.ftl` ile **byte-byte aynı kopyadır**; bilerek yapılan tek fark iki `autocomplete` attribute değeridir:

| Input | Base value | Override value |
|-------|-----------|----------------|
| `name="username"` | `autocomplete="off"` | `autocomplete="username"` |
| `name="password"` | `autocomplete="off"` | `autocomplete="current-password"` |

**Neden:** Keycloak default'u `autocomplete="off"` Chrome / Firefox / Safari password manager'larının credential kaydetmesini ve autofill yapmasını bastırıyordu. HTML5 spec'inin önerdiği `username` ve `current-password` token'ları bu davranışı geri açar.

**Diğer her şey base ile birebir aynıdır** — `type`, `name`, `id`, form `action`, `method`, submit akışı, CSS class'ları (`${properties.kcInputClass!}` vs.), `<#if>` mesaj render mantığı, social provider section, register link, password visibility toggle hiç dokunulmadı.

## Upgrade prosedürü

Keycloak sürüm yükseltildiğinde (örn. 23 → 24, 25 vs.):

1. Yeni sürümün base `login.ftl`'ini çıkar:
   ```bash
   docker cp <keycloak-container>:/opt/keycloak/lib/lib/main/org.keycloak.keycloak-themes-<NEW_VERSION>.jar /tmp/kc-themes.jar
   unzip -p /tmp/kc-themes.jar theme/base/login/login.ftl > /tmp/base-login-new.ftl
   ```

2. **`infra/keycloak/themes/beinport/login/login.ftl` dosyasını yeni upstream `login.ftl` ile karşılaştır.**
   ```bash
   diff /tmp/base-login-new.ftl infra/keycloak/themes/beinport/login/login.ftl
   ```
   Beklenen fark: yalnızca yukarıdaki tabloda listelenen 2 `autocomplete` satırı.

3. Eğer upstream ek değişiklik (yeni feature, passkey UI, recovery codes vs.) eklemişse:
   - Yeni base'i hedef dosyaya kopyala.
   - Aynı 2 autocomplete değişikliğini tekrar uygula.
   - Login akışını gözle: form alanları, error message render, submit URL, password visibility toggle çalışıyor olmalı.

4. Test:
   ```bash
   curl -sk "https://beinport/realms/bcms/protocol/openid-connect/auth?client_id=bcms-web&redirect_uri=https://beinport/&response_type=code&scope=openid" -L | grep autocomplete
   ```
   Beklenen iki satır:
   ```
   ...name="username" ... autocomplete="username"
   ...name="password" ... autocomplete="current-password"
   ```

## Bilinen kısıt

Theme production-cache aktifse Keycloak template'i restart olmadan yeniden yüklemeyebilir; değişiklik sonrası `docker compose restart keycloak` (~10-15s downtime) gerekebilir.
