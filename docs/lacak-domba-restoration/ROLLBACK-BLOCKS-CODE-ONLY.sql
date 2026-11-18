-- REVIEW ONLY: after disabling the new Edge; restore code/retain every row.
begin;
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
notify pgrst, 'reload schema';
commit;
