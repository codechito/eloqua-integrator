// middleware/auth.js - COMPLETE FIXED WITH SITEID SUPPORT

const { Consumer } = require('../models');
const { logger } = require('../utils');
const OAuthService = require('../services/oauthService');
const { getConsumerBySiteId } = require('../utils/eloqua');

/**
 * Verify Eloqua installation
 * FIXED: Uses SiteId as primary identifier
 */
async function verifyInstallation(req, res, next) {
    try {
        const installId = req.query.installId || req.params.installId;
        const siteId = req.query.siteId || req.query.SiteId || req.params.siteId;

        if (!installId) {
            logger.warn('Missing installId in request', {
                path: req.path,
                method: req.method,
                hasSiteId: !!siteId
            });
            return res.status(401).json({ 
                error: 'Unauthorized',
                message: 'InstallId is required' 
            });
        }

        // ✅ Use SiteId-based lookup if available
        let consumer;
        if (siteId) {
            logger.debug('Looking up consumer by SiteId', {
                installId,
                siteId
            });
            consumer = await getConsumerBySiteId(installId, siteId);
        } else {
            // Fallback to installId-only lookup
            logger.debug('Looking up consumer by installId only', {
                installId
            });
            consumer = await Consumer.findOne({ 
                installId, 
                isActive: true 
            });
        }

        if (!consumer) {
            logger.warn('Invalid or inactive installation', { 
                installId,
                siteId,
                path: req.path
            });
            return res.status(401).json({ 
                error: 'Unauthorized',
                message: 'Invalid or inactive installation' 
            });
        }

        req.consumer = consumer;
        req.installId = consumer.installId; // Use updated installId
        req.siteId = consumer.SiteId;

        logger.debug('Installation verified', {
            installId: consumer.installId,
            siteId: consumer.SiteId,
            siteName: consumer.siteName
        });

        next();
    } catch (error) {
        logger.error('Error verifying installation', { 
            error: error.message,
            stack: error.stack
        });
        res.status(500).json({ 
            error: 'Internal Server Error',
            message: 'Failed to verify installation' 
        });
    }
}

/**
 * Verify OAuth token and auto-refresh if expired
 * FIXED: Properly handles token selection
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

        // ✅ Fetch consumer with OAuth fields (they're select: false by default)
        const consumerWithToken = await Consumer.findById(consumer._id)
            .select('+oauth_token +oauth_expires_at +oauth_refresh_token');

        if (!consumerWithToken) {
            logger.error('Consumer not found in database', {
                consumerId: consumer._id
            });
            return res.status(401).json({ 
                error: 'Unauthorized',
                message: 'Consumer not found' 
            });
        }

        // Check if OAuth token exists
        if (!consumerWithToken.oauth_token) {
            logger.warn('Missing OAuth token', { 
                installId: consumer.installId,
                siteId: consumer.SiteId
            });
            
            const reAuthError = new Error('OAuth authentication required');
            reAuthError.code = 'REAUTH_REQUIRED';
            reAuthError.reAuthUrl = `/eloqua/app/authorize?installId=${consumer.installId}&SiteId=${consumer.SiteId}`;
            return next(reAuthError);
        }

        // Check token expiry
        const tokenExpiryBuffer = 5 * 60 * 1000; // 5 minutes
        const now = new Date();
        const expiresAt = consumerWithToken.oauth_expires_at;
        
        if (!expiresAt) {
            logger.warn('No token expiry date set', {
                installId: consumer.installId,
                siteId: consumer.SiteId
            });
            // Token exists but no expiry - assume it's valid for now
            req.consumer = consumerWithToken;
            return next();
        }

        const isExpiredOrExpiringSoon = now >= new Date(expiresAt.getTime() - tokenExpiryBuffer);
        const minutesUntilExpiry = expiresAt ? Math.round((expiresAt - now) / 60000) : 'N/A';

        logger.debug('Token expiry check', {
            installId: consumer.installId,
            siteId: consumer.SiteId,
            now: now.toISOString(),
            expiresAt: expiresAt?.toISOString(),
            isExpiredOrExpiringSoon,
            minutesUntilExpiry
        });

        if (isExpiredOrExpiringSoon) {
            logger.info('OAuth token expired or expiring soon, attempting refresh', {
                installId: consumer.installId,
                siteId: consumer.SiteId,
                expiresAt: expiresAt?.toISOString(),
                minutesUntilExpiry
            });

            if (!consumerWithToken.oauth_refresh_token) {
                logger.error('No refresh token available', { 
                    installId: consumer.installId,
                    siteId: consumer.SiteId
                });
                
                const reAuthError = new Error('OAuth token expired and no refresh token available');
                reAuthError.code = 'REAUTH_REQUIRED';
                reAuthError.reAuthUrl = `/eloqua/app/authorize?installId=${consumer.installId}&SiteId=${consumer.SiteId}`;
                return next(reAuthError);
            }

            try {
                logger.info('Calling OAuth refresh token endpoint', {
                    installId: consumer.installId,
                    siteId: consumer.SiteId
                });

                const tokenData = await OAuthService.refreshAccessToken(
                    consumerWithToken.oauth_refresh_token
                );

                logger.info('Token refresh successful', {
                    installId: consumer.installId,
                    siteId: consumer.SiteId,
                    hasAccessToken: !!tokenData.access_token,
                    hasRefreshToken: !!tokenData.refresh_token,
                    expiresIn: tokenData.expires_in
                });

                // Update tokens
                consumerWithToken.oauth_token = tokenData.access_token;
                
                if (tokenData.refresh_token) {
                    consumerWithToken.oauth_refresh_token = tokenData.refresh_token;
                }
                
                const expiresIn = tokenData.expires_in || 28800; // Default 8 hours
                consumerWithToken.oauth_expires_at = new Date(Date.now() + (expiresIn * 1000));
                
                await consumerWithToken.save();

                logger.info('OAuth token refreshed and saved', {
                    installId: consumer.installId,
                    siteId: consumer.SiteId,
                    newExpiresAt: consumerWithToken.oauth_expires_at.toISOString()
                });

                req.consumer = consumerWithToken;

            } catch (refreshError) {
                logger.error('Failed to refresh OAuth token', {
                    installId: consumer.installId,
                    siteId: consumer.SiteId,
                    error: refreshError.message,
                    response: refreshError.response?.data,
                    status: refreshError.response?.status,
                    stack: refreshError.stack
                });
                
                const reAuthError = new Error('OAuth token refresh failed. Please re-authorize.');
                reAuthError.code = 'REAUTH_REQUIRED';
                reAuthError.reAuthUrl = `/eloqua/app/authorize?installId=${consumer.installId}&SiteId=${consumer.SiteId}`;
                reAuthError.originalError = refreshError;
                return next(reAuthError);
            }
        } else {
            // Token is still valid
            req.consumer = consumerWithToken;
            
            logger.debug('OAuth token is valid', {
                installId: consumer.installId,
                siteId: consumer.SiteId,
                expiresAt: expiresAt?.toISOString(),
                minutesUntilExpiry
            });
        }

        next();
    } catch (error) {
        logger.error('Error verifying OAuth token', { 
            error: error.message,
            stack: error.stack 
        });
        
        const reAuthError = new Error('Failed to verify OAuth token');
        reAuthError.code = 'REAUTH_REQUIRED';
        reAuthError.reAuthUrl = `/eloqua/app/authorize?installId=${req.consumer?.installId}&SiteId=${req.consumer?.SiteId}`;
        reAuthError.originalError = error;
        next(reAuthError);
    }
}

/**
 * Verify TransmitSMS credentials
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

        // Get credentials (they're select: false by default)
        const consumerWithCreds = await Consumer.findById(consumer._id)
            .select('+transmitsms_api_key +transmitsms_api_secret');

        if (!consumerWithCreds.transmitsms_api_key || !consumerWithCreds.transmitsms_api_secret) {
            logger.warn('Missing TransmitSMS credentials', { 
                installId: consumer.installId,
                siteId: consumer.SiteId
            });
            return res.status(400).json({ 
                error: 'Configuration Required',
                message: 'TransmitSMS API credentials not configured' 
            });
        }

        req.consumer = consumerWithCreds;
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
 * Verify webhook signature
 */
function verifyWebhookSignature(req, res, next) {
    logger.debug('Webhook received', {
        path: req.path,
        ip: req.ip,
        body: req.body
    });
    next();
}

/**
 * Rate limiting
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

// Cleanup rate limit map periodically
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of rateLimitMap.entries()) {
        if (now > value.resetTime) {
            rateLimitMap.delete(key);
        }
    }
}, 60000);

module.exports = {
    verifyInstallation,
    verifyOAuthToken,
    verifyTransmitSmsCredentials,
    verifyWebhookSignature,
    rateLimit
};