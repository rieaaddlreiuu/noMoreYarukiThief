begin;

create table public.weekly_reports (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null references public.guild_settings on delete cascade,
  channel_id text not null,
  week_start date not null check (extract(isodow from week_start) = 1),
  snapshot jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'sent')),
  attempts integer not null default 0,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  message_id text,
  sent_at timestamptz,
  unique (guild_id, week_start)
);
create index weekly_reports_due on public.weekly_reports (next_attempt_at) where status = 'pending';
create index declarations_weekly on public.declarations (guild_id, deadline);

-- Read-only; shared by previews and the once-per-week frozen snapshot.
create function public.niki_weekly_preview(p_week date, p_after text default '', p_limit integer default 100)
returns table (guild_id text, channel_id text, declaration_count integer, members jsonb)
language sql stable set search_path = '' as $$
  with guilds as (
    select g.guild_id, g.channel_id from public.guild_settings g
    where g.guild_id > p_after order by g.guild_id limit greatest(1, least(p_limit, 100))
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

create function public.niki_prepare_weekly(p_week date)
returns integer language plpgsql set search_path = '' as $$
declare v_count integer; v_first text; v_after text;
begin
  if p_week is null or extract(isodow from p_week) <> 1
    or now() < ((p_week + 7)::timestamp + interval '9 hours') at time zone 'Asia/Tokyo' then
    raise exception 'WEEK_NOT_DUE';
  end if;
  -- Resume with the first unprepared guild on the next run, without starving large installations.
  select min(g.guild_id) into v_first from public.guild_settings g where not exists (
    select 1 from public.weekly_reports r where r.guild_id = g.guild_id and r.week_start = p_week);
  if v_first is null then return 0; end if;
  select coalesce(max(g.guild_id), '') into v_after from public.guild_settings g where g.guild_id < v_first;
  insert into public.weekly_reports (guild_id, channel_id, week_start, snapshot)
    select p.guild_id, p.channel_id, p_week, to_jsonb(p) from public.niki_weekly_preview(p_week, v_after, 100) p
    on conflict (guild_id, week_start) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function public.niki_claim_weekly()
returns setof public.weekly_reports language sql set search_path = '' as $$
  with candidate as (
    select id from public.weekly_reports where status = 'pending' and next_attempt_at <= now()
      and (lease_until is null or lease_until < now())
    order by next_attempt_at, week_start, guild_id for update skip locked limit 1
  )
  update public.weekly_reports r set lease_token = gen_random_uuid(), lease_until = now() + interval '2 minutes',
    attempts = r.attempts + 1, first_attempt_at = coalesce(r.first_attempt_at, now())
    from candidate c where r.id = c.id returning r.*;
$$;

create function public.niki_finish_weekly(p_id uuid, p_lease uuid, p_message_id text)
returns boolean language plpgsql set search_path = '' as $$
begin
  update public.weekly_reports set status = 'sent', message_id = p_message_id, sent_at = now(),
    lease_token = null, lease_until = null, last_error = null
    where id = p_id and status = 'pending' and lease_token = p_lease and lease_until > now();
  return found;
end;
$$;

create function public.niki_retry_weekly(p_id uuid, p_lease uuid, p_error text, p_delay integer)
returns void language sql set search_path = '' as $$
  update public.weekly_reports set last_error = left(p_error, 240),
    next_attempt_at = now() + make_interval(secs => greatest(60, least(p_delay, 86400))),
    lease_token = null, lease_until = null
    where id = p_id and status = 'pending' and lease_token = p_lease and lease_until > now();
$$;

alter table public.weekly_reports enable row level security;
revoke all on public.weekly_reports from public, anon, authenticated;
grant all on public.weekly_reports to service_role;
revoke all on function public.niki_weekly_preview(date,text,integer), public.niki_prepare_weekly(date),
  public.niki_claim_weekly(), public.niki_finish_weekly(uuid,uuid,text), public.niki_retry_weekly(uuid,uuid,text,integer)
  from public, anon, authenticated;
grant execute on function public.niki_weekly_preview(date,text,integer), public.niki_prepare_weekly(date),
  public.niki_claim_weekly(), public.niki_finish_weekly(uuid,uuid,text), public.niki_retry_weekly(uuid,uuid,text,integer)
  to service_role;

commit;
