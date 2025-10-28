const express = require('express');
const router = express.Router();
const { DecisionController } = require('../controllers');
const { 
    verifyInstallation,
    verifyOAuthToken,
    validateQueryParams 
} = require('../middleware');

// Decision service lifecycle
router.post('/create', 
    validateQueryParams('installId', 'siteId'),
    verifyInstallation,
    DecisionController.create
);

router.get('/configure', 
    validateQueryParams('installId', 'siteId', 'instanceId'),
    verifyInstallation,
    verifyOAuthToken,
    DecisionController.configure
);

router.post('/configure', 
    validateQueryParams('instanceId'),
    verifyInstallation,
    DecisionController.saveConfiguration
);

router.post('/notify', 
    validateQueryParams('instanceId'),
    verifyInstallation,
    DecisionController.notify
);

router.post('/copy', 
    validateQueryParams('instanceId'),
    verifyInstallation,
    DecisionController.copy
);

router.post('/delete', 
    validateQueryParams('instanceId'),
    verifyInstallation,
    DecisionController.delete
);

module.exports = router;