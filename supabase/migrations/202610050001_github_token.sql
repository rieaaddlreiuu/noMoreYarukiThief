begin;

-- AES-256-GCM ciphertext of the user's OAuth token (empty scope: public data only). Never stored in plaintext.
alter table public.users add column github_token_enc text;

drop function public.niki_link_github(text, text, bigint, text);
create function public.niki_link_github(p_discord_id text, p_guild_id text, p_github_id bigint, p_login text, p_token_enc text default null)
returns void language plpgsql set search_path = '' as $$
begin
  insert into public.users (discord_id, github_id, github_login, github_token_enc)
  values (p_discord_id, p_github_id, p_login, p_token_enc)
  on conflict (discord_id) do update set github_id = excluded.github_id,
    github_login = excluded.github_login, github_token_enc = excluded.github_token_enc, updated_at = now();
  insert into public.memberships (guild_id, discord_id) values (p_guild_id, p_discord_id)
  on conflict (guild_id, discord_id) do update set active = true;
end;
$$;
revoke all on function public.niki_link_github(text, text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.niki_link_github(text, text, bigint, text, text) to service_role;

commit;
