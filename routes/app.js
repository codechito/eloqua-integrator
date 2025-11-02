const express = require('express');
const router = express.Router();
const AppController = require('../controllers/appController');
const { verifyInstallation, verifyOAuthToken } = require('../middleware/auth');

// App lifecycle endpoints
router.get('/install', AppController.install);

router.post('/uninstall', 
    verifyInstallation,
    AppController.uninstall
);

router.get('/status', 
    verifyInstallation,
    AppController.status
);

// Configuration endpoints
router.get('/config', 
    verifyInstallation,
    AppController.getConfig
);

router.post('/config', 
    verifyInstallation,
    AppController.saveConfig
);

// OAuth endpoints
router.get('/authorize', AppController.authorize);
router.get('/oauth/callback', AppController.oauthCallback);

// Debug endpoints
router.get('/debug/token/:installId', AppController.debugToken);
router.post('/refresh-token', AppController.refreshToken);

// AJAX endpoints for configuration
router.get('/ajax/customobjects/:installId/:siteId/customObject',
    AppController.getCustomObjects
);

router.get('/ajax/customobject/:installId/:siteId/:customObjectId',
    AppController.getCustomObjectFields
);

module.exports = router;