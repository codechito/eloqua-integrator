const express = require('express');
const router = express.Router();
const FeederController = require('../controllers/feederController');
const { verifyInstallation, verifyOAuthToken } = require('../middleware/auth');

// Instance lifecycle endpoints
router.get('/create', 
    verifyInstallation,
    FeederController.create
);

router.get('/configure', 
    verifyInstallation,
    verifyOAuthToken,
    FeederController.configure
);

router.post('/configure', 
    verifyInstallation,
    verifyOAuthToken,
    FeederController.saveConfiguration
);

router.post('/notify', 
    verifyInstallation,
    verifyOAuthToken,
    FeederController.notify
);

router.post('/copy', 
    verifyInstallation,
    FeederController.copy
);

router.post('/delete', 
    verifyInstallation,
    FeederController.delete
);

// AJAX endpoints for configuration
router.get('/ajax/customobjects/:installId/:siteId/customObject',
    FeederController.getCustomObjects
);

router.get('/ajax/customobject/:installId/:siteId/:customObjectId',
    FeederController.getCustomObjectFields
);

// Statistics endpoint (link hits feeder)
router.get('/stats',
    verifyInstallation,
    verifyOAuthToken,
    FeederController.getStats
);

// Incoming SMS feeder — activity stats (called by configure page)
router.get('/inbound/stats/:instanceId',
    verifyInstallation,
    FeederController.getInboundStats
);

module.exports = router;