import { describe, expect, it } from 'vitest';
import { leagueCodeForCompId, sportGroupForCompId } from './opta.sync.routes.js';

/**
 * Unit kapsam: `/opta/sync` compId → (leagues.code, leagues.sport_group)
 * eşleme helper'ları (2026-05-13).
 *
 * Kontratlar:
 *   - Futbol srml akışı (`compId='115'`, `'8'`, ...) `opta-${compId}` ürettiği
 *     mevcut davranışı korur (regression guard).
 *   - Tenis / MotoGP / Rugby compId'ler `custom-${compId}` üretir; bu sayede
 *     watcher → /opta/sync hattı, migration `20260513140000_leagues_sport_group`
 *     ile seed edilen `custom-tennis` / `custom-motogp` / `custom-rugby*`
 *     row'larıyla hizalanır ve `/fixture-competitions` filtre'sini bozmaz.
 *   - Rugby alt-lig'leri `compId='rugby-<num>'` paterni; `custom-rugby-<num>`.
 *   - sport_group new-create branch'inde compId'den deduce edilir (default
 *     'football'); existing kayıtların sport_group'una dokunulmaz — bu helper
 *     yalnızca create path'inde çağrılır.
 */
describe('leagueCodeForCompId', () => {
  it('futbol srml compId → opta- prefix (regression)', () => {
    expect(leagueCodeForCompId('115')).toBe('opta-115');
    expect(leagueCodeForCompId('8')).toBe('opta-8');
    expect(leagueCodeForCompId('24')).toBe('opta-24');
    expect(leagueCodeForCompId('L1')).toBe('opta-L1');
  });

  it('tennis compId → custom-tennis', () => {
    expect(leagueCodeForCompId('tennis')).toBe('custom-tennis');
  });

  it('motogp compId → custom-motogp', () => {
    expect(leagueCodeForCompId('motogp')).toBe('custom-motogp');
  });

  it('rugby-<num> compId → custom-rugby-<num>', () => {
    expect(leagueCodeForCompId('rugby-204')).toBe('custom-rugby-204');
    expect(leagueCodeForCompId('rugby-203')).toBe('custom-rugby-203');
  });

  it('rugby prefix yoksa futbol gibi davranır (defensive)', () => {
    expect(leagueCodeForCompId('rugb')).toBe('opta-rugb');
    expect(leagueCodeForCompId('rugby_no_dash')).toBe('opta-rugby_no_dash');
  });
});

describe('sportGroupForCompId', () => {
  it('futbol srml compId → football', () => {
    expect(sportGroupForCompId('115')).toBe('football');
    expect(sportGroupForCompId('8')).toBe('football');
    expect(sportGroupForCompId('L1')).toBe('football');
  });

  it('tennis compId → tennis', () => {
    expect(sportGroupForCompId('tennis')).toBe('tennis');
  });

  it('motogp compId → motogp', () => {
    expect(sportGroupForCompId('motogp')).toBe('motogp');
  });

  it('rugby-<num> compId → rugby', () => {
    expect(sportGroupForCompId('rugby-204')).toBe('rugby');
    expect(sportGroupForCompId('rugby-203')).toBe('rugby');
  });

  it('bilinmeyen compId → football fallback', () => {
    expect(sportGroupForCompId('basketball')).toBe('football');
    expect(sportGroupForCompId('f1')).toBe('football');
  });
});
