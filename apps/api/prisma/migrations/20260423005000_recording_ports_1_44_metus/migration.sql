DELETE FROM "recording_ports";

INSERT INTO "recording_ports" ("name", "sort_order", "active")
SELECT value::text, value * 10, true
FROM generate_series(1, 44) AS value;

INSERT INTO "recording_ports" ("name", "sort_order", "active")
VALUES
  ('Metus1', 450, true),
  ('Metus2', 460, true);
