const express = require('express');
const router = express.Router();
const DecisionController = require('../controllers/decisionController');
const { verifyInstallation } = require('../middleware/auth');
const sessionAuth = require('../middleware/sessionAuth');

// Create instance
router.post('/create', verifyInstallation, DecisionController.create);

// Configure instance
router.get('/configure', verifyInstallation, DecisionController.configure);
router.post('/configure', verifyInstallation, DecisionController.saveConfiguration);

// Execute decision (notify)
router.post('/notify', verifyInstallation, DecisionController.notify);

// Retrieve instance configuration
router.get('/retrieve', verifyInstallation, DecisionController.retrieve);

// Copy instance
router.post('/copy', verifyInstallation, DecisionController.copy);

// Delete/Remove instance
router.post('/delete', verifyInstallation, DecisionController.delete);
router.post('/remove', verifyInstallation, DecisionController.delete);

// Report routes - NEW
router.get('/report/:instanceId', sessionAuth, DecisionController.getReportPage);
router.get('/report/:instanceId/data', sessionAuth, DecisionController.getReport);
router.get('/report/:instanceId/csv', DecisionController.downloadReportCSV);

// AJAX endpoints
router.get('/ajax/customobjects/:installId/:siteId/customObject',
    sessionAuth,
    DecisionController.getCustomObjects
);

router.get('/ajax/customobject/:installId/:siteId/:customObjectId',
    sessionAuth,
    DecisionController.getCustomObjectFields
);

module.exports = router;