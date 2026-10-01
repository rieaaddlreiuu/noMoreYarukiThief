-- Run AFTER the weekly-summary migration and application deployment.
-- Reuses niki_app_url and niki_cron_secret from the existing Vault setup.
-- pg_cron schedules below are UTC: Monday 00:00 UTC = Monday 09:00 JST.
select cron.schedule(
  'niki-weekly-summary', '0 0 * * 1',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'niki_app_url') || '/api/jobs/weekly',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
        'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'niki_cron_secret')),
      body := '{"dryRun":false}'::jsonb, timeout_milliseconds := 60000
    );
  $job$
);

-- Recover failures/missed starts and drain remaining servers, without re-posting sent weeks.
-- Avoid the exact Monday 09:00 slot; the weekly job above handles it.
select cron.schedule(
  'niki-weekly-summary-retry', '5,10,15,20,25,30,35,40,45,50,55 * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'niki_app_url') || '/api/jobs/weekly',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
        'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'niki_cron_secret')),
      body := '{"dryRun":false}'::jsonb, timeout_milliseconds := 60000
    );
  $job$
);
