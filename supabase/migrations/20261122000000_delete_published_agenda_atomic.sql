-- Agenda deletion and photo cascade share one PostgreSQL statement transaction.
create function public.delete_published_agenda_atomic(p_ids uuid[])
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    requested integer;
    matched integer;
    photos integer;
    removed uuid[];
begin
    if p_ids is null or cardinality(p_ids) > 50 then
        raise exception 'Invalid agenda selection' using errcode = '22023';
    end if;
    if not exists (
        select 1 from pg_catalog.pg_constraint
        where contype = 'f' and confdeltype = 'c'
          and conrelid = 'public.agenda_program_photos'::regclass
          and confrelid = 'public.agenda_programs'::regclass
          and conkey = array[(select attnum from pg_catalog.pg_attribute
              where attrelid = conrelid and attname = 'agenda_id')]
          and confkey = array[(select attnum from pg_catalog.pg_attribute
              where attrelid = confrelid and attname = 'id')]
    ) then
        raise exception 'Required agenda photo cascade is unavailable' using errcode = '55000';
    end if;
    requested := cardinality(p_ids);
    if requested = 0 then
        return jsonb_build_object('ready', true);
    end if;

    select count(*) into matched from (
        select id from public.agenda_programs
        where id = any(p_ids) and status = 'published'
        order by id for update
    ) as locked_agenda;
    if matched <> requested then
        raise exception 'Agenda missing or no longer published' using errcode = 'P0002';
    end if;
    select count(*) into photos from (
        select id from public.agenda_program_photos
        where agenda_id = any(p_ids) order by id for update
    ) as locked_photos;
    with deleted as (
        delete from public.agenda_programs
        where id = any(p_ids) and status = 'published' returning id
    )
    select array_agg(id order by id) into removed from deleted;
    if cardinality(coalesce(removed, array[]::uuid[])) <> requested then
        raise exception 'Agenda deletion was not confirmed' using errcode = 'P0002';
    end if;
    return jsonb_build_object('kind','agenda_programs','recordsDeleted',requested,
        'photosDeleted',photos,'deletedIds',removed);
end;
$$;
revoke all on function public.delete_published_agenda_atomic(uuid[]) from public, anon, authenticated;
grant execute on function public.delete_published_agenda_atomic(uuid[]) to service_role;
