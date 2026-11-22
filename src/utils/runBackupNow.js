const { runBackup } = require('../services/backupService');
const { pool } = require('../db/postgres');
const { connectMongo, closeMongo } = require('../db/mongo');

async function main() {
  await connectMongo();
  const result = await runBackup();
  console.log(JSON.stringify(result, null, 2));
  await pool.end();
  await closeMongo();
}

main().catch((err) => {
  console.error('[runBackupNow] failed:', err);
  process.exit(1);
});
