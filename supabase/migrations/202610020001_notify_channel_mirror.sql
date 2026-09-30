begin;

-- One notification event may now fan out to several channels: one independent row per channel.
alter table public.notifications drop constraint notifications_declaration_id_kind_key;
alter table public.notifications add constraint notifications_declaration_kind_channel_key unique (declaration_id, kind, channel_id);

-- The guild default channel always comes first (so it gets the earlier sequence), then the member's own channel.
create function public.niki_notify_channels(p_guild_id text, p_discord_id text)
returns setof text language sql stable set search_path = '' as $$
  select gs.channel_id from public.guild_settings gs where gs.guild_id = p_guild_id
  union all
  select m.notify_channel_id from public.memberships m join public.guild_settings gs using (guild_id)
    where m.guild_id = p_guild_id and m.discord_id = p_discord_id
      and m.notify_channel_id is not null and m.notify_channel_id <> gs.channel_id;
$$;

create or replace function public.niki_create_declaration(
  p_interaction_id text, p_guild_id text, p_discord_id text, p_content text,
  p_repository text, p_branch text, p_deadline timestamptz
) returns public.declarations language plpgsql set search_path = '' as $$
declare
  v_user public.users;
  v_declaration public.declarations;
  v_channel text;
begin
  select * into v_declaration from public.declarations
    where interaction_id = p_interaction_id and guild_id = p_guild_id and discord_id = p_discord_id;
  if found then return v_declaration; end if;
  select u.* into v_user from public.users u join public.memberships m using (discord_id)
    where m.guild_id = p_guild_id and m.discord_id = p_discord_id and m.active for update of u;
  if not found then raise exception 'LINK_REQUIRED'; end if;
  select channel_id into v_channel from public.guild_settings where guild_id = p_guild_id;
  if v_channel is null then raise exception 'SETUP_REQUIRED'; end if;
  if p_deadline <= now() then raise exception 'FUTURE_DEADLINE_REQUIRED'; end if;
  insert into public.declarations (interaction_id, guild_id, discord_id, github_id, content, repository, branch, deadline)
  values (p_interaction_id, p_guild_id, p_discord_id, v_user.github_id, p_content, p_repository, p_branch, p_deadline)
  returning * into v_declaration;
  insert into public.notifications (declaration_id, kind, channel_id)
    select v_declaration.id, 'declared', c from public.niki_notify_channels(p_guild_id, p_discord_id) as c;
  return v_declaration;
end;
$$;

create or replace function public.niki_cancel_declaration(p_guild_id text, p_discord_id text)
returns setof public.declarations language plpgsql set search_path = '' as $$
declare v_declaration public.declarations;
begin
  update public.declarations set status = 'cancelled', lease_token = null, lease_until = null
    where guild_id = p_guild_id and discord_id = p_discord_id and status = 'pending' and deadline > now()
    returning * into v_declaration;
  if not found then return; end if;
  insert into public.notifications (declaration_id, kind, channel_id)
    select v_declaration.id, 'cancelled', c from public.niki_notify_channels(p_guild_id, p_discord_id) as c;
  return next v_declaration;
end;
$$;

create or replace function public.niki_finish_check(p_id uuid, p_lease uuid, p_sha text, p_ai_reason text default null)
returns boolean language plpgsql set search_path = '' as $$
declare v_declaration public.declarations;
begin
  update public.declarations set status = case when p_sha is null then 'failed' else 'succeeded' end,
    commit_sha = p_sha, ai_reason = left(p_ai_reason, 500), checked_at = now(),
    last_check_error = null, lease_token = null, lease_until = null
    where id = p_id and status = 'pending' and lease_token = p_lease and lease_until > now()
    returning * into v_declaration;
  if not found then return false; end if;
  insert into public.notifications (declaration_id, kind, channel_id)
    select p_id, 'result', c from public.niki_notify_channels(v_declaration.guild_id, v_declaration.discord_id) as c
    on conflict (declaration_id, kind, channel_id) do nothing;
  return true;
end;
$$;

-- Keep ordering per channel so a failing personal channel never blocks the guild default channel.
create or replace function public.niki_claim_notification(p_declaration_id uuid default null)
returns setof public.notifications language sql set search_path = '' as $$
  with candidate as (
    select n.id from public.notifications n where n.status = 'pending' and n.next_attempt_at <= now()
      and (p_declaration_id is null or n.declaration_id = p_declaration_id)
      and (n.lease_until is null or n.lease_until < now())
      and not exists (select 1 from public.notifications earlier where earlier.declaration_id = n.declaration_id
        and earlier.channel_id = n.channel_id and earlier.status = 'pending' and earlier.sequence < n.sequence)
    order by n.sequence for update skip locked limit 1
  )
  update public.notifications n set lease_token = gen_random_uuid(), lease_until = now() + interval '2 minutes',
    attempts = n.attempts + 1, first_attempt_at = coalesce(n.first_attempt_at, now())
    from candidate c where n.id = c.id returning n.*;
$$;

revoke all on function public.niki_notify_channels(text, text) from public, anon, authenticated;
grant execute on function public.niki_notify_channels(text, text) to service_role;

commit;
