const Consumer = require('../models/Consumer');
const { logger } = require('../utils');
const OAuthService = require('../services/oauthService');

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
 * Verify OAuth token exists and auto-refresh if expired
 * Checks if consumer has valid OAuth credentials and refreshes if needed
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

        // Fetch consumer with OAuth fields including refresh token
        const consumerWithToken = await Consumer.findById(consumer._id)
            .select('+oauth_token +oauth_expires_at +oauth_refresh_token');

        // Check if OAuth token exists
        if (!consumerWithToken.oauth_token) {
            logger.warn('Missing OAuth token', {
                installId: consumer.installId
            });
            
            // Create reauth error
            const reAuthError = new Error('OAuth authentication required');
            reAuthError.code = 'REAUTH_REQUIRED';
            reAuthError.reAuthUrl = `/eloqua/app/authorize?installId=${consumer.installId}`;
            return next(reAuthError);
        }

        // Check if token is expired or about to expire (5 minutes buffer)
        const tokenExpiryBuffer = 5 * 60 * 1000; // 5 minutes in milliseconds
        const isExpiredOrExpiringSoon = consumerWithToken.oauth_expires_at && 
            new Date() >= new Date(consumerWithToken.oauth_expires_at.getTime() - tokenExpiryBuffer);

        if (isExpiredOrExpiringSoon) {
            logger.info('OAuth token expired or expiring soon, attempting refresh', {
                installId: consumer.installId,
                expiresAt: consumerWithToken.oauth_expires_at,
                now: new Date()
            });

            // Check if refresh token exists
            if (!consumerWithToken.oauth_refresh_token) {
                logger.error('No refresh token available', {
                    installId: consumer.installId
                });
                
                // Create reauth error
                const reAuthError = new Error('OAuth token expired and no refresh token available');
                reAuthError.code = 'REAUTH_REQUIRED';
                reAuthError.reAuthUrl = `/eloqua/app/authorize?installId=${consumer.installId}`;
                return next(reAuthError);
            }

            try {
                // Attempt to refresh the token
                logger.info('Calling OAuthService.refreshAccessToken', {
                    installId: consumer.installId
                });

                const tokenData = await OAuthService.refreshAccessToken(
                    consumerWithToken.oauth_refresh_token
                );

                // Update consumer with new tokens
                consumerWithToken.oauth_token = tokenData.access_token;
                
                // Update refresh token if a new one is provided
                if (tokenData.refresh_token) {
                    consumerWithToken.oauth_refresh_token = tokenData.refresh_token;
                }
                
                // Calculate expiry time (expires_in is in seconds)
                const expiresIn = tokenData.expires_in || 3600; // Default 1 hour
                consumerWithToken.oauth_expires_at = new Date(Date.now() + (expiresIn * 1000));
                
                await consumerWithToken.save();

                logger.info('Successfully refreshed OAuth token', {
                    installId: consumer.installId,
                    newExpiryAt: consumerWithToken.oauth_expires_at
                });

                // Update req.consumer with fresh token
                req.consumer = consumerWithToken;

            } catch (refreshError) {
                logger.error('Failed to refresh OAuth token', {
                    installId: consumer.installId,
                    error: refreshError.message,
                    stack: refreshError.stack
                });
                
                // Create reauth error when refresh fails
                const reAuthError = new Error('OAuth token refresh failed. Please re-authorize.');
                reAuthError.code = 'REAUTH_REQUIRED';
                reAuthError.reAuthUrl = `/eloqua/app/authorize?installId=${consumer.installId}`;
                reAuthError.originalError = refreshError;
                return next(reAuthError);
            }
        } else {
            // Token is still valid, just update req.consumer with token data
            req.consumer = consumerWithToken;
            
            logger.debug('OAuth token is valid', {
                installId: consumer.installId,
                expiresAt: consumerWithToken.oauth_expires_at
            });
        }

        next();
    } catch (error) {
        logger.error('Error verifying OAuth token', {
            error: error.message,
            stack: error.stack
        });
        
        // For unexpected errors, still try to trigger reauth
        const reAuthError = new Error('Failed to verify OAuth token');
        reAuthError.code = 'REAUTH_REQUIRED';
        reAuthError.reAuthUrl = `/eloqua/app/authorize?installId=${req.consumer?.installId || req.query.installId}`;
        reAuthError.originalError = error;
        next(reAuthError);
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