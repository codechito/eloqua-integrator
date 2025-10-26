const express = require('express');
const router = express.Router();
const { ActionController } = require('../controllers');
const { 
    verifyInstallation,
    verifyOAuthToken,
    verifyTransmitSmsCredentials,
    validateQueryParams 
} = require('../middleware');

// Action service lifecycle
router.get('/create', 
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

// AJAX endpoints
router.get('/ajax/customobjects/:installId/:siteId/customObject',
    verifyInstallation,
    verifyOAuthToken,
    ActionController.getCustomObjects
);

router.get('/ajax/customobject/:installId/:siteId/:customObjectId',
    verifyInstallation,
    verifyOAuthToken,
    ActionController.getCustomObjectFields
);

router.post('/ajax/testsms/:installId/:siteId/:country/:phone',
    verifyInstallation,
    verifyTransmitSmsCredentials,
    ActionController.testSms
);

module.exports = router;