begin;

alter table public.memberships add column notify_channel_id text check (notify_channel_id ~ '^[0-9]{17,20}$');

-- p_channel_id = null clears the personal channel and falls back to the guild default.
create function public.niki_set_notify_channel(p_guild_id text, p_discord_id text, p_channel_id text)
returns void language plpgsql set search_path = '' as $$
begin
  update public.memberships set notify_channel_id = p_channel_id
    where guild_id = p_guild_id and discord_id = p_discord_id and active;
  if not found then raise exception 'LINK_REQUIRED'; end if;
end;
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
  select coalesce(m.notify_channel_id, gs.channel_id) into v_channel
    from public.guild_settings gs join public.memberships m on m.guild_id = gs.guild_id
    where gs.guild_id = p_guild_id and m.discord_id = p_discord_id;
  if v_channel is null then raise exception 'SETUP_REQUIRED'; end if;
  if p_deadline <= now() then raise exception 'FUTURE_DEADLINE_REQUIRED'; end if;
  insert into public.declarations (interaction_id, guild_id, discord_id, github_id, content, repository, branch, deadline)
  values (p_interaction_id, p_guild_id, p_discord_id, v_user.github_id, p_content, p_repository, p_branch, p_deadline)
  returning * into v_declaration;
  insert into public.notifications (declaration_id, kind, channel_id) values (v_declaration.id, 'declared', v_channel);
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
    select v_declaration.id, 'cancelled', coalesce(m.notify_channel_id, gs.channel_id)
    from public.guild_settings gs join public.memberships m on m.guild_id = gs.guild_id
    where gs.guild_id = p_guild_id and m.discord_id = p_discord_id;
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
    select p_id, 'result', coalesce(m.notify_channel_id, gs.channel_id)
    from public.guild_settings gs join public.memberships m on m.guild_id = gs.guild_id
    where gs.guild_id = v_declaration.guild_id and m.discord_id = v_declaration.discord_id
    on conflict (declaration_id, kind) do nothing;
  return true;
end;
$$;

revoke all on function public.niki_set_notify_channel(text, text, text) from public, anon, authenticated;
grant execute on function public.niki_set_notify_channel(text, text, text) to service_role;

commit;
