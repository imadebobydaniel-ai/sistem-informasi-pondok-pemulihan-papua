-- Disposable local PostgreSQL candidate only. Never apply to hosted DB.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE ROLE schedule_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE schedule_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE schedule_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA sipapua_schedule AUTHORIZATION schedule_owner;
CREATE SCHEMA sipapua_private AUTHORIZATION schedule_owner;
REVOKE ALL ON SCHEMA sipapua_schedule, sipapua_private FROM PUBLIC;
GRANT USAGE ON SCHEMA sipapua_schedule TO schedule_writer, schedule_runtime;
GRANT USAGE ON SCHEMA sipapua_private TO schedule_writer;

CREATE TABLE sipapua_schedule.resources (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('venue','person')),
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE sipapua_schedule.occurrences (
  id uuid PRIMARY KEY,
  revision integer NOT NULL CHECK (revision >= 1),
  status text NOT NULL CHECK (status IN ('draft','published','cancelled')),
  area text NOT NULL CHECK (area IN ('ABE','STN','DYO','ARS1','ARS2')),
  category text NOT NULL CHECK (category IN ('sunday-worship','other-ministry')),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  service_date date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  venue_id uuid NOT NULL REFERENCES sipapua_schedule.resources(id),
  leader_id uuid NOT NULL REFERENCES sipapua_schedule.resources(id),
  officers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(officers) = 'array'),
  theme text NOT NULL CHECK (length(trim(theme)) BETWEEN 1 AND 150),
  scripture text NOT NULL DEFAULT '',
  public_notes text NOT NULL DEFAULT '',
  internal_notes text NOT NULL DEFAULT '',
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (start_time < end_time),
  CHECK ((status = 'draft' AND published_at IS NULL) OR (status IN ('published','cancelled') AND published_at IS NOT NULL))
);

CREATE TABLE sipapua_schedule.member_projection (
  id uuid PRIMARY KEY REFERENCES sipapua_schedule.occurrences(id),
  revision integer NOT NULL CHECK (revision >= 1),
  status text NOT NULL CHECK (status IN ('published','cancelled')),
  area text NOT NULL CHECK (area IN ('abepura','sentani','doyo','arso-1','arso-2')),
  category text NOT NULL CHECK (category IN ('sunday-worship','other-ministry')),
  title text NOT NULL,
  service_date date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  venue_name text NOT NULL,
  leader_name text NOT NULL,
  officers jsonb NOT NULL CHECK (jsonb_typeof(officers) = 'array'),
  theme text NOT NULL CHECK (length(trim(theme)) BETWEEN 1 AND 150),
  scripture text NOT NULL,
  public_notes text NOT NULL,
  published_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (start_time < end_time)
);

CREATE TABLE sipapua_schedule.audit (
  operation_id uuid PRIMARY KEY,
  occurrence_id uuid NOT NULL REFERENCES sipapua_schedule.occurrences(id),
  revision integer NOT NULL,
  actor_uid text NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('master','super_admin')),
  action text NOT NULL CHECK (action IN ('create_draft','edit_draft','revise_published','publish','cancel')),
  from_status text,
  to_status text NOT NULL,
  intent_digest text NOT NULL,
  result jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  UNIQUE (occurrence_id, revision)
);

CREATE TABLE sipapua_schedule.reservations (
  occurrence_id uuid NOT NULL REFERENCES sipapua_schedule.occurrences(id),
  resource_id uuid NOT NULL REFERENCES sipapua_schedule.resources(id),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  CHECK (start_at < end_at),
  PRIMARY KEY (occurrence_id, resource_id),
  EXCLUDE USING gist (resource_id WITH =, tstzrange(start_at,end_at,'[)') WITH &&)
);

CREATE TABLE sipapua_private.writer_secret (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  secret bytea NOT NULL CHECK (octet_length(secret) = 32)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['resources','occurrences','member_projection','audit','reservations'] LOOP
    EXECUTE format('ALTER TABLE sipapua_schedule.%I OWNER TO schedule_owner', t);
    EXECUTE format('ALTER TABLE sipapua_schedule.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE sipapua_schedule.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY writer_only ON sipapua_schedule.%I TO schedule_writer USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
ALTER TABLE sipapua_private.writer_secret OWNER TO schedule_owner;
ALTER TABLE sipapua_private.writer_secret ENABLE ROW LEVEL SECURITY;
ALTER TABLE sipapua_private.writer_secret FORCE ROW LEVEL SECURITY;
CREATE POLICY writer_secret_read ON sipapua_private.writer_secret TO schedule_writer USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON sipapua_schedule.resources,
  sipapua_schedule.occurrences, sipapua_schedule.member_projection,
  sipapua_schedule.reservations TO schedule_writer;
GRANT SELECT, INSERT ON sipapua_schedule.audit TO schedule_writer;
GRANT SELECT ON sipapua_private.writer_secret TO schedule_writer;
REVOKE ALL ON ALL TABLES IN SCHEMA sipapua_schedule, sipapua_private FROM PUBLIC, schedule_runtime;

CREATE FUNCTION sipapua_schedule.reject_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='audit_append_only'; END $$;
ALTER FUNCTION sipapua_schedule.reject_audit_mutation() OWNER TO schedule_owner;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON sipapua_schedule.audit
FOR EACH ROW EXECUTE FUNCTION sipapua_schedule.reject_audit_mutation();

CREATE FUNCTION sipapua_private.assert_actor(p jsonb, p_action text)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, sipapua_private AS $$
DECLARE v_secret bytea; v_uid text; v_role text; v_op text; v_mac text; v_expected bytea;
BEGIN
  v_uid := p->>'actorUid'; v_role := p->>'actorRole'; v_op := p->>'operationId'; v_mac := p->>'actorMac';
  IF v_uid IS NULL OR length(v_uid) NOT BETWEEN 1 AND 128 OR v_uid <> trim(v_uid)
     OR v_role IS NULL OR v_role NOT IN ('master','super_admin') OR v_op IS NULL OR v_op !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p->>'action' <> p_action OR v_mac IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='writer_attestation_invalid';
  END IF;
  SELECT secret INTO v_secret FROM sipapua_private.writer_secret WHERE singleton = true;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='writer_attestation_unavailable'; END IF;
  v_expected := public.hmac(convert_to(v_uid || E'\n' || v_role || E'\n' || lower(v_op) || E'\n' || p_action,'UTF8'),v_secret,'sha256');
  BEGIN
    IF decode(v_mac,'base64') <> v_expected THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='writer_attestation_invalid'; END IF;
  EXCEPTION WHEN invalid_parameter_value THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='writer_attestation_invalid';
  END;
END $$;
ALTER FUNCTION sipapua_private.assert_actor(jsonb,text) OWNER TO schedule_writer;
REVOKE ALL ON FUNCTION sipapua_private.assert_actor(jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sipapua_private.assert_actor(jsonb,text) TO schedule_writer;

CREATE FUNCTION sipapua_schedule.api_save_draft(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, sipapua_schedule, sipapua_private AS $$
DECLARE v_id uuid; v_op uuid; v_rev integer; v_expected integer; v_action text; v_digest text;
  v_old sipapua_schedule.occurrences%ROWTYPE; v_prior_audit sipapua_schedule.audit%ROWTYPE; v_schedule jsonb; v_now timestamptz; v_result jsonb;
  v_people uuid[]; v_officer jsonb; v_person uuid; v_exists boolean; v_start timestamptz; v_end timestamptz;
  v_venue text; v_leader text; v_public_officers jsonb; v_status text;
BEGIN
  PERFORM sipapua_private.assert_actor(p,'save');
  v_op := (p->>'operationId')::uuid; v_expected := (p->>'expectedRevision')::integer; v_schedule := p->'schedule';
  IF v_expected < 0 OR jsonb_typeof(v_schedule) <> 'object' OR p - ARRAY['actorUid','actorRole','operationId','actorMac','action','expectedRevision','schedule'] <> '{}'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid_request';
  END IF;
  IF v_schedule - ARRAY['id','area','category','title','date','startTime','endTime','venueId','leaderId','officers','theme','scripture','publicNotes','internalNotes'] <> '{}'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid_schedule_fields';
  END IF;
  IF coalesce(v_schedule->>'id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR v_schedule->>'area' NOT IN ('ABE','STN','DYO','ARS1','ARS2')
    OR v_schedule->>'category' NOT IN ('sunday-worship','other-ministry')
    OR length(trim(coalesce(v_schedule->>'title',''))) NOT BETWEEN 1 AND 160
    OR coalesce(v_schedule->>'date','') !~ '^\d{4}-\d{2}-\d{2}$'
    OR coalesce(v_schedule->>'startTime','') !~ '^([01]\d|2[0-3]):[0-5]\d$'
    OR coalesce(v_schedule->>'endTime','') !~ '^([01]\d|2[0-3]):[0-5]\d$'
    OR v_schedule->>'startTime' >= v_schedule->>'endTime'
    OR coalesce(v_schedule->>'venueId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR coalesce(v_schedule->>'leaderId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR length(trim(coalesce(v_schedule->>'theme',''))) NOT BETWEEN 1 AND 150
    OR jsonb_typeof(coalesce(v_schedule->'officers','[]'::jsonb)) <> 'array'
    OR jsonb_array_length(coalesce(v_schedule->'officers','[]'::jsonb)) > 20 THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid_schedule';
  END IF;
  v_id := (v_schedule->>'id')::uuid;
  SELECT * INTO v_old FROM sipapua_schedule.occurrences WHERE id = v_id FOR UPDATE;
  v_exists := FOUND;
  SELECT * INTO v_prior_audit FROM sipapua_schedule.audit WHERE operation_id=v_op;
  IF FOUND THEN
    IF v_prior_audit.action NOT IN ('create_draft','edit_draft','revise_published') THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='operation_id_reused'; END IF;
    v_action := v_prior_audit.action;
    v_digest := encode(public.digest(convert_to(v_action || ':' || v_expected::text || ':' || v_schedule::text,'UTF8'),'sha256'),'hex');
    IF v_prior_audit.occurrence_id=v_id AND v_prior_audit.actor_uid=p->>'actorUid' AND v_prior_audit.actor_role=p->>'actorRole' AND v_prior_audit.intent_digest=v_digest THEN
      RETURN v_prior_audit.result || jsonb_build_object('replayed',true);
    END IF;
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='operation_id_reused';
  END IF;
  IF v_expected = 0 THEN
    IF v_exists THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='schedule_exists'; END IF;
    v_action := 'create_draft'; v_rev := 1; v_status := 'draft';
  ELSE
    IF NOT v_exists OR v_old.revision <> v_expected OR v_old.status NOT IN ('draft','published') THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='stale_or_non_editable';
    END IF;
    v_action := CASE WHEN v_old.status = 'published' THEN 'revise_published' ELSE 'edit_draft' END;
    v_rev := v_old.revision + 1; v_status := v_old.status;
  END IF;
  v_digest := encode(public.digest(convert_to(v_action || ':' || v_expected::text || ':' || v_schedule::text,'UTF8'),'sha256'),'hex');
  IF NOT EXISTS(SELECT 1 FROM sipapua_schedule.resources r WHERE r.id=(v_schedule->>'venueId')::uuid AND r.kind='venue' AND r.active)
    OR NOT EXISTS(SELECT 1 FROM sipapua_schedule.resources r WHERE r.id=(v_schedule->>'leaderId')::uuid AND r.kind='person' AND r.active) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='unknown_resource';
  END IF;
  v_people := ARRAY[(v_schedule->>'leaderId')::uuid];
  FOR v_officer IN SELECT value FROM jsonb_array_elements(coalesce(v_schedule->'officers','[]'::jsonb)) LOOP
    IF jsonb_typeof(v_officer) <> 'object' OR v_officer - ARRAY['personId','role'] <> '{}'::jsonb
      OR coalesce(v_officer->>'personId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR length(trim(coalesce(v_officer->>'role',''))) NOT BETWEEN 1 AND 80 THEN
      RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid_officer';
    END IF;
    v_person := (v_officer->>'personId')::uuid;
    IF v_person = ANY(v_people) OR NOT EXISTS(SELECT 1 FROM sipapua_schedule.resources r WHERE r.id=v_person AND r.kind='person' AND r.active) THEN
      RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='duplicate_or_unknown_officer';
    END IF;
    v_people := array_append(v_people,v_person);
  END LOOP;
  v_now := clock_timestamp();
  IF v_status = 'published' THEN
    v_start := ((v_schedule->>'date')::date + (v_schedule->>'startTime')::time) AT TIME ZONE 'Asia/Jayapura';
    v_end := ((v_schedule->>'date')::date + (v_schedule->>'endTime')::time) AT TIME ZONE 'Asia/Jayapura';
    IF v_start >= v_end THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid_wit_range'; END IF;
    SELECT display_name INTO v_venue FROM sipapua_schedule.resources WHERE id=(v_schedule->>'venueId')::uuid;
    SELECT display_name INTO v_leader FROM sipapua_schedule.resources WHERE id=(v_schedule->>'leaderId')::uuid;
    SELECT coalesce(jsonb_agg(jsonb_build_object('name',r.display_name,'role',o.value->>'role') ORDER BY o.ord),'[]'::jsonb) INTO v_public_officers
      FROM jsonb_array_elements(coalesce(v_schedule->'officers','[]'::jsonb)) WITH ORDINALITY o(value,ord)
      JOIN sipapua_schedule.resources r ON r.id=(o.value->>'personId')::uuid;
    DELETE FROM sipapua_schedule.reservations WHERE occurrence_id=v_id;
    INSERT INTO sipapua_schedule.reservations(occurrence_id,resource_id,start_at,end_at)
      SELECT v_id,x,v_start,v_end FROM (SELECT (v_schedule->>'venueId')::uuid x UNION SELECT unnest(v_people)) q;
    UPDATE sipapua_schedule.occurrences SET revision=v_rev,area=v_schedule->>'area',category=v_schedule->>'category',title=trim(v_schedule->>'title'),
      service_date=(v_schedule->>'date')::date,start_time=(v_schedule->>'startTime')::time,end_time=(v_schedule->>'endTime')::time,
      venue_id=(v_schedule->>'venueId')::uuid,leader_id=(v_schedule->>'leaderId')::uuid,officers=coalesce(v_schedule->'officers','[]'::jsonb),
      theme=coalesce(v_schedule->>'theme',''),scripture=coalesce(v_schedule->>'scripture',''),public_notes=coalesce(v_schedule->>'publicNotes',''),
      internal_notes=coalesce(v_schedule->>'internalNotes',''),updated_at=v_now WHERE id=v_id AND status='published' AND revision=v_expected;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='stale_published_schedule'; END IF;
    UPDATE sipapua_schedule.member_projection SET revision=v_rev,area=CASE v_schedule->>'area' WHEN 'ABE' THEN 'abepura' WHEN 'STN' THEN 'sentani' WHEN 'DYO' THEN 'doyo' WHEN 'ARS1' THEN 'arso-1' ELSE 'arso-2' END,
      category=v_schedule->>'category',title=trim(v_schedule->>'title'),service_date=(v_schedule->>'date')::date,start_time=(v_schedule->>'startTime')::time,
      end_time=(v_schedule->>'endTime')::time,venue_name=v_venue,leader_name=v_leader,officers=v_public_officers,theme=coalesce(v_schedule->>'theme',''),
      scripture=coalesce(v_schedule->>'scripture',''),public_notes=coalesce(v_schedule->>'publicNotes',''),updated_at=v_now
      WHERE id=v_id AND published_at=v_old.published_at;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='projection_missing'; END IF;
    v_result := jsonb_build_object('id',v_id,'revision',v_rev,'status','published','publishedAt',v_old.published_at);
  ELSE
    INSERT INTO sipapua_schedule.occurrences(id,revision,status,area,category,title,service_date,start_time,end_time,venue_id,leader_id,officers,theme,scripture,public_notes,internal_notes,updated_at)
    VALUES(v_id,v_rev,'draft',v_schedule->>'area',v_schedule->>'category',trim(v_schedule->>'title'),(v_schedule->>'date')::date,(v_schedule->>'startTime')::time,(v_schedule->>'endTime')::time,(v_schedule->>'venueId')::uuid,(v_schedule->>'leaderId')::uuid,coalesce(v_schedule->'officers','[]'::jsonb),coalesce(v_schedule->>'theme',''),coalesce(v_schedule->>'scripture',''),coalesce(v_schedule->>'publicNotes',''),coalesce(v_schedule->>'internalNotes',''),v_now)
    ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision, area=EXCLUDED.area, category=EXCLUDED.category, title=EXCLUDED.title, service_date=EXCLUDED.service_date, start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time, venue_id=EXCLUDED.venue_id, leader_id=EXCLUDED.leader_id, officers=EXCLUDED.officers, theme=EXCLUDED.theme, scripture=EXCLUDED.scripture, public_notes=EXCLUDED.public_notes, internal_notes=EXCLUDED.internal_notes, updated_at=v_now;
    v_result := jsonb_build_object('id',v_id,'revision',v_rev,'status','draft');
  END IF;
  INSERT INTO sipapua_schedule.audit(operation_id,occurrence_id,revision,actor_uid,actor_role,action,from_status,to_status,intent_digest,result,recorded_at)
  VALUES(v_op,v_id,v_rev,p->>'actorUid',p->>'actorRole',v_action,CASE WHEN v_expected=0 THEN NULL ELSE v_old.status END,v_status,v_digest,v_result,v_now);
  RETURN v_result;
END $$;

CREATE FUNCTION sipapua_schedule.api_publish(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, sipapua_schedule, sipapua_private AS $$
DECLARE v_id uuid; v_op uuid; v_expected integer; v_s sipapua_schedule.occurrences%ROWTYPE; v_now timestamptz; v_rev integer;
  v_start timestamptz; v_end timestamptz; v_people uuid[]; v_item jsonb; v_digest text; v_result jsonb; v_venue text; v_leader text; v_public_officers jsonb;
BEGIN
  PERFORM sipapua_private.assert_actor(p,'publish');
  v_id := (p->>'scheduleId')::uuid; v_op := (p->>'operationId')::uuid; v_expected := (p->>'expectedRevision')::integer;
  IF p - ARRAY['actorUid','actorRole','operationId','actorMac','action','scheduleId','expectedRevision'] <> '{}'::jsonb OR v_expected < 1 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid_request'; END IF;
  v_digest := encode(public.digest(convert_to('publish:'||v_id::text||':'||v_expected::text,'UTF8'),'sha256'),'hex');
  SELECT * INTO v_s FROM sipapua_schedule.occurrences WHERE id=v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='schedule_not_found'; END IF;
  SELECT result INTO v_result FROM sipapua_schedule.audit a WHERE a.operation_id=v_op AND a.action='publish' AND a.occurrence_id=v_id AND a.revision=v_expected+1 AND a.actor_uid=p->>'actorUid' AND a.actor_role=p->>'actorRole' AND a.intent_digest=v_digest;
  IF FOUND THEN RETURN v_result || jsonb_build_object('replayed',true); END IF;
  IF EXISTS(SELECT 1 FROM sipapua_schedule.audit a WHERE a.operation_id=v_op) THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='operation_id_reused'; END IF;
  IF v_s.status <> 'draft' OR v_s.revision <> v_expected THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='stale_or_non_draft'; END IF;
  IF length(trim(coalesce(v_s.theme,''))) NOT BETWEEN 1 AND 150 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='sermon_theme_required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM sipapua_schedule.resources WHERE id=v_s.venue_id AND kind='venue' AND active) OR NOT EXISTS(SELECT 1 FROM sipapua_schedule.resources WHERE id=v_s.leader_id AND kind='person' AND active) THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='unknown_resource'; END IF;
  v_people := ARRAY[v_s.leader_id];
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_s.officers) LOOP
    IF jsonb_typeof(v_item) <> 'object' OR v_item - ARRAY['personId','role'] <> '{}'::jsonb OR coalesce(v_item->>'personId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR length(trim(coalesce(v_item->>'role',''))) NOT BETWEEN 1 AND 80 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid_officer'; END IF;
    IF (v_item->>'personId')::uuid = ANY(v_people) THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='duplicate_officer'; END IF;
    v_people := array_append(v_people,(v_item->>'personId')::uuid);
    IF NOT EXISTS(SELECT 1 FROM sipapua_schedule.resources WHERE id=(v_item->>'personId')::uuid AND kind='person' AND active) THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='unknown_officer'; END IF;
  END LOOP;
  v_start := (v_s.service_date + v_s.start_time) AT TIME ZONE 'Asia/Jayapura';
  v_end := (v_s.service_date + v_s.end_time) AT TIME ZONE 'Asia/Jayapura';
  IF v_start >= v_end THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid_wit_range'; END IF;
  v_now := clock_timestamp(); v_rev := v_s.revision + 1;
  SELECT display_name INTO v_venue FROM sipapua_schedule.resources WHERE id=v_s.venue_id;
  SELECT display_name INTO v_leader FROM sipapua_schedule.resources WHERE id=v_s.leader_id;
  INSERT INTO sipapua_schedule.reservations(occurrence_id,resource_id,start_at,end_at)
  SELECT v_id,x,v_start,v_end FROM (SELECT v_s.venue_id x UNION SELECT unnest(v_people)) q;
  SELECT coalesce(jsonb_agg(jsonb_build_object('name',r.display_name,'role',o.value->>'role') ORDER BY o.ord),'[]'::jsonb) INTO v_public_officers
  FROM jsonb_array_elements(v_s.officers) WITH ORDINALITY o(value,ord) JOIN sipapua_schedule.resources r ON r.id=(o.value->>'personId')::uuid;
  UPDATE sipapua_schedule.occurrences SET status='published',revision=v_rev,published_at=coalesce(published_at,v_now),updated_at=v_now WHERE id=v_id;
  INSERT INTO sipapua_schedule.member_projection(id,revision,status,area,category,title,service_date,start_time,end_time,venue_name,leader_name,officers,theme,scripture,public_notes,published_at,updated_at)
  VALUES(v_id,v_rev,'published',CASE v_s.area WHEN 'ABE' THEN 'abepura' WHEN 'STN' THEN 'sentani' WHEN 'DYO' THEN 'doyo' WHEN 'ARS1' THEN 'arso-1' ELSE 'arso-2' END,v_s.category,v_s.title,v_s.service_date,v_s.start_time,v_s.end_time,v_venue,v_leader,v_public_officers,v_s.theme,v_s.scripture,v_s.public_notes,coalesce(v_s.published_at,v_now),v_now);
  v_result := jsonb_build_object('id',v_id,'revision',v_rev,'status','published','publishedAt',coalesce(v_s.published_at,v_now));
  INSERT INTO sipapua_schedule.audit(operation_id,occurrence_id,revision,actor_uid,actor_role,action,from_status,to_status,intent_digest,result,recorded_at)
  VALUES(v_op,v_id,v_rev,p->>'actorUid',p->>'actorRole','publish','draft','published',v_digest,v_result,v_now);
  RETURN v_result;
END $$;

CREATE FUNCTION sipapua_schedule.api_cancel(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, sipapua_schedule, sipapua_private AS $$
DECLARE v_id uuid; v_op uuid; v_expected integer; v_s sipapua_schedule.occurrences%ROWTYPE; v_now timestamptz; v_rev integer; v_digest text; v_result jsonb;
BEGIN
  PERFORM sipapua_private.assert_actor(p,'cancel');
  v_id := (p->>'scheduleId')::uuid; v_op := (p->>'operationId')::uuid; v_expected := (p->>'expectedRevision')::integer;
  IF p - ARRAY['actorUid','actorRole','operationId','actorMac','action','scheduleId','expectedRevision'] <> '{}'::jsonb OR v_expected < 1 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid_request'; END IF;
  v_digest := encode(public.digest(convert_to('cancel:'||v_id::text||':'||v_expected::text,'UTF8'),'sha256'),'hex');
  SELECT * INTO v_s FROM sipapua_schedule.occurrences WHERE id=v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='schedule_not_found'; END IF;
  SELECT result INTO v_result FROM sipapua_schedule.audit a WHERE a.operation_id=v_op AND a.action='cancel' AND a.occurrence_id=v_id AND a.revision=v_expected+1 AND a.actor_uid=p->>'actorUid' AND a.actor_role=p->>'actorRole' AND a.intent_digest=v_digest;
  IF FOUND THEN RETURN v_result || jsonb_build_object('replayed',true); END IF;
  IF EXISTS(SELECT 1 FROM sipapua_schedule.audit a WHERE a.operation_id=v_op) THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='operation_id_reused'; END IF;
  IF v_s.status <> 'published' OR v_s.revision <> v_expected THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='stale_or_not_published'; END IF;
  v_now := clock_timestamp(); v_rev := v_s.revision + 1;
  DELETE FROM sipapua_schedule.reservations WHERE occurrence_id=v_id;
  UPDATE sipapua_schedule.occurrences SET status='cancelled',revision=v_rev,updated_at=v_now WHERE id=v_id;
  UPDATE sipapua_schedule.member_projection SET status='cancelled',revision=v_rev,updated_at=v_now WHERE id=v_id AND published_at=v_s.published_at;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='projection_missing'; END IF;
  v_result := jsonb_build_object('id',v_id,'revision',v_rev,'status','cancelled','publishedAt',v_s.published_at);
  INSERT INTO sipapua_schedule.audit(operation_id,occurrence_id,revision,actor_uid,actor_role,action,from_status,to_status,intent_digest,result,recorded_at)
  VALUES(v_op,v_id,v_rev,p->>'actorUid',p->>'actorRole','cancel','published','cancelled',v_digest,v_result,v_now);
  RETURN v_result;
END $$;

CREATE FUNCTION sipapua_schedule.api_admin_list(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, sipapua_schedule, sipapua_private AS $$
BEGIN
  PERFORM sipapua_private.assert_actor(p,'admin_read');
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.service_date,o.start_time,o.id) FROM sipapua_schedule.occurrences o),'[]'::jsonb);
END $$;

CREATE FUNCTION sipapua_schedule.api_audit_list(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, sipapua_schedule, sipapua_private AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM sipapua_private.assert_actor(p,'audit_read'); v_id := (p->>'scheduleId')::uuid;
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.revision) FROM sipapua_schedule.audit a WHERE a.occurrence_id=v_id),'[]'::jsonb);
END $$;

CREATE FUNCTION sipapua_schedule.api_member_list(p jsonb)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, sipapua_schedule AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'area',m.area,'category',m.category,'title',m.title,'date',m.service_date,'startTime',to_char(m.start_time,'HH24:MI'),'endTime',to_char(m.end_time,'HH24:MI'),'venue',m.venue_name,'leader',m.leader_name,'officers',m.officers,'theme',m.theme,'scripture',m.scripture,'publicNotes',m.public_notes,'status',m.status,'publishedAt',m.published_at) ORDER BY m.service_date,m.start_time,m.id),'[]'::jsonb)
FROM sipapua_schedule.member_projection m
WHERE m.status IN ('published','cancelled')
  AND (coalesce(p->>'area','') = '' OR m.area=p->>'area')
  AND (coalesce(p->>'category','') = '' OR m.category=p->>'category')
  AND (coalesce(p->>'from','') = '' OR m.service_date >= (p->>'from')::date)
  AND (coalesce(p->>'to','') = '' OR m.service_date <= (p->>'to')::date)
$$;

DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='sipapua_schedule' AND p.proname LIKE 'api_%' LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO schedule_writer',f.signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO schedule_runtime',f.signature);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION sipapua_schedule.api_member_list(jsonb) TO schedule_runtime;

-- Runtime can connect and execute narrowly scoped functions only.
GRANT CONNECT ON DATABASE sipapua_schedule_local TO schedule_runtime;
REVOKE ALL ON SCHEMA sipapua_private FROM schedule_runtime;
