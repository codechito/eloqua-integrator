const express = require('express');
const router = express.Router();
const { FeederController } = require('../controllers');
const { 
    verifyInstallation,
    validateQueryParams 
} = require('../middleware');

// Feeder service lifecycle
router.get('/create', 
    validateQueryParams('installId', 'siteId'),
    verifyInstallation,
    FeederController.create
);

router.get('/configure', 
    validateQueryParams('installId', 'siteId', 'instanceId'),
    verifyInstallation,
    FeederController.configure
);

router.post('/configure', 
    validateQueryParams('instanceId'),
    verifyInstallation,
    FeederController.saveConfiguration
);

router.post('/notify', 
    validateQueryParams('instanceId'),
    verifyInstallation,
    FeederController.notify
);

router.post('/copy', 
    validateQueryParams('instanceId'),
    verifyInstallation,
    FeederController.copy
);

router.post('/delete', 
    validateQueryParams('instanceId'),
    verifyInstallation,
    FeederController.delete
);

// Webhook endpoint for incoming SMS (for feeder)
router.get('/incomingsms', FeederController.handleIncomingSms);
router.post('/incomingsms', FeederController.handleIncomingSms);

module.exports = router;