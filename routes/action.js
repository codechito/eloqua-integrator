const express = require('express');
const router = express.Router();
const { ActionController } = require('../controllers');
const { 
    verifyInstallation,
    verifyOAuthToken,
    verifyTransmitSmsCredentials,
    validateQueryParams 
} = require('../middleware');
const sessionAuth = require('../middleware/sessionAuth');

// Action service lifecycle
router.post('/create', 
    validateQueryParams('installId', 'siteId'),
    verifyInstallation,
    ActionController.create
);

router.get('/configure', 
    validateQueryParams('installId', 'siteId', 'instanceId'),
    verifyInstallation,
    verifyOAuthToken,
    ActionController.configure
);

router.post('/configure', 
    validateQueryParams('instanceId'),
    verifyInstallation,
    ActionController.saveConfiguration
);

router.post('/notify', 
    validateQueryParams('instanceId'),
    verifyInstallation,
    verifyOAuthToken,
    verifyTransmitSmsCredentials,
    ActionController.notify
);

router.post('/copy', 
    validateQueryParams('instanceId'),
    verifyInstallation,
    ActionController.copy
);

router.post('/delete', 
    validateQueryParams('instanceId'),
    verifyInstallation,
    ActionController.delete
);

// AJAX endpoints with session auth (NO verifyInstallation or verifyOAuthToken)
router.get('/ajax/customobjects/:installId/:siteId/customObject',
    sessionAuth,  // Use session-based auth instead
    ActionController.getCustomObjects
);

router.get('/ajax/customobject/:installId/:siteId/:customObjectId',
    sessionAuth,  // Use session-based auth instead
    ActionController.getCustomObjectFields
);

router.post('/ajax/testsms/:installId/:siteId/:country/:phone',
    sessionAuth,
    ActionController.testSms
);

module.exports = router;