/**
 * Backward-compat re-export. Asıl implementation `core/concurrency.ts`'e
 * taşındı (2026-05-27); Provys watcher + SSDB resolver/worker ortak kullanır.
 * Provys feature module dışından da import edilebilir (mimari ayrışma).
 *
 * Mevcut Provys import path'leri etkilenmez:
 *   import { ConcurrencyLimiter } from './provys.concurrency.js';
 */
export { ConcurrencyLimiter } from '../../core/concurrency.js';
