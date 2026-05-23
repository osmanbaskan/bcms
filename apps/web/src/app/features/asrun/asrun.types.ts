// Asrun (as-run playout kaydı) tipleri — shared'dan re-export.
// Provys'ten ayrı domain; aynı kanal kataloğu paylaşılır ama route/service
// ayrıdır.
export {
  ASRUN_CHANNELS,
  ASRUN_CHANNEL_SLUGS,
  ASRUN_CATEGORIES,
  type AsrunChannelSlug,
  type AsrunCategory,
  type AsrunItemDto,
  PROVYS_CATEGORY_STYLES,
  type ProvysCategoryStyle,
} from '@bcms/shared';
