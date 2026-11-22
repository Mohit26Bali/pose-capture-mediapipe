const express = require('express');
const { upload } = require('../middleware/upload');
const validateUuidParam = require('../middleware/validateUuid');
const { requireApiKey } = require('../middleware/auth');
const { limitUploads, limitReads, limitBackups } = require('../middleware/rateLimit');
const controller = require('../controllers/poseController');
const backupController = require('../controllers/backupController');

const router = express.Router();

// Everything below this line needs the API key (when one is configured).
router.use(requireApiKey);

// Auth runs before the upload middleware so an unauthenticated request never writes a file to disk.
router.post('/extract-pose', limitUploads, upload.single('image'), controller.extractPose);
router.post('/backup/run', limitBackups, backupController.triggerBackup);

router.get('/records', limitReads, controller.listRecords);
router.get('/records/:id', limitReads, validateUuidParam(), controller.getRecord);
router.get('/records/:id/image', limitReads, validateUuidParam(), controller.getRecordImage);
router.put('/records/:id', limitReads, validateUuidParam(), controller.updateRecord);
router.patch('/records/:id', limitReads, validateUuidParam(), controller.updateRecord);
router.delete('/records/:id', limitReads, validateUuidParam(), controller.deleteRecord);

module.exports = router;
