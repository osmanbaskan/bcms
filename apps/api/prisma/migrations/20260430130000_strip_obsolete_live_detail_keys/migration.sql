-- Tahta/Kaynak ve Yedek Kaynak bölümleri Teknik Detay dialog'undan kaldırıldı.
-- Bu 16 key artık UI tarafından yazılmıyor; mevcut kayıtlardan da temizleniyor.
-- Defansif, idempotent: bu key'ler zaten yoksa no-op olur.

UPDATE schedules
SET metadata = jsonb_set(
  metadata,
  '{liveDetails}',
  (metadata->'liveDetails') - ARRAY[
    -- 'Tahta / Kaynak' grubu (Edit dialog ile paylaşılmayanlar)
    'upConverter',
    'offTubeResource',
    'recordLocation3',
    'hdvgResource',
    'intercom',
    'dailyReportShortNotes',
    -- 'Yedek Kaynak' grubu (tamamı UI'dan kaldırıldı)
    'backupUpConverter',
    'backupOffTube',
    'backupRecordLocation',
    'backupIrd',
    'backupFiber',
    'backupVirtual',
    'backupHdvg',
    'backupIntercom',
    'backupTie',
    'backupDemod'
  ]::text[]
)
WHERE metadata ? 'liveDetails'
  AND jsonb_typeof(metadata->'liveDetails') = 'object'
  AND (metadata->'liveDetails') ?| ARRAY[
    'upConverter','offTubeResource','recordLocation3','hdvgResource','intercom','dailyReportShortNotes',
    'backupUpConverter','backupOffTube','backupRecordLocation','backupIrd','backupFiber','backupVirtual',
    'backupHdvg','backupIntercom','backupTie','backupDemod'
  ];
