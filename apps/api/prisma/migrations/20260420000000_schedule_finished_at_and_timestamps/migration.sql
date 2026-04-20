-- Schedule: add finished_at column
ALTER TABLE "schedules" ADD COLUMN "finished_at" TIMESTAMPTZ;

-- Team: add updated_at
ALTER TABLE "teams" ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now();

-- Match: add updated_at
ALTER TABLE "matches" ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now();

-- Channel: add updated_at
ALTER TABLE "channels" ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now();

-- BroadcastType: add created_at / updated_at
ALTER TABLE "broadcast_types" ADD COLUMN "created_at" TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE "broadcast_types" ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now();
