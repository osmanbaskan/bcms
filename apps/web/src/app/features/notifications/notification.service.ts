import { Injectable, inject, signal } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ApiService } from '../../core/services/api.service';
import { LoggerService } from '../../core/services/logger.service';
import { NotificationSseClient } from './notification-sse.client';
import type { NotifyPayload, NotifyStreamEvent } from './notification.types';

/**
 * Global bildirim koordinatörü. App init'te `start()` çağrılır:
 *  - SSE'ye bağlanır (kullanıcının abone olduğu tipler süzülmüş gelir)
 *  - gelen bildirimde: ses çalar (normal/critical), tarayıcı bildirimi + toast,
 *    okunmadı sayacını artırır.
 * Ses autoplay politikası için ilk kullanıcı etkileşiminde "unlock" yapılır.
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly sse = inject(NotificationSseClient);
  private readonly api = inject(ApiService);
  private readonly snack = inject(MatSnackBar);
  private readonly logger = inject(LoggerService);

  readonly unread = signal(0);
  readonly permission = signal<NotificationPermission>('default');
  readonly connected = this.sse.connected;

  private audioNormal: HTMLAudioElement | null = null;
  private audioCritical: HTMLAudioElement | null = null;
  private soundUnlocked = false;
  private dispose: (() => void) | null = null;
  private started = false;
  /** Kullanıcının tip-bazlı ses tercihi (typeKey -> 'off'|'normal'|'critical'). */
  private soundMap = new Map<string, string>();

  start(): void {
    if (this.started) return;
    this.started = true;

    if (typeof Notification !== 'undefined') this.permission.set(Notification.permission);

    this.audioNormal = new Audio('assets/sounds/notify-normal.mp3');
    this.audioCritical = new Audio('assets/sounds/notify-critical.mp3');
    this.audioNormal.preload = 'auto';
    this.audioCritical.preload = 'auto';

    // İlk kullanıcı etkileşiminde ses kilidini aç (Chrome autoplay politikası).
    const unlock = (): void => {
      this.soundUnlocked = true;
      for (const a of [this.audioNormal, this.audioCritical]) {
        if (!a) continue;
        a.muted = true;
        a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
      }
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    this.refreshUnread();
    this.refreshSounds();
    this.dispose = this.sse.connect((ev) => this.onEvent(ev));
  }

  /** Kullanıcının tip-bazlı ses tercihlerini yükle (Bildirimler sayfası değişiklikten sonra çağırır). */
  refreshSounds(): void {
    this.api.get<{ data: { key: string; sound: string }[] }>('/notifications/subscriptions').subscribe({
      next: (r) => { this.soundMap.clear(); for (const s of r.data) this.soundMap.set(s.key, s.sound); },
      error: () => { /* sessiz */ },
    });
  }

  stop(): void {
    this.dispose?.();
    this.dispose = null;
    this.started = false;
  }

  private onEvent(ev: NotifyStreamEvent): void {
    if (ev.type !== 'notification') return;
    const n = ev.notification;
    this.unread.update((c) => c + 1);
    // Kullanıcının bu tip için seçtiği ses (yoksa tipin varsayılan sesi).
    this.playSound(this.soundMap.get(n.type) ?? n.sound);
    this.showBrowser(n);
    this.snack.open(n.body ? `${n.title} — ${n.body}` : n.title, 'Kapat', { duration: 6000 });
  }

  private playSound(sound: string): void {
    if (sound === 'off') return;   // kullanıcı bu tipi sessize aldı
    const a = sound === 'critical' ? this.audioCritical : this.audioNormal;
    if (!a || !this.soundUnlocked) return;
    try { a.currentTime = 0; void a.play().catch(() => {}); } catch { /* ignore */ }
  }

  private showBrowser(n: NotifyPayload): void {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      const notif = new Notification(n.title, { body: n.body ?? undefined, tag: `bcms-${n.id}`, icon: 'assets/branding/bein-mark.png' });
      notif.onclick = () => { window.focus(); notif.close(); };
    } catch (err) { this.logger.warn('Browser notification gösterilemedi', err); }
  }

  requestPermission(): void {
    if (typeof Notification === 'undefined') return;
    void Notification.requestPermission().then((p) => this.permission.set(p));
  }

  refreshUnread(): void {
    this.api.get<{ count: number }>('/notifications/unread-count').subscribe({
      next: (r) => this.unread.set(r.count),
      error: () => { /* sessiz */ },
    });
  }

  markAllRead(): void {
    this.api.post('/notifications/read-all', {}).subscribe({ next: () => this.unread.set(0), error: () => {} });
  }

  decrementUnread(): void { this.unread.update((c) => Math.max(0, c - 1)); }
}
