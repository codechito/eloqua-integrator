const express = require('express');
const router = express.Router();
const AppController = require('../controllers/appController');
const { verifyInstallation } = require('../middleware/auth');
const sessionAuth = require('../middleware/sessionAuth');

// Install - accepts both GET and POST
router.get('/install', AppController.install);
router.post('/install', AppController.install);

// Uninstall - accepts both GET and POST
router.get('/uninstall', verifyInstallation, AppController.uninstall);
router.post('/uninstall', verifyInstallation, AppController.uninstall);

// Status
router.get('/status', verifyInstallation, AppController.status);

// Configuration
router.get('/config', verifyInstallation, AppController.getConfig);
router.post('/config', verifyInstallation, AppController.saveConfig);

// OAuth
router.get('/authorize', AppController.authorize);
router.get('/oauth/callback', AppController.oauthCallback);

// Token management
router.post('/refresh-token', verifyInstallation, AppController.refreshToken);

// Debug (remove in production)
router.get('/debug/token/:installId', AppController.debugToken);

// AJAX endpoints
router.get('/ajax/customobjects/:installId/:siteId/customObject',
    sessionAuth,
    AppController.getCustomObjects
);

router.get('/ajax/customobject/:installId/:siteId/:customObjectId',
    sessionAuth,
    AppController.getCustomObjectFields
);

module.exports = router;