begin;

create table public.users (
  discord_id text primary key check (discord_id ~ '^[0-9]{17,20}$'),
  github_id bigint not null unique check (github_id > 0),
  github_login text not null,
  updated_at timestamptz not null default now()
);

create table public.guild_settings (
  guild_id text primary key check (guild_id ~ '^[0-9]{17,20}$'),
  channel_id text not null check (channel_id ~ '^[0-9]{17,20}$'),
  updated_at timestamptz not null default now()
);

create table public.memberships (
  guild_id text not null references public.guild_settings on delete cascade,
  discord_id text not null references public.users on delete cascade,
  active boolean not null default true,
  joined_at timestamptz not null default now(),
  primary key (guild_id, discord_id)
);

create table public.declarations (
  id uuid primary key default gen_random_uuid(),
  interaction_id text not null unique,
  guild_id text not null,
  discord_id text not null,
  github_id bigint not null,
  content text not null check (length(btrim(content)) between 1 and 500),
  repository text not null,
  branch text not null check (length(branch) between 1 and 255),
  created_at timestamptz not null default now(),
  deadline timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'failed', 'cancelled')),
  commit_sha text,
  checked_at timestamptz,
  check_attempts integer not null default 0,
  next_check_at timestamptz not null default now(),
  last_check_error text,
  lease_token uuid,
  lease_until timestamptz,
  foreign key (guild_id, discord_id) references public.memberships (guild_id, discord_id),
  check (deadline > created_at),
  check ((status = 'succeeded') = (commit_sha is not null))
);

-- A concurrent second declaration must fail even across different server instances.
create unique index declarations_one_pending on public.declarations (guild_id, discord_id) where status = 'pending';
create index declarations_due on public.declarations (next_check_at, deadline) where status = 'pending';
create index declarations_team_history on public.declarations (guild_id, created_at desc, id);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  sequence bigint generated always as identity unique,
  declaration_id uuid not null references public.declarations on delete cascade,
  kind text not null check (kind in ('declared', 'result', 'cancelled')),
  channel_id text not null,
  status text not null default 'pending' check (status in ('pending', 'sent')),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  first_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  message_id text,
  sent_at timestamptz,
  unique (declaration_id, kind)
);
create index notifications_due on public.notifications (next_attempt_at, sequence) where status = 'pending';

create table public.oauth_sessions (
  ticket_hash text primary key,
  discord_id text not null,
  guild_id text not null references public.guild_settings on delete cascade,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  state_hash text unique,
  browser_hash text,
  code_verifier text
);
create index oauth_sessions_expiry on public.oauth_sessions (expires_at);

create table public.interaction_receipts (
  id text primary key,
  created_at timestamptz not null default now()
);

create function public.niki_link_github(p_discord_id text, p_guild_id text, p_github_id bigint, p_login text)
returns void language plpgsql set search_path = '' as $$
begin
  insert into public.users (discord_id, github_id, github_login)
  values (p_discord_id, p_github_id, p_login)
  on conflict (discord_id) do update set github_id = excluded.github_id,
    github_login = excluded.github_login, updated_at = now();
  insert into public.memberships (guild_id, discord_id) values (p_guild_id, p_discord_id)
  on conflict (guild_id, discord_id) do update set active = true;
end;
$$;

create function public.niki_begin_oauth(p_ticket_hash text, p_state_hash text, p_browser_hash text, p_verifier text)
returns boolean language plpgsql set search_path = '' as $$
begin
  update public.oauth_sessions set state_hash = p_state_hash, browser_hash = p_browser_hash, code_verifier = p_verifier
  where ticket_hash = p_ticket_hash and expires_at > now() and state_hash is null;
  return found;
end;
$$;

create function public.niki_consume_oauth(p_state_hash text, p_browser_hash text)
returns setof public.oauth_sessions language sql set search_path = '' as $$
  delete from public.oauth_sessions where state_hash = p_state_hash
    and browser_hash = p_browser_hash and expires_at > now() returning *;
$$;

create function public.niki_create_declaration(
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
  insert into public.notifications (declaration_id, kind, channel_id) values (v_declaration.id, 'declared', v_channel);
  return v_declaration;
end;
$$;

create function public.niki_cancel_declaration(p_guild_id text, p_discord_id text)
returns setof public.declarations language plpgsql set search_path = '' as $$
declare v_declaration public.declarations;
begin
  update public.declarations set status = 'cancelled', lease_token = null, lease_until = null
    where guild_id = p_guild_id and discord_id = p_discord_id and status = 'pending' and deadline > now()
    returning * into v_declaration;
  if not found then return; end if;
  insert into public.notifications (declaration_id, kind, channel_id)
    select v_declaration.id, 'cancelled', channel_id from public.guild_settings where guild_id = p_guild_id;
  return next v_declaration;
end;
$$;

-- Claim one job at a time. The 2-minute lease exceeds the Route Handler's 60-second lifetime.
create function public.niki_claim_check()
returns setof public.declarations language sql set search_path = '' as $$
  with candidate as (
    select id from public.declarations where status = 'pending' and deadline <= now() and next_check_at <= now()
      and (lease_until is null or lease_until < now())
    order by next_check_at, deadline for update skip locked limit 1
  )
  update public.declarations d set lease_token = gen_random_uuid(), lease_until = now() + interval '2 minutes',
    check_attempts = d.check_attempts + 1 from candidate c where d.id = c.id returning d.*;
$$;

create function public.niki_finish_check(p_id uuid, p_lease uuid, p_sha text)
returns boolean language plpgsql set search_path = '' as $$
declare v_declaration public.declarations;
begin
  update public.declarations set status = case when p_sha is null then 'failed' else 'succeeded' end,
    commit_sha = p_sha, checked_at = now(), last_check_error = null, lease_token = null, lease_until = null
    where id = p_id and status = 'pending' and lease_token = p_lease and lease_until > now()
    returning * into v_declaration;
  if not found then return false; end if;
  insert into public.notifications (declaration_id, kind, channel_id)
    select p_id, 'result', channel_id from public.guild_settings where guild_id = v_declaration.guild_id
    on conflict (declaration_id, kind) do nothing;
  return true;
end;
$$;

create function public.niki_retry_check(p_id uuid, p_lease uuid, p_error text, p_delay integer)
returns void language sql set search_path = '' as $$
  update public.declarations set last_check_error = left(p_error, 240), checked_at = now(),
    next_check_at = now() + make_interval(secs => greatest(60, least(p_delay, 86400))),
    lease_token = null, lease_until = null
    where id = p_id and status = 'pending' and lease_token = p_lease;
$$;

create function public.niki_claim_notification(p_declaration_id uuid default null)
returns setof public.notifications language sql set search_path = '' as $$
  with candidate as (
    select n.id from public.notifications n where n.status = 'pending' and n.next_attempt_at <= now()
      and (p_declaration_id is null or n.declaration_id = p_declaration_id)
      and (n.lease_until is null or n.lease_until < now())
      and not exists (select 1 from public.notifications earlier where earlier.declaration_id = n.declaration_id
        and earlier.status = 'pending' and earlier.sequence < n.sequence)
    order by n.sequence for update skip locked limit 1
  )
  update public.notifications n set lease_token = gen_random_uuid(), lease_until = now() + interval '2 minutes',
    attempts = n.attempts + 1, first_attempt_at = coalesce(n.first_attempt_at, now())
    from candidate c where n.id = c.id returning n.*;
$$;

create function public.niki_finish_notification(p_id uuid, p_lease uuid, p_message_id text)
returns boolean language plpgsql set search_path = '' as $$
begin
  update public.notifications set status = 'sent', message_id = p_message_id, sent_at = now(),
    lease_token = null, lease_until = null, last_error = null
    where id = p_id and status = 'pending' and lease_token = p_lease and lease_until > now();
  return found;
end;
$$;

create function public.niki_retry_notification(p_id uuid, p_lease uuid, p_error text, p_delay integer)
returns void language sql set search_path = '' as $$
  update public.notifications set last_error = left(p_error, 240),
    next_attempt_at = now() + make_interval(secs => greatest(60, least(p_delay, 86400))),
    lease_token = null, lease_until = null
    where id = p_id and status = 'pending' and lease_token = p_lease;
$$;

create function public.niki_cleanup()
returns void language plpgsql set search_path = '' as $$
begin
  delete from public.oauth_sessions where expires_at < now();
  delete from public.interaction_receipts where created_at < now() - interval '1 day';
end;
$$;

-- Only the backend service role can read or mutate application data. No public policies.
alter table public.users enable row level security;
alter table public.guild_settings enable row level security;
alter table public.memberships enable row level security;
alter table public.declarations enable row level security;
alter table public.notifications enable row level security;
alter table public.oauth_sessions enable row level security;
alter table public.interaction_receipts enable row level security;
revoke all on table public.users, public.guild_settings, public.memberships, public.declarations,
  public.notifications, public.oauth_sessions, public.interaction_receipts from public, anon, authenticated;
grant all on table public.users, public.guild_settings, public.memberships, public.declarations,
  public.notifications, public.oauth_sessions, public.interaction_receipts to service_role;
revoke all on sequence public.notifications_sequence_seq from public, anon, authenticated;
grant usage, select on sequence public.notifications_sequence_seq to service_role;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature from pg_proc p
    join pg_namespace n on p.pronamespace = n.oid where n.nspname = 'public' and p.proname like 'niki\_%' escape '\'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.signature);
    execute format('grant execute on function %s to service_role', f.signature);
  end loop;
end $$;

commit;
