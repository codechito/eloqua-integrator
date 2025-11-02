const express = require('express');
const router = express.Router();
const ActionController = require('../controllers/actionController');
const { 
    verifyInstallation,
    verifyOAuthToken,
    verifyTransmitSmsCredentials
} = require('../middleware/auth');
const sessionAuth = require('../middleware/sessionAuth');

// Instance lifecycle endpoints (use verifyInstallation + verifyOAuthToken)
router.get('/create', 
    verifyInstallation,
    ActionController.create
);

router.get('/configure', 
    verifyInstallation,
    verifyOAuthToken,
    ActionController.configure
);

router.post('/configure', 
    verifyInstallation,
    verifyOAuthToken,
    ActionController.saveConfiguration
);

router.post('/notify', 
    verifyInstallation,
    verifyOAuthToken,
    verifyTransmitSmsCredentials,
    ActionController.notify
);

router.post('/copy', 
    verifyInstallation,
    ActionController.copy
);

router.post('/delete', 
    verifyInstallation,
    ActionController.delete
);

// AJAX endpoints (use sessionAuth - lightweight, no token refresh)
router.get('/ajax/customobjects/:installId/:siteId/customObject',
    sessionAuth,
    ActionController.getCustomObjects
);

router.get('/ajax/customobject/:installId/:siteId/:customObjectId',
    sessionAuth,
    ActionController.getCustomObjectFields
);

router.get('/ajax/contactfields/:installId/:siteId',
    sessionAuth,
    ActionController.getContactFields
);

router.get('/ajax/sender-ids/:installId/:siteId',
    sessionAuth,
    ActionController.getSenderIds
);

router.post('/ajax/testsms/:installId/:siteId/:country/:phone',
    sessionAuth,
    ActionController.testSms
);

// Worker status
router.get('/worker/status',
    verifyInstallation,
    ActionController.getWorkerStatus
);

module.exports = router;