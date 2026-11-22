const cron = require('node-cron');
const config = require('../config/env');
const { runBackup } = require('./backupService');

function scheduleBackupJob() {
  if (!cron.validate(config.backup.cronSchedule)) {
    console.error(`[backup] invalid cron schedule "${config.backup.cronSchedule}"; backup job NOT scheduled`);
    return null;
  }

  const options = config.backup.timezone ? { timezone: config.backup.timezone } : {};
  const task = cron.schedule(config.backup.cronSchedule, async () => {
    console.log('[backup] daily backup starting...');
    try {
      const result = await runBackup();
      console.log(`[backup] completed: ${result.zipPath} (${result.zipSizeBytes} bytes). Email: ${JSON.stringify(result.email)}`);
    } catch (err) {
      console.error('[backup] daily backup FAILED:', err.message);
    }
  }, options);

  console.log(`[backup] scheduled with cron expression "${config.backup.cronSchedule}" (${config.backup.timezone || 'server local time'})`);
  return task;
}

module.exports = { scheduleBackupJob };
