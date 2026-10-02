begin;

-- Per-server weekly summary schedule. Defaults keep the previous fixed Monday 09:00 JST behavior.
alter table public.guild_settings
  add column weekly_day smallint not null default 1 check (weekly_day between 1 and 7),
  add column weekly_hour smallint not null default 9 check (weekly_hour between 0 and 23),
  add column weekly_enabled boolean not null default true;

-- p_pending_only limits the page to enabled servers whose delivery time has passed and that have no report yet.
drop function public.niki_weekly_preview(date, text, integer);
create function public.niki_weekly_preview(p_week date, p_after text default '', p_limit integer default 100, p_pending_only boolean default false)
returns table (guild_id text, channel_id text, declaration_count integer, members jsonb)
language sql stable set search_path = '' as $$
  with guilds as (
    select g.guild_id, g.channel_id from public.guild_settings g
    where g.guild_id > p_after
      and (not p_pending_only or (
        g.weekly_enabled
        and now() >= ((p_week + 7 + (g.weekly_day - 1))::timestamp + g.weekly_hour * interval '1 hour') at time zone 'Asia/Tokyo'
        and not exists (select 1 from public.weekly_reports r where r.guild_id = g.guild_id and r.week_start = p_week)))
    order by g.guild_id limit greatest(1, least(p_limit, 100))
  ), period as (
    select d.* from public.declarations d join guilds g using (guild_id)
    where d.deadline >= (p_week::timestamp at time zone 'Asia/Tokyo')
      and d.deadline < ((p_week + 7)::timestamp at time zone 'Asia/Tokyo')
  ), counts as (
    select m.guild_id, m.discord_id, u.github_login,
      count(d.id) filter (where d.status = 'succeeded')::integer as succeeded,
      count(d.id) filter (where d.status = 'failed')::integer as failed
    from public.memberships m join guilds g using (guild_id) join public.users u using (discord_id)
    left join period d on d.guild_id = m.guild_id and d.discord_id = m.discord_id
    group by m.guild_id, m.discord_id, u.github_login, m.active
    having m.active or count(d.id) filter (where d.status in ('succeeded', 'failed')) > 0
  )
  select g.guild_id, g.channel_id, (select count(*)::integer from period p where p.guild_id = g.guild_id),
    coalesce((select jsonb_agg(jsonb_build_object('discord_id', c.discord_id, 'github_login', c.github_login,
      'succeeded', c.succeeded, 'failed', c.failed) order by c.discord_id) from counts c where c.guild_id = g.guild_id), '[]'::jsonb)
  from guilds g order by g.guild_id;
$$;

-- The week must have ended; each server's own delivery time is checked by the preview.
create or replace function public.niki_prepare_weekly(p_week date)
returns integer language plpgsql set search_path = '' as $$
declare v_count integer;
begin
  if p_week is null or extract(isodow from p_week) <> 1
    or now() < (p_week + 7)::timestamp at time zone 'Asia/Tokyo' then
    raise exception 'WEEK_NOT_DUE';
  end if;
  insert into public.weekly_reports (guild_id, channel_id, week_start, snapshot)
    select p.guild_id, p.channel_id, p_week, to_jsonb(p) from public.niki_weekly_preview(p_week, '', 100, true) p
    on conflict (guild_id, week_start) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Servers that turned the summary off keep their pending reports until it is turned back on.
create or replace function public.niki_claim_weekly()
returns setof public.weekly_reports language sql set search_path = '' as $$
  with candidate as (
    select r.id from public.weekly_reports r where r.status = 'pending' and r.next_attempt_at <= now()
      and (r.lease_until is null or r.lease_until < now())
      and exists (select 1 from public.guild_settings g where g.guild_id = r.guild_id and g.weekly_enabled)
    order by r.next_attempt_at, r.week_start, r.guild_id for update of r skip locked limit 1
  )
  update public.weekly_reports r set lease_token = gen_random_uuid(), lease_until = now() + interval '2 minutes',
    attempts = r.attempts + 1, first_attempt_at = coalesce(r.first_attempt_at, now())
    from candidate c where r.id = c.id returning r.*;
$$;

revoke all on function public.niki_weekly_preview(date,text,integer,boolean) from public, anon, authenticated;
grant execute on function public.niki_weekly_preview(date,text,integer,boolean) to service_role;

commit;
