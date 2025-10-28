const Consumer = require('../models/Consumer');
const { logger } = require('../utils');

/**
 * Session-based authentication for AJAX calls
 * This middleware checks if user has a valid session from OAuth
 */
async function sessionAuth(req, res, next) {
    const { installId, siteId } = req.params;

    // Check if installId is in session or query
    const sessionInstallId = req.session?.installId || req.query.installId;

    if (!sessionInstallId && !installId) {
        logger.warn('No installId in session or params');
        return res.status(401).json({ 
            error: 'Unauthorized',
            message: 'No valid session. Please reload the configuration page.' 
        });
    }

    try {
        // Verify consumer exists and is active
        const consumer = await Consumer.findOne({ 
            installId: installId || sessionInstallId,
            isActive: true 
        }).select('+oauth_token +oauth_expires_at');

        if (!consumer) {
            return res.status(401).json({ 
                error: 'Unauthorized',
                message: 'Invalid installation' 
            });
        }

        // Check if OAuth token exists
        if (!consumer.oauth_token) {
            return res.status(401).json({ 
                error: 'Unauthorized',
                message: 'OAuth token not found. Please re-authorize.' 
            });
        }

        // Check if token is expired
        if (consumer.oauth_expires_at && new Date() >= consumer.oauth_expires_at) {
            return res.status(401).json({ 
                error: 'Token Expired',
                message: 'OAuth token expired. Please re-authorize.' 
            });
        }

        // Store installId in session for future requests
        req.session.installId = consumer.installId;
        req.session.siteId = consumer.SiteId;

        // Attach consumer to request
        req.consumer = consumer;
        req.eloquaAuth = {
            token: consumer.oauth_token,
            baseUrl: consumer.eloqua_base_url
        };

        next();

    } catch (error) {
        logger.error('Session auth error', {
            error: error.message,
            installId
        });
        res.status(500).json({ 
            error: 'Authentication Error',
            message: error.message 
        });
    }
}

module.exports = sessionAuth;