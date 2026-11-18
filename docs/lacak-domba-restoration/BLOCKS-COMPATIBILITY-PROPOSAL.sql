-- REVIEW ONLY: compatibility correction to EXISTING block mirror RPC.
-- CREATE OR REPLACE changes only code, not any stored block/location row.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $compat_preflight$
begin
 if md5(pg_get_functiondef(to_regprocedure('public.lacak_domba_replace_own_blocks(text,text[])'))) is distinct from '5f3d414be75d04cdf44a84216f863db5' then raise exception 'STOP: existing block RPC changed since review'; end if;
 if has_function_privilege('anon','public.lacak_domba_replace_own_blocks(text,text[])','EXECUTE') or has_function_privilege('authenticated','public.lacak_domba_replace_own_blocks(text,text[])','EXECUTE') or not has_function_privilege('service_role','public.lacak_domba_replace_own_blocks(text,text[])','EXECUTE') then raise exception 'STOP: block RPC ACL differs'; end if;
end;
$compat_preflight$;
CREATE OR REPLACE FUNCTION public.lacak_domba_replace_own_blocks(p_blocker_uid text, p_blocked_uids text[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
    v_blocked_uid TEXT;
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

    -- Match the existing repository's per-owner atomic replacement protocol.
    PERFORM pg_advisory_xact_lock(hashtextextended('lacak_domba_blocks:' || p_blocker_uid, 0));

    DELETE FROM public.lacak_domba_blocks
    WHERE blocker_uid = p_blocker_uid;

    FOREACH v_blocked_uid IN ARRAY
        COALESCE(p_blocked_uids, ARRAY[]::TEXT[])
    LOOP
        IF v_blocked_uid IS NULL
           OR length(v_blocked_uid) < 1
           OR length(v_blocked_uid) > 128
           OR v_blocked_uid = p_blocker_uid THEN
            CONTINUE;
        END IF;

        INSERT INTO public.lacak_domba_blocks (
            blocker_uid,
            blocked_uid
        )
        VALUES (
            p_blocker_uid,
            v_blocked_uid
        )
        ON CONFLICT (blocker_uid, blocked_uid) DO NOTHING;

        inserted_count := inserted_count + 1;
    END LOOP;

    RETURN inserted_count;
END;
$function$
;
notify pgrst, 'reload schema';
commit;
