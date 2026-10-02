ALTER TABLE users ADD COLUMN IF NOT EXISTS relationship_type VARCHAR(50) NOT NULL DEFAULT 'Monogâmico(a)';
ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token VARCHAR(512);
ALTER TABLE couples ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMPTZ;
UPDATE couples SET invite_expires_at=NOW()+INTERVAL '7 days' WHERE user2_id IS NULL AND ended_at IS NULL AND invite_expires_at IS NULL;
UPDATE users SET fcm_token=NULL WHERE fcm_token IN
  (SELECT fcm_token FROM users WHERE fcm_token IS NOT NULL GROUP BY fcm_token HAVING COUNT(*)>1);
CREATE UNIQUE INDEX IF NOT EXISTS users_fcm_unique ON users(fcm_token) WHERE fcm_token IS NOT NULL;
-- Normalize option labels used by older clients without deleting records.
UPDATE special_dates SET
  repeat_option=CASE repeat_option WHEN 'Não repete' THEN 'none' WHEN 'Todo ano' THEN 'yearly' ELSE repeat_option END,
  notify_option=CASE notify_option WHEN 'No dia' THEN 'day' WHEN '1 dia antes' THEN '1day_before' WHEN '1 semana antes' THEN '1week_before' ELSE notify_option END
WHERE repeat_option IN ('Não repete','Todo ano') OR notify_option IN ('No dia','1 dia antes','1 semana antes');
CREATE TABLE sync_changes (
  sequence BIGSERIAL PRIMARY KEY, entity TEXT NOT NULL, record_id UUID NOT NULL,
  couple_id UUID, user_id UUID
);
CREATE INDEX sync_changes_couple ON sync_changes(couple_id, sequence);
CREATE INDEX sync_changes_user ON sync_changes(user_id, sequence);
CREATE TABLE mutation_receipts (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mutation_id UUID NOT NULL, payload_hash TEXT NOT NULL,
  PRIMARY KEY(user_id, mutation_id)
);
CREATE FUNCTION chamego_write_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(434343);
  RETURN NULL;
END $$;
CREATE FUNCTION chamego_record_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data JSONB;
BEGIN
  IF TG_OP='DELETE' THEN row_data := to_jsonb(OLD); ELSE row_data := to_jsonb(NEW); END IF;
  INSERT INTO sync_changes(entity,record_id,couple_id,user_id)
  VALUES (TG_TABLE_NAME, (row_data->>'id')::uuid,
    CASE WHEN TG_TABLE_NAME='couples' THEN (row_data->>'id')::uuid ELSE (row_data->>'couple_id')::uuid END,
    CASE WHEN TG_TABLE_NAME='users' THEN (row_data->>'id')::uuid ELSE NULL END);
  RETURN NULL;
END $$;
DO $$
DECLARE name TEXT;
BEGIN
  FOREACH name IN ARRAY ARRAY['users','couples','chamegos','outings','memories','gifts','special_dates'] LOOP
    EXECUTE format('CREATE TRIGGER journal_lock BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION chamego_write_lock()', name);
    EXECUTE format('CREATE TRIGGER journal_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION chamego_record_change()', name);
    IF name='users' THEN
      EXECUTE format('INSERT INTO sync_changes(entity,record_id,couple_id,user_id) SELECT %L,id,couple_id,id FROM %I',name,name);
    ELSIF name='couples' THEN
      EXECUTE format('INSERT INTO sync_changes(entity,record_id,couple_id) SELECT %L,id,id FROM %I',name,name);
    ELSE
      EXECUTE format('INSERT INTO sync_changes(entity,record_id,couple_id) SELECT %L,id,couple_id FROM %I',name,name);
    END IF;
  END LOOP;
END $$;
