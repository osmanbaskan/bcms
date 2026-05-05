import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { type MonoTypeOperatorFunction, Observable, retry, throwError, timer } from 'rxjs';
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

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly base = environment.apiUrl;

  constructor(private http: HttpClient) {}

  get<T>(path: string, params?: Record<string, string | number | boolean>): Observable<T> {
    let httpParams = new HttpParams();
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null) httpParams = httpParams.set(k, String(v));
      });
    }
    return this.http.get<T>(`${this.base}${path}`, { params: httpParams }).pipe(retryConfig<T>());
  }

  post<T>(path: string, body: unknown): Observable<T> {
    return this.http.post<T>(`${this.base}${path}`, body);
  }

  put<T>(path: string, body: unknown): Observable<T> {
    return this.http.put<T>(`${this.base}${path}`, body);
  }

  patch<T>(path: string, body: unknown, version?: number): Observable<T> {
    const headers = version !== undefined
      ? new HttpHeaders({ 'If-Match': String(version) })
      : new HttpHeaders();
    return this.http.patch<T>(`${this.base}${path}`, body, { headers });
  }

  postFile<T>(path: string, formData: FormData): Observable<T> {
    return this.http.post<T>(`${this.base}${path}`, formData);
  }

  delete<T>(path: string): Observable<T> {
    return this.http.delete<T>(`${this.base}${path}`);
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
