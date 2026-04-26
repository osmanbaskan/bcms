import fs from 'node:fs';
import path from 'node:path';

export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mxf', '.avi', '.ts', '.mts', '.m2ts', '.mkv', '.wmv']);

const DEFAULT_ALLOWED_ROOTS = [
  process.env.WATCH_FOLDER ?? './tmp/watch',
  process.env.OPTA_DIR ?? '/mnt/opta-backups',
];

function resolveRoot(root: string): string {
  const resolved = path.resolve(root.trim());
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function allowedRoots(): string[] {
  const raw = process.env.INGEST_ALLOWED_ROOTS;
  const roots = raw
    ? raw.split(',').map((entry) => entry.trim()).filter(Boolean)
    : [];
  return (roots.length > 0 ? roots : DEFAULT_ALLOWED_ROOTS).map(resolveRoot);
}

function isInsideRoot(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function validateIngestSourcePath(sourcePath: string): string {
  const candidate = path.resolve(sourcePath);
  let realPath: string;

  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) {
      throw Object.assign(new Error('Ingest kaynağı dosya olmalıdır'), { statusCode: 400 });
    }
    realPath = fs.realpathSync(candidate);
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode) throw err;
    throw Object.assign(new Error('Ingest kaynak dosyası bulunamadı'), { statusCode: 400 });
  }

  const ext = path.extname(realPath).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) {
    throw Object.assign(new Error('Ingest kaynak dosya uzantısı desteklenmiyor'), { statusCode: 415 });
  }

  const roots = allowedRoots();
  if (!roots.some((root) => isInsideRoot(realPath, root))) {
    throw Object.assign(new Error('Ingest kaynak yolu izinli dizinlerin dışında'), { statusCode: 403 });
  }

  return realPath;
}
