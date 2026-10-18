-- The login throttle counts the last hour's failures from everywhere and purges old ones by
-- time alone; without this index both were a scan of the whole table, which an attacker grows.
CREATE INDEX IF NOT EXISTS login_failures_at ON login_failures (at);
