const Consumer = require('../models/Consumer');
const { logger } = require('../utils');

/**
 * Verify Eloqua installation
 * Checks if installId exists and is active
 */
async function verifyInstallation(req, res, next) {
    try {
        const { installId } = req.query;

        if (!installId) {
            logger.warn('Missing installId in request', {
                path: req.path,
                ip: req.ip
            });
            return res.status(401).json({ 
                error: 'Unauthorized',
                message: 'InstallId is required' 
            });
        }

        const consumer = await Consumer.findOne({ 
            installId, 
            isActive: true 
        });

        if (!consumer) {
            logger.warn('Invalid or inactive installation', {
                installId,
                path: req.path,
                ip: req.ip
            });
            return res.status(401).json({ 
                error: 'Unauthorized',
                message: 'Invalid or inactive installation' 
            });
        }

        // Attach consumer to request
        req.consumer = consumer;
        req.installId = installId;

        logger.debug('Installation verified', {
            installId,
            siteName: consumer.siteName
        });

        next();
    } catch (error) {
        logger.error('Error verifying installation', {
            error: error.message,
            path: req.path
        });
        res.status(500).json({ 
            error: 'Internal Server Error',
            message: 'Failed to verify installation' 
        });
    }
}

/**
 * Verify OAuth token exists
 * Checks if consumer has valid OAuth credentials
 */
async function verifyOAuthToken(req, res, next) {
    try {
        const consumer = req.consumer;

        if (!consumer) {
            return res.status(401).json({ 
                error: 'Unauthorized',
                message: 'Consumer not found' 
            });
        }

        // Fetch consumer with OAuth fields
        const consumerWithToken = await Consumer.findById(consumer._id)
            .select('+oauth_token +oauth_expires_at');

        if (!consumerWithToken.oauth_token) {
            logger.warn('Missing OAuth token', {
                installId: consumer.installId
            });
            return res.status(401).json({ 
                error: 'Unauthorized',
                message: 'OAuth authentication required. Please authorize the app.' 
            });
        }

        // Check if token is expired
        if (consumerWithToken.oauth_expires_at && 
            new Date() >= consumerWithToken.oauth_expires_at) {
            logger.warn('OAuth token expired', {
                installId: consumer.installId,
                expiredAt: consumerWithToken.oauth_expires_at
            });
            return res.status(401).json({ 
                error: 'Unauthorized',
                message: 'OAuth token expired. Please re-authorize the app.' 
            });
        }

        next();
    } catch (error) {
        logger.error('Error verifying OAuth token', {
            error: error.message
        });
        res.status(500).json({ 
            error: 'Internal Server Error',
            message: 'Failed to verify OAuth token' 
        });
    }
}

/**
 * Verify TransmitSMS credentials
 * Checks if consumer has configured TransmitSMS API credentials
 */
async function verifyTransmitSmsCredentials(req, res, next) {
    try {
        const consumer = req.consumer;

        if (!consumer) {
            return res.status(401).json({ 
                error: 'Unauthorized',
                message: 'Consumer not found' 
            });
        }

        if (!consumer.transmitsms_api_key || !consumer.transmitsms_api_secret) {
            logger.warn('Missing TransmitSMS credentials', {
                installId: consumer.installId
            });
            return res.status(400).json({ 
                error: 'Configuration Required',
                message: 'TransmitSMS API credentials not configured. Please configure the app.' 
            });
        }

        next();
    } catch (error) {
        logger.error('Error verifying TransmitSMS credentials', {
            error: error.message
        });
        res.status(500).json({ 
            error: 'Internal Server Error',
            message: 'Failed to verify credentials' 
        });
    }
}

/**
 * Verify webhook signature (if TransmitSMS provides one)
 * This is a placeholder for webhook verification
 */
function verifyWebhookSignature(req, res, next) {
    // TransmitSMS webhook signature verification
    // Implement if TransmitSMS provides signature verification
    
    logger.debug('Webhook received', {
        path: req.path,
        ip: req.ip,
        body: req.body
    });

    next();
}

/**
 * Rate limiting middleware
 * Basic rate limiting to prevent abuse
 */
const rateLimitMap = new Map();

function rateLimit(maxRequests = 100, windowMs = 60000) {
    return (req, res, next) => {
        const key = req.ip;
        const now = Date.now();
        
        if (!rateLimitMap.has(key)) {
            rateLimitMap.set(key, {
                count: 1,
                resetTime: now + windowMs
            });
            return next();
        }
        
        const limitData = rateLimitMap.get(key);
        
        if (now > limitData.resetTime) {
            limitData.count = 1;
            limitData.resetTime = now + windowMs;
            return next();
        }
        
        if (limitData.count >= maxRequests) {
            logger.warn('Rate limit exceeded', {
                ip: req.ip,
                path: req.path
            });
            return res.status(429).json({
                error: 'Too Many Requests',
                message: 'Rate limit exceeded. Please try again later.'
            });
        }
        
        limitData.count++;
        next();
    };
}

// Clean up rate limit map periodically
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of rateLimitMap.entries()) {
        if (now > value.resetTime) {
            rateLimitMap.delete(key);
        }
    }
}, 60000); // Clean up every minute

module.exports = {
    verifyInstallation,
    verifyOAuthToken,
    verifyTransmitSmsCredentials,
    verifyWebhookSignature,
    rateLimit
};