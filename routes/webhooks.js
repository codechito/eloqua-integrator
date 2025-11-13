const express = require('express');
const router = express.Router();
const { WebhookController } = require('../controllers');
const { verifyWebhookSignature } = require('../middleware');

// Webhook endpoints
router.get('/dlr', 
    verifyWebhookSignature,
    WebhookController.handleDeliveryReport
);

router.get('/reply', 
    verifyWebhookSignature,
    WebhookController.handleSmsReply
);

router.get('/linkhit', 
    verifyWebhookSignature,
    WebhookController.handleLinkHit
);

// Alternative paths (for flexibility)
router.get('/delivery', 
    verifyWebhookSignature,
    WebhookController.handleDeliveryReport
);

router.get('/sms-reply', 
    verifyWebhookSignature,
    WebhookController.handleSmsReply
);

router.get('/link-hit', 
    verifyWebhookSignature,
    WebhookController.handleLinkHit
);

module.exports = router;