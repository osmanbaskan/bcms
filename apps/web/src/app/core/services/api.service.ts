import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { type MonoTypeOperatorFunction, Observable, retry, shareReplay, throwError, timer } from 'rxjs';
import { tap } from 'rxjs/operators';
import { environment } from '../../../environments/environment';

// ORTA-FE-2.4.1 fix (2026-05-04): GET istekleri için transient retry.
// Network hiccup veya 503 (Service Unavailable / JWKS down) sonrası
// kullanıcının manuel reload yapması yerine sessiz retry. POST/PATCH/DELETE
// retry edilmez (idempotent değiller — duplicate side-effect riski).
const RETRY_COUNT = 2;
const RETRY_DELAY_MS = 600;
function retryConfig<T>(): MonoTypeOperatorFunction<T> {
  return retry<T>({
    count: RETRY_COUNT,
    delay: (err, attempt) => {
      // 0 (network err), 502, 503, 504 → retry; 4xx → fail-fast (caller handle).
      if (err instanceof HttpErrorResponse) {
        if (err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504) {
          return timer(RETRY_DELAY_MS * attempt);
        }
      }
      return throwError(() => err);
    },
  });
}

// ORTA-FE-2.4.2 fix (2026-05-04): GET cache (catalog endpoints).
// /channels/catalog, /broadcast-types, /studio-plans/catalog vb. 5+ component
// tarafından her tab açılışında fetch ediliyor. Bu set "reference data" — TTL
// içinde yeniden çekmek gereksiz. shareReplay-tabanlı 60sn TTL cache.
//
// Sadece GET için; mutation invalidate eder. Path-bazlı match: regex patterns.
// Cache miss → fetch + cache; hit + içinde → cached observable; expired → drop.
const CACHE_TTL_MS = 60_000;
const CACHEABLE_PATHS: RegExp[] = [
  /^\/channels\/catalog$/,
  /^\/broadcast-types$/,
  /^\/studio-plans\/catalog$/,
  /^\/users\/groups$/,
  /^\/opta\/competitions$/,
  /^\/opta\/fixture-competitions$/,
];

interface CacheEntry<T = unknown> {
  observable: Observable<T>;
  expiresAt: number;
}

function isCacheable(path: string): boolean {
  return CACHEABLE_PATHS.some((re) => re.test(path));
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly base = environment.apiUrl;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private http: HttpClient) {}

  /** Cache invalidation — mutation sonrası ilgili path'leri temizle. */
  invalidateCache(pathPrefix?: string): void {
    if (!pathPrefix) {
      this.cache.clear();
      return;
    }
    for (const key of this.cache.keys()) {
      if (key.startsWith(pathPrefix)) this.cache.delete(key);
    }
  }

  get<T>(path: string, params?: Record<string, string | number | boolean>): Observable<T> {
    let httpParams = new HttpParams();
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null) httpParams = httpParams.set(k, String(v));
      });
    }

    // Cache lookup (sadece query param'sız catalog GET'leri)
    if (isCacheable(path) && (!params || Object.keys(params).length === 0)) {
      const now = Date.now();
      const cached = this.cache.get(path);
      if (cached && now < cached.expiresAt) {
        return cached.observable as Observable<T>;
      }
      // Expired veya yok → fetch + share + cache.
      const obs = this.http.get<T>(`${this.base}${path}`, { params: httpParams }).pipe(
        retryConfig<T>(),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
      this.cache.set(path, { observable: obs, expiresAt: now + CACHE_TTL_MS });
      return obs;
    }

    return this.http.get<T>(`${this.base}${path}`, { params: httpParams }).pipe(retryConfig<T>());
  }

  // Mutation metodları cache'i invalidate eder (path prefix match).
  // Örn. POST /channels → /channels prefix'li cache'leri sil (catalog dahil).
  post<T>(path: string, body: unknown): Observable<T> {
    return this.http.post<T>(`${this.base}${path}`, body).pipe(
      tap(() => this.invalidateCache(this.cacheRoot(path))),
    );
  }

  put<T>(path: string, body: unknown): Observable<T> {
    return this.http.put<T>(`${this.base}${path}`, body).pipe(
      tap(() => this.invalidateCache(this.cacheRoot(path))),
    );
  }

  patch<T>(path: string, body: unknown, version?: number): Observable<T> {
    const headers = version !== undefined
      ? new HttpHeaders({ 'If-Match': String(version) })
      : new HttpHeaders();
    return this.http.patch<T>(`${this.base}${path}`, body, { headers }).pipe(
      tap(() => this.invalidateCache(this.cacheRoot(path))),
    );
  }

  postFile<T>(path: string, formData: FormData): Observable<T> {
    return this.http.post<T>(`${this.base}${path}`, formData).pipe(
      tap(() => this.invalidateCache(this.cacheRoot(path))),
    );
  }

  /** Live-plan canonical paritesi (2026-05-10): If-Match optional support.
   *  Mevcut callers `version` geçmeden çağırır (backward compat); live-plan
   *  DELETE/PATCH gibi optimistic-locked endpoint'ler `version` ile çağrılır. */
  delete<T>(path: string, version?: number): Observable<T> {
    const headers = version !== undefined
      ? new HttpHeaders({ 'If-Match': String(version) })
      : new HttpHeaders();
    return this.http.delete<T>(`${this.base}${path}`, { headers }).pipe(
      tap(() => this.invalidateCache(this.cacheRoot(path))),
    );
  }

  /** Path'in ilk segment'ini cache key prefix olarak al (örn. /channels/123 → /channels). */
  private cacheRoot(path: string): string {
    const m = path.match(/^\/[^/]+/);
    return m ? m[0] : path;
  }

  getBlob(path: string, params?: Record<string, string | number | boolean>): Observable<Blob> {
    let httpParams = new HttpParams();
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null) httpParams = httpParams.set(k, String(v));
      });
    }
    // GET — retry uygulanır
    return this.http.get(`${this.base}${path}`, { params: httpParams, responseType: 'blob' }).pipe(retryConfig<Blob>());
  }
}
