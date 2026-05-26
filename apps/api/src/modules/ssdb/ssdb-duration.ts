/**
 * SSDB MAM duration + Provys duration frame helpers — saf, sync, deterministic.
 *
 * Sorumluluklar (yalnız bu modül):
 *  - SSDB MEDIA_LINK tcSOM / tcEOM (frame index) -> inclusive frame sayisi.
 *  - Frame sayisi <-> SMPTE "HH:MM:SS:FF" string donusumu (integer-fps).
 *  - Provys row (durationTimecode | durationMs + frameRate) -> frame sayisi.
 *  - Frame karsilastirmasi (tolerance icinde / disinda / bilinmiyor).
 *
 * Bu modul DB / network / env / global state OKUMAZ. Tum fonksiyonlar pure;
 * yan etki yok. Karar mantigi (ProvysMaterialStatus) C2'de ayri dosyada.
 *
 * Inclusive EOM sozlesmesi: SSDB MEDIA_LINK tcEOM materyalin SON frame
 * index'ini gosterir (exclusive degil), bu yuzden:
 *     durationFrames = tcEOM - tcSOM + 1
 * Ornek: tcSOM=0, tcEOM=4464, fps=25 -> 4465 frame -> "00:02:58:15".
 *
 * V1 fps varsayimi: pozitif integer (NDF). Drop-frame (29.97 NTSC) hassas
 * hesabi V2 kapsami; integer fps girilirse matematik tam dogru.
 */

/** SMPTE "HH:MM:SS:FF" — provys.parser SMPTE_TIMECODE_RE ile esdeger. */
const SMPTE_TIMECODE_RE = /^\d{1,3}:\d{1,2}:\d{1,2}:\d{1,3}$/;

/** Default tolerance — bkz K3 (1 frame V1 kilidi). */
export const DEFAULT_TOLERANCE_FRAMES = 1;

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function isNonNegativeInteger(n: unknown): n is number {
  return isFiniteNumber(n) && Number.isInteger(n) && n >= 0;
}

function isPositiveFps(fps: unknown): fps is number {
  // V1: pozitif integer fps. Non-integer (29.97) icin null don;
  // drop-frame V2 scope.
  return isFiniteNumber(fps) && Number.isInteger(fps) && fps > 0;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * SSDB MEDIA_LINK inclusive EOM frame sayisi.
 *
 * Sozlesme: durationFrames = tcEOM - tcSOM + 1.
 * Gecersiz girdi (null/undefined/NaN/Infinity/negatif/non-integer/tcSOM>tcEOM)
 * -> null. Caller karar verir (cache 'duration_unknown' olarak yazar).
 */
export function durationFramesInclusive(
  tcSOM: number | null | undefined,
  tcEOM: number | null | undefined,
): number | null {
  if (!isNonNegativeInteger(tcSOM) || !isNonNegativeInteger(tcEOM)) return null;
  if (tcSOM > tcEOM) return null;
  return tcEOM - tcSOM + 1;
}

/**
 * Frame sayisi -> "HH:MM:SS:FF". Integer fps varsayimi.
 *
 * frames: non-negative integer. fps: pozitif integer. Aksi durumda null.
 * Hours > 99 olabilir; padding 2 hane minimum (24h+ icin 3 hane natural genisler).
 */
export function framesToSmpte(
  frames: number | null | undefined,
  frameRate: number | null | undefined,
): string | null {
  if (!isNonNegativeInteger(frames)) return null;
  if (!isPositiveFps(frameRate)) return null;

  const fps = frameRate as number;
  const framesPerHour = 3600 * fps;
  const framesPerMinute = 60 * fps;

  const totalFrames = frames as number;
  const hh = Math.floor(totalFrames / framesPerHour);
  const remAfterHours = totalFrames - hh * framesPerHour;
  const mm = Math.floor(remAfterHours / framesPerMinute);
  const remAfterMinutes = remAfterHours - mm * framesPerMinute;
  const ss = Math.floor(remAfterMinutes / fps);
  const ff = remAfterMinutes - ss * fps;

  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
}

/**
 * "HH:MM:SS:FF" -> toplam frame sayisi. Integer fps varsayimi.
 *
 * Regex provys.parser SMPTE_TIMECODE_RE ile aynidir; bilesen siniri
 * kontrolu yok (parser tarafi zaten verir). Gecersiz format / fps -> null.
 */
export function smpteToFrames(
  timecode: string | null | undefined,
  frameRate: number | null | undefined,
): number | null {
  if (typeof timecode !== 'string') return null;
  if (!SMPTE_TIMECODE_RE.test(timecode)) return null;
  if (!isPositiveFps(frameRate)) return null;

  const parts = timecode.split(':');
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  const ss = Number(parts[2]);
  const ff = Number(parts[3]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss) || !Number.isFinite(ff)) {
    return null;
  }

  const fps = frameRate as number;
  return ((hh * 3600) + (mm * 60) + ss) * fps + ff;
}

/**
 * Provys row duration (planlanmis BXF suresi) -> frame sayisi.
 *
 * Tercih sirasi (kanonik):
 *   1. durationTimecode varsa: smpteToFrames(durationTimecode, fps).
 *   2. durationMs varsa: round(durationMs / 1000 * fps).
 *   3. her ikisi de yoksa: null.
 *
 * fps default 25 (frameRate null/undefined ise) — provys parser de
 * `smpteTimecodeToMs` icinde ayni default. V2 fps kaynagi BXF/cache'ten
 * gelebilir; bu helper V1 sozlesmesi.
 */
export function provysDurationToFrames(input: {
  durationTimecode: string | null;
  durationMs: number | null;
  frameRate: number | null;
}): number | null {
  const fps = isPositiveFps(input.frameRate) ? (input.frameRate as number) : 25;

  if (typeof input.durationTimecode === 'string' && SMPTE_TIMECODE_RE.test(input.durationTimecode)) {
    const fromTc = smpteToFrames(input.durationTimecode, fps);
    if (fromTc != null) return fromTc;
  }

  if (isFiniteNumber(input.durationMs) && input.durationMs >= 0) {
    return Math.round((input.durationMs / 1000) * fps);
  }

  return null;
}

/**
 * Provys frame ile SSDB frame karsilastirmasi.
 *
 *   |provys - ssdb| <= toleranceFrames  -> 'equal'
 *   biri null/NaN/Infinity              -> 'unknown'
 *   diger durumlarda                    -> 'mismatch'
 *
 * Default tolerance 1 frame (V1 kilidi — inclusive EOM yuvarlama farki).
 */
export function compareDurations(
  provysFrames: number | null,
  ssdbFrames: number | null,
  toleranceFrames: number = DEFAULT_TOLERANCE_FRAMES,
): 'equal' | 'mismatch' | 'unknown' {
  if (!isFiniteNumber(provysFrames) || !isFiniteNumber(ssdbFrames)) return 'unknown';
  const tol = isFiniteNumber(toleranceFrames) && toleranceFrames >= 0
    ? toleranceFrames
    : DEFAULT_TOLERANCE_FRAMES;
  const diff = Math.abs(provysFrames - ssdbFrames);
  return diff <= tol ? 'equal' : 'mismatch';
}
