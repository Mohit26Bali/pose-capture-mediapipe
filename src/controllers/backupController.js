const asyncHandler = require('../utils/asyncHandler');
const { runBackup } = require('../services/backupService');

const triggerBackup = asyncHandler(async (req, res) => {
  const result = await runBackup();
  res.status(200).json({ message: 'Backup completed', result });
});

module.exports = { triggerBackup };
