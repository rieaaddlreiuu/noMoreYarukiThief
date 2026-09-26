-- Enable Cron (pg_cron), pg_net, and Vault in Supabase first.
-- Save these secrets once through the Vault UI (do not commit real values):
-- niki_app_url     = https://your-app.vercel.app
-- niki_cron_secret = the same random value as CRON_SECRET in Vercel
select cron.schedule(
  'niki-evaluate',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'niki_app_url') || '/api/jobs/evaluate',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'niki_cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $job$
);
