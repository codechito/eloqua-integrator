const { Consumer } = require('../models');
const { logger } = require('../utils');

/**
 * Session-based authentication for AJAX calls
 * Uses stored session data instead of query params
 */
async function sessionAuth(req, res, next) {
    try {

        const installId = req.session?.installId || req.query?.installId || req.params?.installId;
        const siteId = req.session?.siteId || req.query?.siteId || req.params?.siteId;

        logger.debug('Session auth check', {
            installId,
            siteId,
            hasSession: !!req.session,
            sessionInstallId: req.session?.installId
        });

        if (!installId) {
            logger.warn('Missing installId in AJAX request');
            return res.status(401).json({ 
                error: 'Unauthorized',
                message: 'InstallId is required' 
            });
        }

        // Find consumer with OAuth token
        const consumer = await Consumer.findOne({ 
            installId, 
            isActive: true 
        }).select('+oauth_token +oauth_expires_at +oauth_refresh_token');

        if (!consumer) {
            logger.warn('Consumer not found for AJAX request', { installId });
            return res.status(401).json({ 
                error: 'Unauthorized',
                message: 'Invalid installation' 
            });
        }

        // Check if OAuth token exists
        if (!consumer.oauth_token) {
            logger.warn('No OAuth token for consumer', { installId });
            return res.status(401).json({ 
                error: 'Unauthorized',
                message: 'OAuth token not found. Please re-authorize the app.',
                reAuthRequired: true
            });
        }

        // Check if token is expired
        if (consumer.oauth_expires_at && new Date() >= consumer.oauth_expires_at) {
            logger.warn('OAuth token expired for consumer', {
                installId,
                expiresAt: consumer.oauth_expires_at,
                now: new Date()
            });
            
            return res.status(401).json({ 
                error: 'Unauthorized',
                message: 'OAuth token expired. Please refresh the page.',
                reAuthRequired: true
            });
        }

        // Attach consumer to request
        req.consumer = consumer;
        req.installId = installId;
        req.siteId = siteId;

        logger.debug('Session auth successful', {
            installId,
            hasToken: !!consumer.oauth_token,
            expiresAt: consumer.oauth_expires_at
        });

        next();
    } catch (error) {
        logger.error('Session auth error', {
            error: error.message,
            stack: error.stack
        });
        
        res.status(500).json({ 
            error: 'Internal Server Error',
            message: 'Authentication failed' 
        });
    }
}

module.exports = sessionAuth;