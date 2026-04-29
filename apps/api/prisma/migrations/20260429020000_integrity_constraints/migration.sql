CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM schedules a
    JOIN schedules b
      ON a.id < b.id
     AND a.channel_id = b.channel_id
     AND a.status <> 'CANCELLED'
     AND b.status <> 'CANCELLED'
     AND tstzrange(a.start_time, a.end_time, '[)') && tstzrange(b.start_time, b.end_time, '[)')
    WHERE a.channel_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Cannot add schedules_no_channel_time_overlap: overlapping non-cancelled schedules exist';
  END IF;
END $$;

ALTER TABLE schedules
  DROP CONSTRAINT IF EXISTS schedules_no_channel_time_overlap;

ALTER TABLE schedules
  ADD CONSTRAINT schedules_no_channel_time_overlap
  EXCLUDE USING gist (
    channel_id WITH =,
    tstzrange(start_time, end_time, '[)') WITH &&
  )
  WHERE (channel_id IS NOT NULL AND status <> 'CANCELLED');

CREATE UNIQUE INDEX IF NOT EXISTS incidents_open_signal_loss_channel_uidx
  ON incidents ((metadata->>'channelId'))
  WHERE resolved = false
    AND event_type = 'SIGNAL_LOSS'
    AND metadata ? 'channelId';
