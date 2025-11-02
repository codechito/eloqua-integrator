const { Consumer } = require('../models');
const { EloquaService, OAuthService } = require('../services');
const { logger, generateId } = require('../utils');
const { asyncHandler } = require('../middleware');

class AppController {

    /**
     * Install app
     * GET /eloqua/app/install
     */
    static install = asyncHandler(async (req, res) => {
        const { siteName, siteId, callbackUrl } = req.query;

        logger.info('App install request received', {
            siteName,
            siteId,
            callbackUrl
        });

        if (!siteName || !siteId) {
            return res.status(400).json({
                error: 'Missing required parameters: siteName and siteId'
            });
        }

        // Generate unique installId
        const installId = generateId();

        // Create new consumer
        const consumer = new Consumer({
            installId,
            siteName,
            siteId,
            isActive: true
        });

        await consumer.save();

        logger.info('Consumer created', {
            installId,
            siteName,
            siteId
        });

        // Return install response
        res.json({
            success: true,
            installId,
            callbackUrl: callbackUrl || `${process.env.APP_BASE_URL}/eloqua/app/config?installId=${installId}`
        });
    });

    /**
     * Uninstall app
     * POST /eloqua/app/uninstall
     */
    static uninstall = asyncHandler(async (req, res) => {
        const { installId } = req.query;

        logger.info('App uninstall request', { installId });

        const consumer = await Consumer.findOne({ installId });

        if (!consumer) {
            return res.status(404).json({
                error: 'Installation not found'
            });
        }

        // Soft delete - mark as inactive
        consumer.isActive = false;
        await consumer.save();

        logger.info('Consumer marked as inactive', { installId });

        res.json({
            success: true,
            message: 'App uninstalled successfully'
        });
    });

    /**
     * Get app status
     * GET /eloqua/app/status
     */
    static status = asyncHandler(async (req, res) => {
        const { installId } = req.query;

        logger.info('App status check', { installId });

        const consumer = await Consumer.findOne({ installId });

        if (!consumer) {
            return res.status(404).json({
                error: 'Installation not found'
            });
        }

        res.json({
            success: true,
            isActive: consumer.isActive,
            siteName: consumer.siteName,
            hasOAuthToken: !!consumer.oauth_token,
            hasTransmitSmsCredentials: !!(consumer.transmitsms_api_key && consumer.transmitsms_api_secret)
        });
    });

    /**
     * Get app configuration page
     * GET /eloqua/app/config
     */
    static getConfig = asyncHandler(async (req, res) => {
        const { installId } = req.query;

        logger.info('Loading app configuration page', { installId });

        const consumer = await Consumer.findOne({ installId });

        if (!consumer) {
            return res.status(404).send('Installation not found');
        }

        // Store in session
        req.session.installId = installId;

        // Get countries data
        const countries = require('../data/countries.json');

        // Get custom objects if OAuth token exists
        let custom_objects = { elements: [] };
        
        const consumerWithToken = await Consumer.findOne({ installId })
            .select('+oauth_token');

        if (consumerWithToken && consumerWithToken.oauth_token) {
            try {
                const eloquaService = new EloquaService(installId, consumer.siteId);
                await eloquaService.initialize();
                custom_objects = await eloquaService.getCustomObjects('', 100);
            } catch (error) {
                logger.warn('Could not fetch custom objects for config', {
                    error: error.message
                });
            }
        }

        res.render('app-config', {
            consumer: consumer.toObject(),
            countries,
            custom_objects,
            success: req.query.success === 'true'
        });
    });

    /**
     * Save app configuration
     * POST /eloqua/app/config
     */
    static saveConfig = asyncHandler(async (req, res) => {
        const { installId } = req.query;
        const { consumer: consumerData } = req.body;

        logger.info('Saving app configuration', { installId });

        const consumer = await Consumer.findOne({ installId });

        if (!consumer) {
            return res.status(404).json({
                error: 'Installation not found'
            });
        }

        // Update consumer configuration
        if (consumerData.transmitsms_api_key) {
            consumer.transmitsms_api_key = consumerData.transmitsms_api_key;
        }

        if (consumerData.transmitsms_api_secret) {
            consumer.transmitsms_api_secret = consumerData.transmitsms_api_secret;
        }

        if (consumerData.default_country) {
            consumer.default_country = consumerData.default_country;
        }

        // Update callback URLs
        const baseUrl = process.env.APP_BASE_URL || 'https://eloqua-integrator.onrender.com';
        
        consumer.dlr_callback = `${baseUrl}/webhooks/dlr`;
        consumer.reply_callback = `${baseUrl}/webhooks/reply`;
        consumer.link_hits_callback = `${baseUrl}/webhooks/linkhit`;

        // Update action configurations if provided
        if (consumerData.actions) {
            consumer.actions = {
                ...consumer.actions,
                ...consumerData.actions
            };
        }

        await consumer.save();

        logger.info('App configuration saved', { installId });

        res.json({
            success: true,
            message: 'Configuration saved successfully'
        });
    });

    /**
     * Authorize with Eloqua (OAuth)
     * GET /eloqua/app/authorize
     */
    static authorize = asyncHandler(async (req, res) => {
        const { installId } = req.query;

        logger.info('OAuth authorization initiated', { installId });

        if (!installId) {
            return res.status(400).send('InstallId is required');
        }

        const consumer = await Consumer.findOne({ installId });

        if (!consumer) {
            return res.status(404).send('Installation not found');
        }

        // Store installId in session for callback
        req.session.installId = installId;

        // Generate authorization URL
        const authUrl = OAuthService.getAuthorizationUrl(installId);

        logger.info('Redirecting to Eloqua authorization', {
            installId,
            authUrl
        });

        // Redirect to Eloqua authorization page
        res.redirect(authUrl);
    });

    /**
     * OAuth callback handler
     * GET /eloqua/app/oauth/callback
     */
    static oauthCallback = asyncHandler(async (req, res) => {
        const { code, state } = req.query;

        logger.info('OAuth callback received', { 
            hasCode: !!code, 
            hasState: !!state,
            state 
        });

        if (!code) {
            logger.error('No authorization code received');
            return res.status(400).send('Authorization code missing');
        }

        try {
            // Exchange code for token
            logger.info('Exchanging authorization code for token');
            
            const tokenData = await OAuthService.getAccessToken(code);

            logger.info('Token received from Eloqua', {
                hasAccessToken: !!tokenData.access_token,
                hasRefreshToken: !!tokenData.refresh_token,
                expiresIn: tokenData.expires_in,
                tokenType: tokenData.token_type,
                tokenLength: tokenData.access_token?.length || 0,
                tokenPreview: tokenData.access_token 
                    ? `${tokenData.access_token.substring(0, 10)}...${tokenData.access_token.substring(tokenData.access_token.length - 10)}`
                    : 'NO_TOKEN'
            });

            // Get installId from state or session
            const installId = state || req.session.installId;

            if (!installId) {
                logger.error('No installId found in state or session');
                return res.status(400).send('Installation ID missing');
            }

            // Find and update consumer
            const consumer = await Consumer.findOne({ installId });

            if (!consumer) {
                logger.error('Consumer not found', { installId });
                return res.status(404).send('Installation not found');
            }

            logger.info('Consumer found, updating tokens', {
                installId,
                siteName: consumer.siteName
            });

            // Calculate token expiry
            const expiresIn = tokenData.expires_in || 28800; // Default 8 hours
            const expiresAt = new Date(Date.now() + (expiresIn * 1000));

            // Update consumer with tokens
            consumer.oauth_token = tokenData.access_token;
            consumer.oauth_refresh_token = tokenData.refresh_token;
            consumer.oauth_expires_at = expiresAt;

            await consumer.save();

            logger.info('OAuth tokens saved to database', {
                installId,
                expiresAt,
                expiresInMinutes: Math.floor(expiresIn / 60),
                hasRefreshToken: !!tokenData.refresh_token
            });

            // Verify tokens were saved by querying again
            const verifyConsumer = await Consumer.findOne({ installId })
                .select('+oauth_token +oauth_refresh_token +oauth_expires_at');

            logger.info('Verified tokens in database', {
                installId,
                hasToken: !!verifyConsumer.oauth_token,
                hasRefreshToken: !!verifyConsumer.oauth_refresh_token,
                tokenLength: verifyConsumer.oauth_token?.length || 0,
                expiresAt: verifyConsumer.oauth_expires_at
            });

            // Redirect to success page
            res.redirect(`/eloqua/app/config?installId=${installId}&success=true`);

        } catch (error) {
            logger.error('OAuth callback error', {
                error: error.message,
                stack: error.stack,
                response: error.response?.data
            });
            res.status(500).send('OAuth authentication failed: ' + error.message);
        }
    });

    /**
     * Debug endpoint - Check OAuth token status
     * GET /eloqua/app/debug/token/:installId
     */
    static debugToken = asyncHandler(async (req, res) => {
        const { installId } = req.params;

        logger.info('Debug token status check', { installId });

        const consumer = await Consumer.findOne({ installId })
            .select('+oauth_token +oauth_refresh_token +oauth_expires_at');

        if (!consumer) {
            return res.status(404).json({ error: 'Consumer not found' });
        }

        const tokenPreview = consumer.oauth_token 
            ? `${consumer.oauth_token.substring(0, 15)}...${consumer.oauth_token.substring(consumer.oauth_token.length - 15)}`
            : 'NO_TOKEN';

        const now = new Date();
        const isExpired = consumer.oauth_expires_at ? now >= consumer.oauth_expires_at : null;
        const timeUntilExpiry = consumer.oauth_expires_at 
            ? Math.floor((consumer.oauth_expires_at.getTime() - now.getTime()) / 1000 / 60)
            : null;

        res.json({
            installId,
            siteName: consumer.siteName,
            siteId: consumer.siteId,
            hasToken: !!consumer.oauth_token,
            tokenLength: consumer.oauth_token?.length || 0,
            tokenPreview,
            hasRefreshToken: !!consumer.oauth_refresh_token,
            expiresAt: consumer.oauth_expires_at,
            isExpired,
            timeUntilExpiryMinutes: timeUntilExpiry,
            now: now
        });
    });

    /**
     * Force token refresh
     * POST /eloqua/app/refresh-token
     */
    static refreshToken = asyncHandler(async (req, res) => {
        const { installId } = req.query;

        logger.info('Manual token refresh requested', { installId });

        const consumer = await Consumer.findOne({ installId })
            .select('+oauth_refresh_token +oauth_token +oauth_expires_at');

        if (!consumer) {
            return res.status(404).json({ error: 'Consumer not found' });
        }

        if (!consumer.oauth_refresh_token) {
            return res.status(400).json({ 
                error: 'No refresh token available. Please re-authorize.',
                reAuthUrl: `/eloqua/app/authorize?installId=${installId}`
            });
        }

        try {
            logger.info('Calling OAuthService.refreshAccessToken');
            
            const tokenData = await OAuthService.refreshAccessToken(consumer.oauth_refresh_token);

            logger.info('Token refresh response received', {
                hasAccessToken: !!tokenData.access_token,
                hasRefreshToken: !!tokenData.refresh_token,
                expiresIn: tokenData.expires_in
            });

            consumer.oauth_token = tokenData.access_token;
            
            if (tokenData.refresh_token) {
                consumer.oauth_refresh_token = tokenData.refresh_token;
            }
            
            const expiresIn = tokenData.expires_in || 28800;
            consumer.oauth_expires_at = new Date(Date.now() + (expiresIn * 1000));

            await consumer.save();

            logger.info('Token refreshed and saved', {
                installId,
                expiresAt: consumer.oauth_expires_at
            });

            res.json({
                success: true,
                message: 'Token refreshed successfully',
                expiresAt: consumer.oauth_expires_at,
                expiresInMinutes: Math.floor(expiresIn / 60)
            });

        } catch (error) {
            logger.error('Failed to refresh token', { 
                installId,
                error: error.message,
                stack: error.stack
            });
            
            res.status(500).json({ 
                error: 'Token refresh failed. Please re-authorize.',
                details: error.message,
                reAuthUrl: `/eloqua/app/authorize?installId=${installId}`
            });
        }
    });

    /**
     * AJAX - Get custom objects
     * GET /eloqua/app/ajax/customobjects/:installId/:siteId/customObject
     */
    static getCustomObjects = asyncHandler(async (req, res) => {
        const { installId, siteId } = req.params;
        const { search = '', count = 50 } = req.query;

        logger.debug('AJAX: Fetching custom objects for app config', { 
            installId, 
            search, 
            count 
        });

        const eloquaService = new EloquaService(installId, siteId);
        await eloquaService.initialize();
        
        try {
            const customObjects = await eloquaService.getCustomObjects(search, count);

            logger.debug('Custom objects fetched for app', { 
                count: customObjects.elements?.length || 0 
            });

            res.json(customObjects);
        } catch (error) {
            logger.error('Error fetching custom objects for app', {
                installId,
                error: error.message
            });

            res.status(500).json({
                error: 'Failed to fetch custom objects',
                message: error.message,
                elements: []
            });
        }
    });

    /**
     * AJAX - Get custom object fields
     * GET /eloqua/app/ajax/customobject/:installId/:siteId/:customObjectId
     */
    static getCustomObjectFields = asyncHandler(async (req, res) => {
        const { installId, siteId, customObjectId } = req.params;

        logger.debug('AJAX: Fetching custom object fields for app', { 
            installId, 
            customObjectId 
        });

        const eloquaService = new EloquaService(installId, siteId);
        await eloquaService.initialize();
        
        try {
            const customObject = await eloquaService.getCustomObject(customObjectId);

            logger.debug('Custom object fields fetched for app', { 
                fieldCount: customObject.fields?.length || 0 
            });

            res.json(customObject);
        } catch (error) {
            logger.error('Error fetching custom object fields for app', {
                installId,
                customObjectId,
                error: error.message
            });

            res.status(500).json({
                error: 'Failed to fetch fields',
                message: error.message,
                fields: []
            });
        }
    });
}

module.exports = AppController;