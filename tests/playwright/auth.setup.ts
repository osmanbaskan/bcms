import { test as setup, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Auth setup — Keycloak'a admin/admin123 ile login → storageState.json yazar.
 * Diğer tüm test'ler bu state'i reuse ederek login formunu atlar.
 */

const STORAGE_DIR = path.join(__dirname, 'storage');
const STORAGE_FILE = path.join(STORAGE_DIR, 'auth.json');

setup('admin login → storageState', async ({ page }) => {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });

  await page.goto('/');

  // Keycloak login ekranına yönlendirilmeli (loginTheme=beinport)
  await page.waitForURL(/realms\/bcms\/protocol\/openid-connect\/auth/, { timeout: 15_000 });

  // Türkçe label: "Kullanıcı adı veya E-mail" / "Şifre" / "Oturum aç"
  await page.locator('input[name="username"], #username').fill('admin');
  await page.locator('input[name="password"], #password').fill('admin123');

  await Promise.all([
    page.waitForURL((u) => !u.toString().includes('/realms/'), { timeout: 15_000 }),
    page.locator('input[type="submit"], button[type="submit"], #kc-login').first().click(),
  ]);

  // Dashboard yüklendi mi?
  await expect(page).toHaveURL(/\/(dashboard|$)/, { timeout: 10_000 });

  await page.context().storageState({ path: STORAGE_FILE });
  console.log(`[auth] storageState yazıldı: ${STORAGE_FILE}`);
});
