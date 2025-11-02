const express = require('express');
const router = express.Router();
const ActionController = require('../controllers/actionController');
const { verifyInstallation } = require('../middleware/auth');
const sessionAuth = require('../middleware/sessionAuth');

// Create instance
router.get('/create', verifyInstallation, ActionController.create);

// Configure instance
router.get('/configure', verifyInstallation, ActionController.configure);
router.post('/configure', verifyInstallation, ActionController.saveConfiguration);

// Execute action (notify)
router.post('/notify', verifyInstallation, ActionController.notify);

// Retrieve instance configuration - ADD THIS
router.get('/retrieve', verifyInstallation, ActionController.retrieve);

// Copy instance
router.post('/copy', verifyInstallation, ActionController.copy);

// Delete/Remove instance
router.post('/delete', verifyInstallation, ActionController.delete);
router.post('/remove', verifyInstallation, ActionController.delete); // ADD THIS: alias

// Worker status
router.get('/worker/status', ActionController.getWorkerStatus);
router.get('/worker/health', ActionController.getWorkerHealth); // ADD THIS

// AJAX endpoints - use sessionAuth for security
router.get('/ajax/sender-ids/:installId/:siteId', 
    sessionAuth, 
    ActionController.getSenderIds
);

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

router.post('/ajax/testsms/:installId/:siteId/:country/:phone',
    sessionAuth,
    ActionController.testSms
);

module.exports = router;