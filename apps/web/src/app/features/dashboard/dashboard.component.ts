import { Component, OnInit, OnDestroy, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { KeycloakService } from 'keycloak-angular';
import { interval, Subscription } from 'rxjs';

import { GROUP, type ProvysLiveTodayDto } from '@bcms/shared';
import { KpiComponent } from '../../core/ui/kpi.component';
import { CardComponent } from '../../core/ui/card.component';
import { PageHeaderComponent } from '../../core/ui/page-header.component';
import { ApiService } from '../../core/services/api.service';
import { STUDIO_PLAN_SLOT_MINUTES } from '../studio-plan/studio-plan.component';
import { ProvysService } from '../provys-content-control/provys.service';
import {
  PROVYS_CHANNELS,
  PROVYS_CATEGORY_STYLES,
  type ProvysCategory,
  type ProvysChannelSlug,
  type ProvysItemDto,
} from '../provys-content-control/provys.types';

interface IngestPort {
  id: number;
  name: string;
  active?: boolean;
  status?: string;
}

interface StudioSlot {
  id: number;
  studio: string;
  programName: string;
  startTime: string;
  endTime: string;
}

/**
 * Kanal kutusu (dashboard "şu an yayında" özeti). Provys per-channel store'undan
 * türetilir: o an oynayan PROGRAM/CANLI materyali; eğer şu an REKLAM/KAMU_SPOTU/
 * TANITIM/DIGER yayındaysa SIRADAKİ PROGRAM/CANLI bilgisini gösterir.
 */
interface ChannelBox {
  slug: ProvysChannelSlug;
  name: string;
  state: 'live' | 'upcoming' | 'idle' | 'loading';
  category: ProvysCategory | null;
  catLabel: string;
  catClass: string;
  title: string;
  series: string | null;
  start: string;
  end: string;
}

/** Kategori → CSS class fragment (provys panel ile aynı eşleme). */
const CATEGORY_CLASS: Record<ProvysCategory, string> = {
  REKLAM: 'reklam',
  KAMU_SPOTU: 'kamu',
  CANLI: 'canli',
  PROGRAM: 'program',
  TANITIM: 'tanitim',
  DIGER: 'diger',
};

/** PROGRAM/CANLI = "esas materyal"; diğerleri ara-yayın (reklam/tanıtım/spot). */
function isProgramLike(c: ProvysCategory): boolean {
  return c === 'PROGRAM' || c === 'CANLI';
}

/**
 * Dashboard — beINport Genel Bakış pattern (UI V2 Aşama 2A).
 * KPI rail + Hero (canlı yayın) + Vardiya + 6 kanal kutusu + Stüdyo + Ports.
 *
 * 2026-05-31: "Bugünün yayın akışı" + "Son uyarılar" kartları kaldırıldı;
 * yerine BUGÜN CANLİ YAYIN altına 6 kanal için "şu an yayında / sıradaki"
 * kutuları eklendi (Provys snapshot'tan türetilir; her kutu büyütülebilir).
 *
 * KORUMA: BCMS API'lerine sadece read-only sorgu yapılır. Yetkiler default ([] — auth user).
 */
@Component({
  selector: 'bp-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    KpiComponent,
    CardComponent,
    PageHeaderComponent,
  ],
  template: `
    <bp-page-header
      [title]="'Bugünün operasyonu'"
      [eyebrow]="todayEyebrow()"
    ></bp-page-header>

    <div class="dashboard">
      <!-- ─── KPI Rail ────────────────────────────────────────────────── -->
      <div class="kpi-rail">
        <bp-kpi [accent]="true"
                label="Bugün canlı yayın"
                [value]="kpiLiveTotal()"></bp-kpi>
        <bp-kpi label="Aktif port"
                [value]="kpiActivePorts()"
                [unit]="'/' + kpiTotalPorts()"
                [sub]="(kpiTotalPorts() - kpiActivePorts()) + ' boş/bekleme'"></bp-kpi>
        <bp-kpi label="Stüdyo programı"
                [value]="kpiStudios()"
                [sub]="'bugün'"></bp-kpi>
        <bp-kpi label="Ekip · vardiya"
                [value]="kpiShiftCount()"
                [sub]="'placeholder · Aşama 3'"></bp-kpi>
        <bp-kpi label="Aktif uyarı"
                [value]="kpiAlerts()"
                [sub]="'placeholder · Aşama 3'"></bp-kpi>
      </div>

      <!-- ─── Kanal kutuları (6 yan yana) — KPI rail'in hemen altında ──── -->
      <!-- Provys per-channel snapshot'tan türetilir. PROGRAM/CANLI yayındaysa
           onu; REKLAM/TANITIM/KAMU_SPOTU/DIGER yayındaysa SIRADAKİ PROGRAM/
           CANLI'yı gösterir. Her kutu çapraz-ok ile büyütülebilir (ortalanır). -->
      <div class="channels-row" data-test="channel-boxes">
        @for (box of channelBoxes(); track box.slug) {
          <div class="ch-box"
               [class.is-live]="box.state === 'live'"
               [class.is-upcoming]="box.state === 'upcoming'"
               [attr.data-slug]="box.slug">
            <button type="button"
                    class="ch-expand"
                    (click)="expand(box.slug)"
                    [attr.aria-label]="box.name + ' kutusunu büyüt'"
                    title="Büyüt">
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <path fill="currentColor" d="M10 21H3v-7h2v3.59l4.29-4.3 1.42 1.42L6.41 19H10v2zm11-11h-2V6.41l-4.29 4.3-1.42-1.42L17.59 5H14V3h7v7z"/>
              </svg>
            </button>

            <div class="ch-head">
              <span class="ch-name" [title]="box.name">{{ box.name }}</span>
            </div>

            @if (box.state === 'loading') {
              <div class="ch-empty">Yükleniyor…</div>
            } @else if (box.state === 'idle') {
              <div class="ch-empty">Program / Canlı yok</div>
            } @else {
              @if (box.series) {
                <div class="ch-series" [title]="box.series">{{ box.series }}</div>
              }
              <div class="ch-title" [title]="box.title">{{ box.title }}</div>
              <div class="ch-time">{{ box.start }}<span class="ch-dash">–</span>{{ box.end }}</div>
            }
          </div>
        }
      </div>

      <!-- ─── Hero + Shift row ───────────────────────────────────────── -->
      <div class="row hero-row">
        <div class="hero" [class.is-expanded]="expandedPanel() === 'hero'">
          <button type="button"
                  class="hero-expand"
                  (click)="togglePanel('hero')"
                  [attr.aria-label]="'Canlı yayın kutusunu büyüt'"
                  [title]="expandedPanel() === 'hero' ? 'Kapat' : 'Büyüt'">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path fill="currentColor" d="M10 21H3v-7h2v3.59l4.29-4.3 1.42 1.42L6.41 19H10v2zm11-11h-2V6.41l-4.29 4.3-1.42-1.42L17.59 5H14V3h7v7z"/>
            </svg>
          </button>
          <div class="hero-live">
            <div class="hero-live-head">
              <span class="hero-badge"><span class="hero-dot"></span> CANLI</span>
              <span class="hero-live-count">Bugün · {{ liveToday().length }} yayın</span>
            </div>
            @if (loadingLive()) {
              <div class="hero-live-state">Yükleniyor…</div>
            } @else if (liveToday().length === 0) {
              <div class="hero-live-state">Bugün canlı kategorili yayın yok</div>
            } @else {
              <div class="hero-live-list">
                @for (ev of liveToday(); track ev.id) {
                  <div class="hero-live-row">
                    <span class="hl-time">{{ hhmm(ev.startTimecode) }}</span>
                    <span class="hl-channel">{{ ev.channelName }}</span>
                    <span class="hl-title" [title]="ev.title">{{ ev.title }}</span>
                  </div>
                }
              </div>
            }
          </div>
        </div>

        <bp-card title="Vardiyam" [padded]="true"
                 [expandable]="true"
                 [expanded]="expandedPanel() === 'vardiya'"
                 [class.is-expanded]="expandedPanel() === 'vardiya'"
                 (expandClick)="togglePanel('vardiya')">
          @if (canViewWeeklyShift()) {
            <a card-action class="link-action" routerLink="/weekly-shift">Tümü →</a>
          }
          <div class="shift-empty">
            <div class="placeholder-eyebrow">PLACEHOLDER · Aşama 3</div>
            <div class="placeholder-text">Vardiya kartı henüz bağlanmadı</div>
            @if (canViewWeeklyShift()) {
              <a class="link-action" routerLink="/weekly-shift">Haftalık shift →</a>
            }
          </div>
        </bp-card>
      </div>

      <!-- ─── Stüdyo + Ingest portları row ───────────────────────────── -->
      <div class="row info-row">
        <bp-card [title]="'Stüdyo programı'" [count]="todayStudios().length + ' kayıt'"
                 [expandable]="true"
                 [expanded]="expandedPanel() === 'studio'"
                 [class.is-expanded]="expandedPanel() === 'studio'"
                 (expandClick)="togglePanel('studio')">
          <a card-action class="link-action" routerLink="/studio-plan">Tümü →</a>
          <div class="studio-list">
            @if (loadingStudios()) {
              <div class="empty">Yükleniyor…</div>
            } @else {
              @for (p of todayStudios().slice(0, 7); track p.id) {
                <a class="studio-row"
                   [routerLink]="['/studio-plan']"
                   [queryParams]="{ day: isoToday(), studio: p.studio, time: p.startTime }">
                  <div class="studio-bar"></div>
                  <div class="studio-text">
                    <div class="studio-name">{{ p.programName || '(boş slot)' }}</div>
                    <div class="studio-meta">{{ p.studio }}</div>
                  </div>
                  <div class="studio-time">
                    <div class="studio-start">{{ p.startTime }}</div>
                    <div class="studio-end">{{ p.endTime }}</div>
                  </div>
                </a>
              } @empty {
                <div class="empty">Bugün için stüdyo programı yok.</div>
              }
            }
          </div>
        </bp-card>

        <bp-card [title]="'Ingest portları'"
                 [count]="kpiActivePorts() + '/' + kpiTotalPorts() + ' aktif'"
                 [expandable]="true"
                 [expanded]="expandedPanel() === 'ports'"
                 [class.is-expanded]="expandedPanel() === 'ports'"
                 (expandClick)="togglePanel('ports')">
          <a card-action class="link-action" routerLink="/ingest">Detay →</a>
          <div class="ports-grid">
            @if (loadingPorts()) {
              <div class="empty">Yükleniyor…</div>
            } @else if (ports().length === 0) {
              <div class="empty">Tanımlı port yok.</div>
            } @else {
              @for (p of ports(); track p.id) {
                <a class="port-cell"
                   [class.active]="p.active"
                   [class.idle]="!p.active"
                   [title]="p.name + (p.active ? ' · aktif' : ' · pasif')"
                   [routerLink]="['/ingest']"
                   [queryParams]="{ port: p.name }">
                  {{ portShortName(p.name) }}
                </a>
              }
            }
          </div>
          <div class="ports-legend">
            <span><i class="dot active"></i>Aktif</span>
            <span><i class="dot idle"></i>Pasif</span>
          </div>
        </bp-card>
      </div>
    </div>

    <!-- ─── Kart büyütme backdrop'u (hero + bp-card'lar için) ────────── -->
    @if (expandedPanel()) {
      <div class="panel-backdrop" (click)="collapsePanel()" data-test="panel-backdrop"></div>
    }

    <!-- ─── Büyütülmüş kanal kutusu (overlay, ortalanmış) ─────────────── -->
    @if (expandedBox(); as box) {
      <div class="ch-overlay" (click)="collapse()" data-test="channel-overlay">
        <div class="ch-box ch-box--big"
             [class.is-live]="box.state === 'live'"
             [class.is-upcoming]="box.state === 'upcoming'"
             [attr.data-slug]="box.slug"
             (click)="$event.stopPropagation()">
          <button type="button"
                  class="ch-expand ch-collapse"
                  (click)="collapse()"
                  aria-label="Kapat"
                  title="Kapat">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path fill="currentColor" d="M22 3.41 16.71 8.7 19 11h-7V4l2.29 2.29L19.59 1 22 3.41zM2 20.59 7.29 15.3 5 13h7v7l-2.29-2.29L4.41 23 2 20.59z"/>
            </svg>
          </button>

          <div class="ch-head">
            <span class="ch-name">{{ box.name }}</span>
          </div>

          @if (box.state === 'loading') {
            <div class="ch-empty">Yükleniyor…</div>
          } @else if (box.state === 'idle') {
            <div class="ch-empty">Program / Canlı yok</div>
          } @else {
            @if (box.series) {
              <div class="ch-series">{{ box.series }}</div>
            }
            <div class="ch-title ch-title--big">{{ box.title }}</div>
            <div class="ch-time ch-time--big">{{ box.start }}<span class="ch-dash">–</span>{{ box.end }}</div>
          }
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .dashboard {
      padding: 0 32px 32px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    /* ─── KPI rail ─────────────────────────────────────────────────── */
    .kpi-rail {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 12px;
    }

    /* ─── Layout rows ──────────────────────────────────────────────── */
    .row { display: grid; gap: 16px; }
    .hero-row { grid-template-columns: 1fr 320px; }
    .info-row { grid-template-columns: 1.4fr 1fr; }

    /* ─── Hero ─────────────────────────────────────────────────────── */
    .hero {
      background: linear-gradient(135deg, #4c1d95 0%, #2e1065 60%, #1a1b20 100%);
      border: 1px solid rgba(167, 139, 250, 0.20);
      border-radius: var(--bp-r-xl);
      padding: 24px 28px;
      position: relative;
      overflow: hidden;
      min-height: 220px;
      display: flex;
      align-items: stretch;
    }
    .hero-badge {
      display: inline-flex;
      gap: 8px;
      align-items: center;
      font-size: 10.5px;
      font-weight: var(--bp-fw-bold);
      letter-spacing: 0.10em;
      color: #fff;
      background: rgba(239, 68, 68, 0.20);
      border: 1px solid rgba(239, 68, 68, 0.50);
      padding: 4px 10px;
      border-radius: 14px;
    }
    .hero-dot {
      width: 6px;
      height: 6px;
      border-radius: 3px;
      background: #ef4444;
      box-shadow: 0 0 8px #ef4444;
      animation: bp-pulse var(--bp-dur-pulse) infinite;
    }
    .hero-expand {
      position: absolute; top: 14px; right: 14px; z-index: 2;
      width: 26px; height: 26px;
      display: grid; place-items: center;
      background: rgba(255, 255, 255, 0.12);
      border: 1px solid rgba(255, 255, 255, 0.22);
      border-radius: 6px;
      color: #fff;
      cursor: pointer;
      padding: 0;
      transition: background var(--bp-dur-fast);
    }
    .hero-expand:hover { background: rgba(255, 255, 255, 0.24); }
    .hero.is-expanded {
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      width: min(880px, 92vw);
      max-height: 86vh;
      overflow: auto;
      z-index: 1001;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
      animation: bp-card-pop 140ms ease-out;
    }
    @keyframes bp-card-pop { from { transform: translate(-50%, -50%) scale(0.96); opacity: 0; } to { transform: translate(-50%, -50%) scale(1); opacity: 1; } }
    .hero.is-expanded .hero-live-list { max-height: 64vh; }
    /* Kart büyütme backdrop'u — hero + bp-card .is-expanded ile birlikte. */
    .panel-backdrop {
      position: fixed; inset: 0; z-index: 1000;
      background: rgba(10, 10, 14, 0.66);
      backdrop-filter: blur(2px);
      animation: ch-fade var(--bp-dur-fast, 120ms) ease-out;
    }
    /* ─── Hero canlı (CANLI) liste ─────────────────────────────────── */
    .hero-live { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .hero-live-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
    .hero-live-count {
      font-size: 12.5px; color: rgba(255, 255, 255, 0.65);
      font-family: var(--bp-font-mono); letter-spacing: 0.03em;
    }
    .hero-live-state { color: rgba(255, 255, 255, 0.7); font-size: 13px; padding: 10px 0; }
    .hero-live-list {
      display: flex; flex-direction: column;
      overflow-y: auto; max-height: 188px;
    }
    .hero-live-row {
      display: flex; align-items: center; gap: 12px;
      padding: 6px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      color: #fff;
    }
    .hero-live-row:last-child { border-bottom: 0; }
    .hl-time {
      font-family: var(--bp-font-mono); font-size: 13px; font-weight: var(--bp-fw-medium);
      color: #fca5a5; width: 46px; flex: 0 0 46px;
    }
    .hl-channel {
      font-size: 11px; color: rgba(255, 255, 255, 0.62);
      width: 96px; flex: 0 0 96px;
      text-transform: uppercase; letter-spacing: 0.04em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .hl-title {
      flex: 1; min-width: 0; font-size: 13px; color: rgba(255, 255, 255, 0.92);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    /* ─── Card slot link action ───────────────────────────────────── */
    .link-action {
      font-size: 11px;
      color: var(--bp-purple-300);
      text-decoration: none;
      white-space: nowrap;
    }

    /* ─── Shift placeholder ───────────────────────────────────────── */
    .shift-empty {
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: flex-start;
    }
    .placeholder-eyebrow {
      font-size: 9.5px;
      letter-spacing: 0.10em;
      font-weight: var(--bp-fw-bold);
      background: var(--bp-status-PENDING-bg);
      border: 1px solid var(--bp-status-PENDING-fg);
      color: var(--bp-status-PENDING-fg);
      padding: 3px 8px;
      border-radius: 4px;
    }
    .placeholder-text { font-size: 13px; color: var(--bp-fg-2); }

    /* ─── Kanal kutuları ──────────────────────────────────────────── */
    .channels-row {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 12px;
    }
    .ch-box {
      position: relative;
      background: var(--bp-bg-2);
      border: 1px solid var(--bp-line-2);
      border-left: 3px solid var(--bp-line);
      border-radius: var(--bp-r-lg, 10px);
      padding: 12px 12px 13px;
      min-height: 148px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      overflow: hidden;
    }
    .ch-box.is-live { border-left-color: #ef4444; background: rgba(239, 68, 68, 0.05); }
    .ch-box.is-upcoming { border-left-color: var(--bp-purple-400, #a78bfa); }
    .ch-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px; padding-right: 22px; min-width: 0;
    }
    .ch-name {
      font-size: 12.5px; font-weight: var(--bp-fw-semibold, 600);
      color: var(--bp-fg-1);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ch-flag {
      flex: 0 0 auto;
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 9px; font-weight: var(--bp-fw-bold, 700);
      letter-spacing: 0.06em;
      padding: 2px 6px; border-radius: 10px;
    }
    .ch-flag--live { color: #fca5a5; background: rgba(239, 68, 68, 0.18); border: 1px solid rgba(239, 68, 68, 0.42); }
    .ch-flag--next { color: var(--bp-purple-300, #c4b5fd); background: rgba(124, 58, 237, 0.16); border: 1px solid rgba(124, 58, 237, 0.40); }
    .ch-dot {
      width: 5px; height: 5px; border-radius: 50%;
      background: #ef4444; box-shadow: 0 0 6px #ef4444;
      animation: bp-pulse var(--bp-dur-pulse) infinite;
    }
    .ch-expand {
      position: absolute; top: 8px; right: 8px;
      width: 22px; height: 22px;
      display: grid; place-items: center;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--bp-line-2);
      border-radius: 5px;
      color: var(--bp-fg-3);
      cursor: pointer;
      padding: 0;
      transition: background var(--bp-dur-fast), color var(--bp-dur-fast);
    }
    .ch-expand:hover { background: rgba(124, 58, 237, 0.20); color: var(--bp-fg-1); }
    .ch-cat {
      align-self: flex-start;
      display: inline-block; padding: 2px 8px;
      border-radius: var(--bp-r-pill, 999px);
      font-size: 10.5px; font-weight: var(--bp-fw-semibold, 600); line-height: 1.4;
      border: 1px solid transparent;
    }
    .ch-cat--reklam   { background: rgba(16, 185, 129, 0.18); color: #6ee7b7; border-color: rgba(16, 185, 129, 0.40); }
    .ch-cat--kamu     { background: rgba(99, 102, 241, 0.18); color: #a5b4fc; border-color: rgba(99, 102, 241, 0.40); }
    .ch-cat--canli    { background: rgba(239, 68, 68, 0.22);  color: #fca5a5; border-color: rgba(239, 68, 68, 0.45); }
    .ch-cat--program  { background: rgba(245, 158, 11, 0.18); color: #fcd34d; border-color: rgba(245, 158, 11, 0.40); }
    .ch-cat--tanitim  { background: rgba(168, 85, 247, 0.18); color: #d8b4fe; border-color: rgba(168, 85, 247, 0.40); }
    .ch-cat--diger    { background: rgba(156, 163, 175, 0.16); color: #d1d5db; border-color: rgba(156, 163, 175, 0.35); }
    .ch-series {
      font-size: 10.5px; color: var(--bp-fg-3); letter-spacing: 0.03em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ch-title {
      font-size: 13px; color: var(--bp-fg-1); line-height: 1.3;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .ch-time {
      margin-top: auto;
      font-family: var(--bp-font-mono); font-size: 12px;
      color: var(--bp-purple-300, #c4b5fd);
      font-variant-numeric: tabular-nums;
    }
    .ch-dash { margin: 0 4px; color: var(--bp-fg-4); }
    .ch-empty {
      flex: 1; display: grid; place-items: center;
      color: var(--bp-fg-4); font-size: 12px; text-align: center;
    }

    /* ─── Büyütülmüş kutu (overlay) ───────────────────────────────── */
    .ch-overlay {
      position: fixed; inset: 0; z-index: 1000;
      background: rgba(10, 10, 14, 0.66);
      backdrop-filter: blur(2px);
      display: grid; place-items: center;
      padding: 24px;
      animation: ch-fade var(--bp-dur-fast, 120ms) ease-out;
    }
    .ch-box--big {
      width: min(560px, 92vw);
      min-height: 300px;
      padding: 28px 30px 30px;
      gap: 12px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
      animation: ch-pop var(--bp-dur-fast, 140ms) ease-out;
    }
    .ch-box--big .ch-head { padding-right: 34px; }
    .ch-box--big .ch-name { font-size: 18px; }
    .ch-collapse { width: 30px; height: 30px; top: 14px; right: 14px; }
    .ch-title--big {
      font-size: 22px; font-weight: var(--bp-fw-semibold, 600);
      -webkit-line-clamp: 5;
    }
    .ch-time--big { font-size: 15px; }
    @keyframes ch-fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes ch-pop { from { transform: scale(0.94); opacity: 0; } to { transform: scale(1); opacity: 1; } }

    /* ─── Studio list ─────────────────────────────────────────────── */
    .studio-list { display: flex; flex-direction: column; }
    .studio-row {
      display: flex;
      gap: 12px;
      padding: 11px 18px;
      align-items: center;
      border-bottom: 1px solid var(--bp-line-2);
      text-decoration: none;
      color: inherit;
      transition: background var(--bp-dur-fast);
    }
    .studio-row:hover { background: var(--bp-row-hover); }
    .studio-row:last-child { border-bottom: 0; }
    .studio-bar { width: 3px; height: 32px; border-radius: 2px; flex-shrink: 0; background: var(--bp-purple-400); }
    .studio-text { flex: 1; min-width: 0; }
    .studio-name {
      font-size: 13px;
      font-weight: var(--bp-fw-medium);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .studio-meta { font-size: 11px; color: var(--bp-fg-3); margin-top: 2px; }
    .studio-time { text-align: right; }
    .studio-start { font-family: var(--bp-font-mono); font-size: 12px; color: var(--bp-purple-300); }
    .studio-end { font-family: var(--bp-font-mono); font-size: 10px; color: var(--bp-fg-4); margin-top: 2px; }

    /* ─── Ports grid ──────────────────────────────────────────────── */
    .ports-grid {
      padding: 18px;
      display: grid;
      grid-template-columns: repeat(10, 1fr);
      gap: 6px;
    }
    .port-cell {
      aspect-ratio: 1;
      border-radius: 4px;
      display: grid;
      place-items: center;
      font-size: 9px;
      font-family: var(--bp-font-mono);
      color: #fff;
      text-decoration: none;
      transition: transform var(--bp-dur-fast), filter var(--bp-dur-fast);
    }
    .port-cell:hover { transform: scale(1.08); filter: brightness(1.18); }
    .port-cell.active { background: var(--bp-purple-500); }
    .port-cell.idle { background: var(--bp-bg-3); opacity: 0.4; }
    .ports-legend {
      padding: 0 18px 16px;
      display: flex;
      gap: 14px;
      font-size: 11px;
      color: var(--bp-fg-3);
    }
    .ports-legend i {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 2px;
      margin-right: 5px;
      vertical-align: middle;
    }
    .ports-legend i.active { background: var(--bp-purple-500); }
    .ports-legend i.idle { background: var(--bp-bg-3); opacity: 0.6; }

    /* ─── Empty + loading ─────────────────────────────────────────── */
    .empty { padding: 32px; text-align: center; color: var(--bp-fg-3); font-size: 13px; }

    /* ─── Responsive ──────────────────────────────────────────────── */
    @media (max-width: 1300px) {
      .channels-row { grid-template-columns: repeat(3, 1fr); }
    }
    @media (max-width: 1100px) {
      .kpi-rail { grid-template-columns: repeat(2, 1fr); }
      .hero-row, .info-row { grid-template-columns: 1fr; }
      .ports-grid { grid-template-columns: repeat(8, 1fr); }
    }
    @media (max-width: 700px) {
      .dashboard { padding: 0 16px 16px; }
      .kpi-rail { grid-template-columns: 1fr; }
      .channels-row { grid-template-columns: repeat(2, 1fr); }
    }
  `],
})
export class DashboardComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private keycloak = inject(KeycloakService);
  private provys = inject(ProvysService);

  todayDate = signal('');
  todayEyebrow = computed(() => {
    const date = this.todayDate();
    return date ? `${date} · BUGÜNÜN OPERASYONU` : 'BUGÜNÜN OPERASYONU';
  });

  // ─── State ───────────────────────────────────────────────────────────────
  loadingLive = signal(true);
  loadingStudios = signal(true);
  loadingPorts = signal(true);

  liveToday = signal<ProvysLiveTodayDto[]>([]);
  todayStudios = signal<StudioSlot[]>([]);
  ports = signal<IngestPort[]>([]);

  // ─── Kanal kutuları ────────────────────────────────────────────────────────
  readonly channels = PROVYS_CHANNELS;
  /** "Şu an" referansı; 30 sn'de bir tazelenir + SSE snapshot store değişimi. */
  private readonly nowMs = signal(Date.now());
  /** Büyütülmüş (overlay) kanal kutusunun slug'ı; null → kapalı. */
  readonly expandedSlug = signal<ProvysChannelSlug | null>(null);
  /** Büyütülmüş genel panel id'si (hero/vardiya/studio/ports); null → kapalı. */
  readonly expandedPanel = signal<string | null>(null);

  readonly channelBoxes = computed<ChannelBox[]>(() => {
    const now = this.nowMs();
    return this.channels.map((ch) => this.computeBox(ch.slug, ch.displayName, now));
  });
  readonly expandedBox = computed<ChannelBox | null>(() => {
    const slug = this.expandedSlug();
    if (!slug) return null;
    return this.channelBoxes().find((b) => b.slug === slug) ?? null;
  });

  // ─── Group-aware link visibility ─────────────────────────────────────────
  // "Son uyarılar" kartı (audit-log linki) 2026-05-31'de kaldırıldı; canViewAuditLog
  // artık template'de kullanılmıyor — Vardiyam kartı için canViewWeeklyShift kaldı.
  private readonly _userGroups = signal<string[]>([]);
  private readonly isAdmin = computed(() => this._userGroups().includes(GROUP.Admin));
  readonly canViewWeeklyShift = computed(() => this.isAdmin() || this._userGroups().includes(GROUP.SystemEng));

  // ─── KPIs ────────────────────────────────────────────────────────────────
  kpiLiveTotal = computed(() => this.liveToday().length);
  kpiActivePorts = computed(() => this.ports().filter((p) => p.active).length);
  kpiTotalPorts = computed(() => this.ports().length);
  kpiStudios = computed(() => this.todayStudios().length);
  kpiShiftCount = signal('—');
  kpiAlerts = signal('—');

  private clockSub?: Subscription;
  private nowSub?: Subscription;

  ngOnInit() {
    this.updateDate();
    this.clockSub = interval(60_000).subscribe(() => this.updateDate());
    // Kanal kutuları "şu an yayında" hesabı için saat tik'i.
    this.nowSub = interval(30_000).subscribe(() => this.nowMs.set(Date.now()));

    const parsed = this.keycloak.getKeycloakInstance()?.tokenParsed as { groups?: string[] } | undefined;
    this._userGroups.set(parsed?.groups ?? []);

    // Kanal kutuları için Provys snapshot (tüm kanallar, bugün) + canlı SSE akışı.
    void this.provys.loadInitial();
    this.provys.ensureStreaming();

    this.loadLiveToday();
    this.loadStudios();
    this.loadPorts();
  }

  ngOnDestroy() {
    this.clockSub?.unsubscribe();
    this.nowSub?.unsubscribe();
    this.provys.stopStreaming();
  }

  // ─── Kanal kutusu hesabı ────────────────────────────────────────────────────
  /**
   * Bir kanal için "şu an yayında / sıradaki" kutusunu türetir.
   * Kural: şu an PROGRAM/CANLI oynuyorsa onu (live). Şu an ara-yayın
   * (REKLAM/TANITIM/KAMU_SPOTU/DIGER) ise SIRADAKİ PROGRAM/CANLI (upcoming).
   * Hiçbiri yoksa idle. Store boşsa loading.
   */
  private computeBox(slug: ProvysChannelSlug, name: string, now: number): ChannelBox {
    const base = { slug, name, category: null, catLabel: '', catClass: '', title: '', series: null, start: '', end: '' };
    if (!this.provys.hasReceived(slug)) {
      return { ...base, state: 'loading' };
    }
    const items = this.provys.itemsFor(slug)()
      .filter((i) => i.rawKind !== 'ProgramHeader' && !Number.isNaN(Date.parse(i.startAt)))
      .slice()
      .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));

    // Şu an oynayan item (startMs <= now < endMs). endMs = start+duration,
    // duration yoksa bir sonraki item'ın başlangıcı (son item → süresiz/ongoing).
    let current: ProvysItemDto | null = null;
    for (let idx = 0; idx < items.length; idx++) {
      const s = Date.parse(items[idx].startAt);
      const dur = items[idx].durationMs;
      const e = dur != null
        ? s + dur
        : (idx + 1 < items.length ? Date.parse(items[idx + 1].startAt) : Number.POSITIVE_INFINITY);
      if (s <= now && now < e) { current = items[idx]; break; }
    }

    if (current && isProgramLike(current.category)) {
      return this.toBox(base, current, 'live');
    }
    // Ara-yayın (veya boşluk) → sıradaki PROGRAM/CANLI.
    const next = items.find((i) => Date.parse(i.startAt) >= now && isProgramLike(i.category));
    if (next) {
      return this.toBox(base, next, 'upcoming');
    }
    return { ...base, state: 'idle' };
  }

  private toBox(
    base: Omit<ChannelBox, 'state'>,
    item: ProvysItemDto,
    state: 'live' | 'upcoming',
  ): ChannelBox {
    const s = Date.parse(item.startAt);
    const end = item.durationMs != null ? this.hhmmFromMs(s + item.durationMs) : '—';
    return {
      ...base,
      state,
      category: item.category,
      catLabel: PROVYS_CATEGORY_STYLES[item.category]?.label ?? item.category,
      catClass: CATEGORY_CLASS[item.category],
      title: item.title,
      series: item.seriesName,
      start: this.hhmmFromMs(s),
      end,
    };
  }

  private hhmmFromMs(ms: number): string {
    if (!Number.isFinite(ms)) return '—';
    return new Intl.DateTimeFormat('tr-TR', {
      timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ms));
  }

  expand(slug: ProvysChannelSlug): void {
    this.expandedPanel.set(null); // aynı anda iki büyütme olmasın
    this.expandedSlug.set(slug);
  }
  collapse(): void {
    this.expandedSlug.set(null);
  }
  /** Genel kart büyütme (hero/vardiya/studio/ports) — aç/kapat toggle. */
  togglePanel(id: string): void {
    this.expandedSlug.set(null);
    this.expandedPanel.set(this.expandedPanel() === id ? null : id);
  }
  collapsePanel(): void {
    this.expandedPanel.set(null);
  }

  private updateDate() {
    const now = new Date();
    const days = ['Pazar','Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi'];
    const months = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
    this.todayDate.set(`${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()} · ${days[now.getDay()].toUpperCase()}`);
  }

  isoToday(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  private loadLiveToday() {
    this.loadingLive.set(true);
    this.api.get<ProvysLiveTodayDto[]>('/provys/live-today').subscribe({
      next: (res) => {
        this.liveToday.set(res ?? []);
        this.loadingLive.set(false);
      },
      error: () => {
        this.liveToday.set([]);
        this.loadingLive.set(false);
      },
    });
  }

  /** Provys startTimecode "HH:MM:SS:FF" → "HH:MM" (saniye/frame atılır). */
  hhmm(tc: string | null): string {
    return tc && tc.length >= 5 ? tc.slice(0, 5) : '—';
  }

  private loadStudios() {
    this.loadingStudios.set(true);
    const today = this.isoToday();
    const weekStart = this.mondayOf(today);
    this.api.get<{ slots?: Array<{ id: number; day: string; studio: string; startMinute: number; program: string }> }>(
      `/studio-plans/${weekStart}`,
    ).subscribe({
      next: (plan) => {
        const rawToday = (plan?.slots ?? []).filter((s) => s.day === today);
        const byStudio = new Map<string, typeof rawToday>();
        for (const s of rawToday) {
          if (!byStudio.has(s.studio)) byStudio.set(s.studio, []);
          byStudio.get(s.studio)!.push(s);
        }
        const merged: Array<{ id: number; studio: string; program: string; startMinute: number; endMinute: number }> = [];
        for (const [studio, slots] of byStudio) {
          slots.sort((a, b) => a.startMinute - b.startMinute);
          for (const s of slots) {
            const last = merged[merged.length - 1];
            if (last && last.studio === studio && last.program === s.program && last.endMinute === s.startMinute) {
              last.endMinute = s.startMinute + STUDIO_PLAN_SLOT_MINUTES;
            } else {
              merged.push({
                id: s.id,
                studio,
                program: s.program,
                startMinute: s.startMinute,
                endMinute: s.startMinute + STUDIO_PLAN_SLOT_MINUTES,
              });
            }
          }
        }
        merged.sort((a, b) => (a.startMinute - b.startMinute) || a.studio.localeCompare(b.studio));
        const todaySlots: StudioSlot[] = merged.map((m) => ({
          id: m.id,
          studio: m.studio,
          programName: m.program,
          startTime: this.minuteToTime(m.startMinute),
          endTime: this.minuteToTime(m.endMinute),
        }));
        this.todayStudios.set(todaySlots);
        this.loadingStudios.set(false);
      },
      error: () => {
        this.todayStudios.set([]);
        this.loadingStudios.set(false);
      },
    });
  }

  private loadPorts() {
    this.loadingPorts.set(true);
    this.api.get<IngestPort[]>(`/ingest/recording-ports`).subscribe({
      next: (res) => {
        const arr = (res ?? []).map((p) => ({ ...p, active: p.active ?? true }));
        this.ports.set(arr);
        this.loadingPorts.set(false);
      },
      error: () => {
        this.ports.set([]);
        this.loadingPorts.set(false);
      },
    });
  }

  portShortName(name: string): string {
    const parts = name.split(/[-\s]/);
    return parts[parts.length - 1] || name.slice(0, 3);
  }

  /** YYYY-MM-DD → o haftanın pazartesi YYYY-MM-DD. */
  private mondayOf(dateIso: string): string {
    const d = new Date(`${dateIso}T00:00:00`);
    const day = d.getDay();
    const offset = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + offset);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  private minuteToTime(minute: number): string {
    const hour = Math.floor(minute / 60) % 24;
    const min = minute % 60;
    return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
}
