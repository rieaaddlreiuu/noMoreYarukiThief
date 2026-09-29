begin;

alter table public.declarations add column ai_reason text check (ai_reason is null or length(ai_reason) <= 500);

drop function public.niki_finish_check(uuid, uuid, text);

create function public.niki_finish_check(p_id uuid, p_lease uuid, p_sha text, p_ai_reason text default null)
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
    select p_id, 'result', channel_id from public.guild_settings where guild_id = v_declaration.guild_id
    on conflict (declaration_id, kind) do nothing;
  return true;
end;
$$;

revoke all on function public.niki_finish_check(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.niki_finish_check(uuid, uuid, text, text) to service_role;

commit;
