const express = require('express');
const router = express.Router();
const { AppController } = require('../controllers');
const { verifyInstallation } = require('../middleware');

// OAuth routes (no verification needed)
router.get('/oauth/callback', AppController.oauthCallback);
router.get('/authorize', AppController.authorize);

// App lifecycle routes (with verification)
router.post('/install', verifyInstallation, AppController.install);
router.post('/uninstall', verifyInstallation, AppController.uninstall);
router.get('/configure', verifyInstallation, AppController.configure);
router.post('/configure', verifyInstallation, AppController.saveConfiguration);
router.get('/status', verifyInstallation, AppController.status);

module.exports = router;