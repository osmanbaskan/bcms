# Keycloak Theme Geliştirme — Cache Davranışı

**Konum**: `infra/keycloak/themes/beinport/`
**Compose env**: `docker-compose.yml` keycloak servisi → KC_SPI_THEME_*

## Dev Davranışı (mevcut default)

Compose env varsayılanları **cache kapalı** (CSS değişiklikleri hızlı görünür):

```yaml
KC_SPI_THEME_STATIC_MAX_AGE: -1     # Cache-Control no-cache
KC_SPI_THEME_CACHE_THEMES: false
KC_SPI_THEME_CACHE_TEMPLATES: false
```

## Theme Edit Workflow

1. Theme dosyasını edit et:
   ```bash
   nano infra/keycloak/themes/beinport/login/login.css
   ```
2. Keycloak'ı restart (theme bytecode cache flush için zorunlu):
   ```bash
   docker compose restart keycloak
   ```
3. Browser hard refresh (sayfa cache temizleme):
   - Windows/Linux: `Ctrl+Shift+R`
   - macOS: `Cmd+Shift+R`
   - Veya DevTools → Application → Storage → Clear site data

4. https://beinport/realms/bcms/account adresine git, değişikliği gör.

## Production Override

Production'da cache aktif olmalı (CDN ile hız + sunucu yükü düşürme):

`.env`'e ekle:
```ini
KC_SPI_THEME_STATIC_MAX_AGE=31536000   # 1 yıl
KC_SPI_THEME_CACHE_THEMES=true
KC_SPI_THEME_CACHE_TEMPLATES=true
```

Sonra:
```bash
docker compose up -d keycloak
```

## Kullanılan Theme

- **beinport** — özel BCMS marka kimliği, login + account console
- Built-in (`keycloak` parent) overshadow olmasın diye sadece `beinport/` subdir mount edilir:
  ```yaml
  - ./infra/keycloak/themes/beinport:/opt/keycloak/themes/beinport:ro
  ```

## Realm Theme Atama

Theme'in aktif olması için realm config'inde set edilir:
```json
{
  "loginTheme": "beinport",
  "accountTheme": "beinport"
}
```

`infra/keycloak/realm-export.json`'da bu zaten ayarlı; realm restart ile re-import.
