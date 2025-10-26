const express = require('express');
const router = express.Router();
const { WebhookController } = require('../controllers');
const { verifyWebhookSignature } = require('../middleware');

// Webhook endpoints
router.post('/dlr', 
    verifyWebhookSignature,
    WebhookController.handleDeliveryReport
);

router.post('/reply', 
    verifyWebhookSignature,
    WebhookController.handleSmsReply
);

router.post('/linkhit', 
    verifyWebhookSignature,
    WebhookController.handleLinkHit
);

// Alternative paths (for flexibility)
router.post('/delivery', 
    verifyWebhookSignature,
    WebhookController.handleDeliveryReport
);

router.post('/sms-reply', 
    verifyWebhookSignature,
    WebhookController.handleSmsReply
);

router.post('/link-hit', 
    verifyWebhookSignature,
    WebhookController.handleLinkHit
);

module.exports = router;