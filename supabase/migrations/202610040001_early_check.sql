begin;

-- Candidate SHAs the AI judge has already rejected, so polling before the deadline does not re-judge them.
alter table public.declarations add column judged_shas text[] not null default '{}';

-- The first check happens shortly after declaring instead of right away; never later than the deadline.
create function public.niki_schedule_first_check()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.next_check_at := least(new.deadline, now() + interval '30 minutes');
  return new;
end;
$$;

create trigger declarations_first_check before insert on public.declarations
  for each row execute function public.niki_schedule_first_check();

-- Pending declarations are polled before the deadline too, so a commit can be recognised early.
create or replace function public.niki_claim_check()
returns setof public.declarations language sql set search_path = '' as $$
  with candidate as (
    select id from public.declarations where status = 'pending' and next_check_at <= now()
      and (lease_until is null or lease_until < now())
    order by next_check_at, deadline for update skip locked limit 1
  )
  update public.declarations d set lease_token = gen_random_uuid(), lease_until = now() + interval '2 minutes',
    check_attempts = d.check_attempts + 1 from candidate c where d.id = c.id returning d.*;
$$;

drop function public.niki_finish_check(uuid, uuid, text, text);

create function public.niki_finish_check(p_id uuid, p_lease uuid, p_sha text, p_ai_reason text default null, p_judged text[] default null)
returns boolean language plpgsql set search_path = '' as $$
declare v_declaration public.declarations;
begin
  if p_sha is null then
    -- A scan that started before the deadline cannot prove failure (the lease starts at the claim time,
    -- 2 minutes before lease_until). Keep pending and poll again, every 10 minutes in the last hour.
    update public.declarations set judged_shas = coalesce(p_judged, judged_shas), checked_at = now(),
      check_attempts = 0, last_check_error = null,
      next_check_at = least(deadline, now() + case when deadline - now() <= interval '1 hour' then interval '10 minutes' else interval '30 minutes' end),
      lease_token = null, lease_until = null
      where id = p_id and status = 'pending' and lease_token = p_lease and lease_until > now()
        and lease_until - interval '2 minutes' < deadline;
    if found then return true; end if;
  end if;
  update public.declarations set status = case when p_sha is null then 'failed' else 'succeeded' end,
    commit_sha = p_sha, ai_reason = left(p_ai_reason, 500), judged_shas = coalesce(p_judged, judged_shas),
    checked_at = now(), last_check_error = null, lease_token = null, lease_until = null
    where id = p_id and status = 'pending' and lease_token = p_lease and lease_until > now()
    returning * into v_declaration;
  if not found then return false; end if;
  insert into public.notifications (declaration_id, kind, channel_id)
    select p_id, 'result', c from public.niki_notify_channels(v_declaration.guild_id, v_declaration.discord_id) as c
    on conflict (declaration_id, kind, channel_id) do nothing;
  return true;
end;
$$;

revoke all on function public.niki_finish_check(uuid, uuid, text, text, text[]) from public, anon, authenticated;
grant execute on function public.niki_finish_check(uuid, uuid, text, text, text[]) to service_role;

-- Before the deadline a retry must not be pushed past it: the deadline check is the one that can fail.
create or replace function public.niki_retry_check(p_id uuid, p_lease uuid, p_error text, p_delay integer)
returns void language sql set search_path = '' as $$
  update public.declarations set last_check_error = left(p_error, 240), checked_at = now(),
    next_check_at = case when deadline > now()
      then least(deadline, now() + make_interval(secs => greatest(60, least(p_delay, 86400))))
      else now() + make_interval(secs => greatest(60, least(p_delay, 86400))) end,
    lease_token = null, lease_until = null
    where id = p_id and status = 'pending' and lease_token = p_lease;
$$;

commit;
