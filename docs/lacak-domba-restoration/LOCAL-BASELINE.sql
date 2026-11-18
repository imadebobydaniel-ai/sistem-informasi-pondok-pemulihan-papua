-- LOCAL SYNTHETIC TEST DATABASE ONLY. Reconstructed catalog, NO production rows.
create table public."lacak_domba_presence" (
  "firebase_uid" text not null,
  "latitude" double precision,
  "longitude" double precision,
  "display_name" text default 'Jemaat SIPAPUA'::text not null,
  "photo_url" text default ''::text not null,
  "komsel" text default ''::text not null,
  "wilayah" text default ''::text not null,
  "discoverable" boolean default false not null,
  "show_online" boolean default false not null,
  "online" boolean default false not null,
  "last_seen" timestamp with time zone,
  "location_updated_at" timestamp with time zone,
  "updated_at" timestamp with time zone default now() not null
);
alter table public."lacak_domba_presence" add constraint "lacak_domba_presence_pkey" PRIMARY KEY (firebase_uid);
alter table public."lacak_domba_presence" add constraint "lacak_domba_valid_coordinates" CHECK ((((latitude IS NULL) AND (longitude IS NULL)) OR (((latitude >= ('-90'::integer)::double precision) AND (latitude <= (90)::double precision)) AND ((longitude >= ('-180'::integer)::double precision) AND (longitude <= (180)::double precision)))));
alter table public."lacak_domba_presence" enable row level security;
create table public."lacak_domba_blocks" (
  "blocker_uid" text not null,
  "blocked_uid" text not null,
  "created_at" timestamp with time zone default now() not null
);
alter table public."lacak_domba_blocks" add constraint "lacak_domba_blocks_pkey" PRIMARY KEY (blocker_uid, blocked_uid);
alter table public."lacak_domba_blocks" add constraint "lacak_domba_no_self_block" CHECK ((blocker_uid <> blocked_uid));
alter table public."lacak_domba_blocks" enable row level security;
create table public."lacak_domba_scan_limits" (
  "firebase_uid" text not null,
  "last_scan_at" timestamp with time zone default now() not null
);
alter table public."lacak_domba_scan_limits" add constraint "lacak_domba_scan_limits_pkey" PRIMARY KEY (firebase_uid);
alter table public."lacak_domba_scan_limits" add constraint "lacak_domba_scan_uid_length" CHECK (((length(firebase_uid) >= 1) AND (length(firebase_uid) <= 128)));
alter table public."lacak_domba_scan_limits" enable row level security;
CREATE INDEX idx_lacak_domba_presence_search ON public.lacak_domba_presence USING btree (discoverable, online, last_seen DESC);
CREATE OR REPLACE FUNCTION public.lacak_domba_replace_own_blocks(p_blocker_uid text, p_blocked_uids text[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
    blocked_uid TEXT;
    inserted_count INTEGER := 0;
BEGIN
    IF p_blocker_uid IS NULL
       OR length(p_blocker_uid) < 1
       OR length(p_blocker_uid) > 128 THEN
        RAISE EXCEPTION 'Invalid blocker UID';
    END IF;

    IF cardinality(COALESCE(p_blocked_uids, ARRAY[]::TEXT[])) > 10000 THEN
        RAISE EXCEPTION 'Block list exceeds limit';
    END IF;

    DELETE FROM public.lacak_domba_blocks
    WHERE blocker_uid = p_blocker_uid;

    FOREACH blocked_uid IN ARRAY
        COALESCE(p_blocked_uids, ARRAY[]::TEXT[])
    LOOP
        IF blocked_uid IS NULL
           OR length(blocked_uid) < 1
           OR length(blocked_uid) > 128
           OR blocked_uid = p_blocker_uid THEN
            CONTINUE;
        END IF;

        INSERT INTO public.lacak_domba_blocks (
            blocker_uid,
            blocked_uid
        )
        VALUES (
            p_blocker_uid,
            blocked_uid
        )
        ON CONFLICT (blocker_uid, blocked_uid) DO NOTHING;

        inserted_count := inserted_count + 1;
    END LOOP;

    RETURN inserted_count;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.lacak_domba_take_scan_slot(p_firebase_uid text, p_min_interval_seconds integer DEFAULT 15)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
    reserved_uid TEXT;
BEGIN
    IF p_firebase_uid IS NULL
       OR length(p_firebase_uid) < 1
       OR length(p_firebase_uid) > 128 THEN
        RAISE EXCEPTION 'Invalid Firebase UID';
    END IF;

    IF p_min_interval_seconds IS NULL
       OR p_min_interval_seconds < 1
       OR p_min_interval_seconds > 300 THEN
        RAISE EXCEPTION 'Invalid scan interval';
    END IF;

    INSERT INTO public.lacak_domba_scan_limits AS current_limit
        (firebase_uid, last_scan_at)
    VALUES
        (p_firebase_uid, NOW())
    ON CONFLICT (firebase_uid)
    DO UPDATE SET
        last_scan_at = EXCLUDED.last_scan_at
    WHERE current_limit.last_scan_at
        <= NOW() - make_interval(
            secs => p_min_interval_seconds
        )
    RETURNING firebase_uid INTO reserved_uid;

    RETURN reserved_uid IS NOT NULL;
END;
$function$
;
grant DELETE on public."lacak_domba_blocks" to "service_role";
grant INSERT on public."lacak_domba_blocks" to "service_role";
grant REFERENCES on public."lacak_domba_blocks" to "service_role";
grant SELECT on public."lacak_domba_blocks" to "service_role";
grant TRIGGER on public."lacak_domba_blocks" to "service_role";
grant TRUNCATE on public."lacak_domba_blocks" to "service_role";
grant UPDATE on public."lacak_domba_blocks" to "service_role";
grant DELETE on public."lacak_domba_presence" to "service_role";
grant INSERT on public."lacak_domba_presence" to "service_role";
grant REFERENCES on public."lacak_domba_presence" to "service_role";
grant SELECT on public."lacak_domba_presence" to "service_role";
grant TRIGGER on public."lacak_domba_presence" to "service_role";
grant TRUNCATE on public."lacak_domba_presence" to "service_role";
grant UPDATE on public."lacak_domba_presence" to "service_role";
grant DELETE on public."lacak_domba_scan_limits" to "service_role";
grant INSERT on public."lacak_domba_scan_limits" to "service_role";
grant REFERENCES on public."lacak_domba_scan_limits" to "service_role";
grant SELECT on public."lacak_domba_scan_limits" to "service_role";
grant TRIGGER on public."lacak_domba_scan_limits" to "service_role";
grant TRUNCATE on public."lacak_domba_scan_limits" to "service_role";
grant UPDATE on public."lacak_domba_scan_limits" to "service_role";
revoke all on function public.lacak_domba_replace_own_blocks(text,text[]) from public,anon,authenticated;
grant execute on function public.lacak_domba_replace_own_blocks(text,text[]) to service_role;
revoke all on function public.lacak_domba_take_scan_slot(text,integer) from public,anon,authenticated;
grant execute on function public.lacak_domba_take_scan_slot(text,integer) to service_role;
