// controllers/appController.js - COMPLETE WITH SITEID LOOKUP

const { Consumer } = require('../models');
const { EloquaService, OAuthService } = require('../services');
const { logger, generateId } = require('../utils');
const { asyncHandler } = require('../middleware');
const { getConsumerBySiteId, getOrCreateConsumer } = require('../utils/eloqua');

class AppController {

    /**
     * Install app
     * GET or POST /eloqua/app/install
     * FIXED: Uses SiteId-based lookup
     */
    static install = asyncHandler(async (req, res) => {
        const { 
            siteName, 
            siteId,
            callback,
            callbackUrl,
            installId: eloquaInstallId 
        } = req.query;

        logger.info('App install request received', {
            method: req.method,
            siteName,
            siteId,
            callback,
            callbackUrl,
            eloquaInstallId
        });

        if (!siteName || !siteId) {
            logger.error('Missing required parameters', {
                hasSiteName: !!siteName,
                hasSiteId: !!siteId
            });
            
            return res.status(400).json({
                error: 'Missing required parameters: siteName and siteId'
            });
        }

        // ✅ Use getOrCreateConsumer (handles SiteId lookup and installId updates)
        const consumer = await getOrCreateConsumer(eloquaInstallId, siteId, siteName);

        // Store Eloqua callback URL in DATABASE (not session)
        const eloquaCallback = callback || callbackUrl;
        consumer.pending_oauth_callback = eloquaCallback;
        consumer.pending_oauth_expires = new Date(Date.now() + 30 * 60 * 1000);
        
        await consumer.save();

        logger.info('Consumer saved with pending callback', {
            installId: consumer.installId,
            SiteId: consumer.SiteId,
            hasCallback: !!eloquaCallback,
            callbackUrl: eloquaCallback
        });

        // Generate OAuth URL (will include installId in redirect_uri)
        const authUrl = OAuthService.getAuthorizationUrl(consumer.installId);
        
        logger.info('Redirecting to OAuth', { 
            installId: consumer.installId,
            SiteId: consumer.SiteId,
            authUrl,
            willRedirectBackTo: eloquaCallback || 'config page'
        });

        res.redirect(authUrl);
    });

    /**
     * OAuth callback handler
     * GET /eloqua/app/oauth/callback/:installId
     * FIXED: Handles installId changes
     */
    static oauthCallback = asyncHandler(async (req, res) => {
        const { code, state, error: oauthError } = req.query;
        const { installId: urlInstallId } = req.params; // From URL path

        logger.info('OAuth callback received', { 
            hasCode: !!code, 
            hasState: !!state,
            hasError: !!oauthError,
            urlInstallId,
            state,
            error: oauthError
        });

        // Handle OAuth errors
        if (oauthError) {
            logger.error('OAuth error from Eloqua', {
                error: oauthError,
                errorDescription: req.query.error_description
            });

            return res.status(400).send(`
                <html>
                <head><title>Authorization Failed</title></head>
                <body style="font-family: Arial; text-align: center; padding: 50px;">
                    <h2>✗ Authorization Failed</h2>
                    <p>Error: ${oauthError}</p>
                    <p>${req.query.error_description || 'Please try again.'}</p>
                    <a href="/eloqua/app/authorize?installId=${urlInstallId}">Try Again</a>
                </body>
                </html>
            `);
        }

        if (!code) {
            logger.error('No authorization code received');
            return res.status(400).send('Authorization code missing');
        }

        if (!urlInstallId) {
            logger.error('No installId in URL path');
            return res.status(400).send('Installation ID missing from URL');
        }

        try {
            logger.info('Exchanging authorization code for access token', {
                urlInstallId,
                codeLength: code.length
            });
            
            // Pass installId to getAccessToken
            const tokenData = await OAuthService.getAccessToken(code, urlInstallId);

            if (!tokenData.access_token) {
                throw new Error('No access token received from Eloqua');
            }

            logger.info('Access token received from Eloqua', {
                hasAccessToken: !!tokenData.access_token,
                hasRefreshToken: !!tokenData.refresh_token,
                expiresIn: tokenData.expires_in
            });

            // ✅ Find consumer by installId (might be old installId)
            let consumer = await Consumer.findOne({ installId: urlInstallId })
                .select('+oauth_token +oauth_refresh_token +pending_oauth_callback +pending_oauth_expires');

            if (!consumer) {
                logger.error('Consumer not found by urlInstallId', { urlInstallId });
                
                // Try to find by pending callback (if available)
                consumer = await Consumer.findOne({ 
                    pending_oauth_callback: { $exists: true, $ne: null },
                    pending_oauth_expires: { $gte: new Date() }
                }).select('+oauth_token +oauth_refresh_token +pending_oauth_callback +pending_oauth_expires');

                if (consumer) {
                    logger.warn('Found consumer by pending callback', {
                        oldInstallId: consumer.installId,
                        urlInstallId
                    });
                } else {
                    return res.status(404).send('Installation not found');
                }
            }

            logger.info('Consumer found, saving OAuth tokens', {
                installId: consumer.installId,
                SiteId: consumer.SiteId,
                hasPendingCallback: !!consumer.pending_oauth_callback
            });

            // Calculate token expiry
            const expiresIn = tokenData.expires_in || 28800;
            const expiresAt = new Date(Date.now() + (expiresIn * 1000));

            // Save OAuth tokens
            consumer.oauth_token = tokenData.access_token;
            consumer.oauth_refresh_token = tokenData.refresh_token;
            consumer.oauth_expires_at = expiresAt;

            // GET callback URL from database
            const eloquaCallbackUrl = consumer.pending_oauth_callback;

            // Clear pending callback after retrieving it
            consumer.pending_oauth_callback = null;
            consumer.pending_oauth_expires = null;

            await consumer.save();

            logger.info('OAuth tokens saved', {
                installId: consumer.installId,
                SiteId: consumer.SiteId,
                expiresAt: expiresAt.toISOString(),
                hasCallbackUrl: !!eloquaCallbackUrl
            });

            // REDIRECT TO ELOQUA CALLBACK
            if (eloquaCallbackUrl) {
                logger.info('Redirecting to Eloqua callback URL', {
                    installId: consumer.installId,
                    callbackUrl: eloquaCallbackUrl
                });
                
                return res.redirect(eloquaCallbackUrl);
            }
            
            // Fallback: No callback - go to config page
            logger.warn('No Eloqua callback URL - Redirecting to config page', { 
                installId: consumer.installId
            });
            
            return res.redirect(`/eloqua/app/config?installId=${consumer.installId}&SiteId=${consumer.SiteId}&success=true`);

        } catch (error) {
            logger.error('OAuth callback error', {
                urlInstallId,
                error: error.message,
                stack: error.stack
            });

            return res.status(500).send(`
                <html>
                <head><title>Authorization Failed</title></head>
                <body style="font-family: Arial; text-align: center; padding: 50px;">
                    <div style="background: white; padding: 40px; border-radius: 8px;">
                        <h2 style="color: #f44336;">✗ Authorization Failed</h2>
                        <p>Failed to complete OAuth authentication.</p>
                        <p>${error.message}</p>
                        <a href="/eloqua/app/authorize?installId=${urlInstallId}">Try Again</a>
                    </div>
                </body>
                </html>
            `);
        }
    });

    /**
     * Get app configuration page
     * GET /eloqua/app/config
     * FIXED: Uses SiteId lookup
     */
    static getConfig = asyncHandler(async (req, res) => {
        const { installId, SiteId } = req.query;

        logger.info('Loading app configuration page', { installId, SiteId });

        if (!installId || !SiteId) {
            return res.status(400).send('Missing installId or SiteId');
        }

        // ✅ Use SiteId-based lookup
        const consumer = await getConsumerBySiteId(installId, SiteId, true);

        if (!consumer) {
            return res.status(404).send('Installation not found. Please reinstall the app.');
        }

        // Check if OAuth token exists and is valid
        const now = new Date();
        const hasValidToken = consumer.oauth_token && 
            consumer.oauth_expires_at && 
            now < consumer.oauth_expires_at;

        logger.debug('Token validity check', {
            installId: consumer.installId,
            SiteId: consumer.SiteId,
            hasToken: !!consumer.oauth_token,
            hasValidToken
        });

        if (!hasValidToken) {
            logger.warn('No valid OAuth token for config page', {
                installId: consumer.installId,
                SiteId: consumer.SiteId
            });

            return res.redirect(`/eloqua/app/authorize?installId=${consumer.installId}&returnTo=config`);
        }

        // Store in session
        req.session.installId = consumer.installId; // Use updated installId
        req.session.siteId = consumer.SiteId;

        // Get countries data
        const countries = require('../data/countries.json');

        // Get custom objects
        let custom_objects = { elements: [] };
        
        try {
            const eloquaService = new EloquaService(consumer.installId, consumer.SiteId);
            await eloquaService.initialize();
            custom_objects = await eloquaService.getCustomObjects('', 100);
            
            logger.info('Custom objects loaded', {
                installId: consumer.installId,
                SiteId: consumer.SiteId,
                count: custom_objects.elements?.length || 0
            });
        } catch (error) {
            logger.error('Could not fetch custom objects', {
                installId: consumer.installId,
                SiteId: consumer.SiteId,
                error: error.message
            });

            if (error.response?.status === 401) {
                return res.redirect(`/eloqua/app/authorize?installId=${consumer.installId}&returnTo=config`);
            }
        }

        res.render('app-config', {
            consumer: consumer.toObject(),
            countries,
            custom_objects,
            all_custom_object_fields: {
                sendsms: [],
                receivesms: [],
                incomingsms: [],
                tracked_link: []
            },
            success: req.query.success === 'true',
            baseUrl: process.env.APP_BASE_URL
        });
    });

    /**
     * Save app configuration
     * POST /eloqua/app/config
     * FIXED: Uses SiteId lookup
     */
    static saveConfig = asyncHandler(async (req, res) => {
        const { installId, SiteId } = req.query;
        const { consumer: consumerData } = req.body;

        logger.info('Saving app configuration', { 
            installId,
            SiteId,
            hasApiKey: !!consumerData.transmitsms_api_key
        });

        // ✅ Use SiteId-based lookup
        const consumer = await getConsumerBySiteId(installId, SiteId);

        if (!consumer) {
            return res.status(404).json({
                error: 'Installation not found'
            });
        }

        // Update consumer configuration
        if (consumerData.transmitsms_api_key) {
            consumer.transmitsms_api_key = consumerData.transmitsms_api_key.trim();
        }

        if (consumerData.transmitsms_api_secret) {
            consumer.transmitsms_api_secret = consumerData.transmitsms_api_secret.trim();
        }

        if (consumerData.default_country) {
            consumer.default_country = consumerData.default_country;
        }

        // Set callback URLs (use updated installId)
        const baseUrl = process.env.APP_BASE_URL || 'https://eloqua-integrator.onrender.com';
        
        consumer.dlr_callback = `${baseUrl}/webhooks/dlr?installId=${consumer.installId}`;
        consumer.reply_callback = `${baseUrl}/webhooks/reply?installId=${consumer.installId}`;
        consumer.link_hits_callback = `${baseUrl}/webhooks/linkhit?installId=${consumer.installId}`;

        // Update action configurations if provided
        if (consumerData.actions) {
            consumer.actions = {
                ...consumer.actions.toObject(),
                ...consumerData.actions
            };
        }

        consumer.configuredAt = new Date();
        await consumer.save();

        logger.info('App configuration saved', { 
            installId: consumer.installId,
            SiteId: consumer.SiteId
        });

        res.json({
            success: true,
            message: 'Configuration saved successfully',
            callbacks: {
                dlr: consumer.dlr_callback,
                reply: consumer.reply_callback,
                linkHits: consumer.link_hits_callback
            }
        });
    });

    /**
     * Authorize with Eloqua (OAuth)
     * GET /eloqua/app/authorize
     */
    static authorize = asyncHandler(async (req, res) => {
        const { installId, SiteId, returnTo } = req.query;

        logger.info('OAuth authorization initiated', { installId, SiteId, returnTo });

        if (!installId && !SiteId) {
            return res.status(400).send('InstallId or SiteId is required');
        }

        // ✅ Try to find consumer
        let consumer;
        if (SiteId) {
            consumer = await Consumer.findOne({ SiteId, isActive: true });
        } else {
            consumer = await Consumer.findOne({ installId });
        }

        if (!consumer) {
            return res.status(404).send('Installation not found');
        }

        // Store in session for callback
        req.session.installId = consumer.installId;
        req.session.siteId = consumer.SiteId;
        req.session.returnTo = returnTo || 'config';

        // Generate authorization URL
        const authUrl = OAuthService.getAuthorizationUrl(consumer.installId);

        logger.info('Redirecting to Eloqua authorization', {
            installId: consumer.installId,
            SiteId: consumer.SiteId,
            returnTo
        });

        res.redirect(authUrl);
    });

    /**
     * Uninstall app
     * POST /eloqua/app/uninstall
     * FIXED: Uses SiteId lookup
     */
    static uninstall = asyncHandler(async (req, res) => {
        const { installId, SiteId } = req.query;

        logger.info('App uninstall request', { installId, SiteId });

        // ✅ Use SiteId-based lookup if available
        let consumer;
        if (SiteId) {
            consumer = await getConsumerBySiteId(installId, SiteId);
        } else {
            consumer = await Consumer.findOne({ installId })
                .select('+oauth_token');
        }

        if (!consumer) {
            return res.status(404).json({
                error: 'Installation not found'
            });
        }

        // Revoke OAuth token before uninstall
        if (consumer.oauth_token) {
            try {
                await OAuthService.revokeToken(consumer.oauth_token);
                logger.info('OAuth token revoked', { 
                    installId: consumer.installId,
                    SiteId: consumer.SiteId
                });
            } catch (error) {
                logger.warn('Failed to revoke token during uninstall', {
                    installId: consumer.installId,
                    error: error.message
                });
            }
        }

        // Soft delete
        consumer.isActive = false;
        consumer.oauth_token = null;
        consumer.oauth_refresh_token = null;
        consumer.oauth_expires_at = null;
        
        await consumer.save();

        logger.info('Consumer uninstalled', { 
            installId: consumer.installId,
            SiteId: consumer.SiteId
        });

        res.json({
            success: true,
            message: 'App uninstalled successfully'
        });
    });

    /**
     * Get app status
     * GET /eloqua/app/status
     * FIXED: Uses SiteId lookup
     */
    static status = asyncHandler(async (req, res) => {
        const { installId, SiteId } = req.query;

        logger.info('App status check', { installId, SiteId });

        // ✅ Use SiteId-based lookup
        let consumer;
        if (SiteId) {
            consumer = await getConsumerBySiteId(installId, SiteId);
        } else {
            consumer = await Consumer.findOne({ installId })
                .select('+oauth_token +oauth_expires_at +transmitsms_api_key +transmitsms_api_secret');
        }

        if (!consumer) {
            return res.status(404).json({
                error: 'Installation not found'
            });
        }

        const now = new Date();
        const isTokenExpired = consumer.oauth_expires_at 
            ? now >= consumer.oauth_expires_at 
            : null;
        
        const tokenStatus = !consumer.oauth_token 
            ? 'missing'
            : isTokenExpired 
            ? 'expired' 
            : 'valid';

        res.json({
            success: true,
            installId: consumer.installId,
            siteId: consumer.SiteId,
            siteName: consumer.siteName,
            isActive: consumer.isActive,
            oauth: {
                hasToken: !!consumer.oauth_token,
                tokenStatus,
                expiresAt: consumer.oauth_expires_at,
                minutesUntilExpiry: consumer.oauth_expires_at 
                    ? Math.floor((consumer.oauth_expires_at - now) / 60000)
                    : null
            },
            transmitSms: {
                isConfigured: !!(consumer.transmitsms_api_key && consumer.transmitsms_api_secret)
            }
        });
    });

    /**
     * Force token refresh
     * POST /eloqua/app/refresh-token
     * FIXED: Uses SiteId lookup
     */
    static refreshToken = asyncHandler(async (req, res) => {
        const { installId, SiteId } = req.query;

        logger.info('Manual token refresh requested', { installId, SiteId });

        // ✅ Use SiteId-based lookup
        let consumer;
        if (SiteId) {
            consumer = await getConsumerBySiteId(installId, SiteId);
        } else {
            consumer = await Consumer.findOne({ installId })
                .select('+oauth_refresh_token +oauth_token +oauth_expires_at');
        }

        if (!consumer) {
            return res.status(404).json({ error: 'Consumer not found' });
        }

        if (!consumer.oauth_refresh_token) {
            return res.status(400).json({ 
                error: 'No refresh token available. Please re-authorize.',
                reAuthUrl: `/eloqua/app/authorize?installId=${consumer.installId}&SiteId=${consumer.SiteId}`
            });
        }

        try {
            const tokenData = await OAuthService.refreshAccessToken(consumer.oauth_refresh_token);

            consumer.oauth_token = tokenData.access_token;
            
            if (tokenData.refresh_token) {
                consumer.oauth_refresh_token = tokenData.refresh_token;
            }
            
            const expiresIn = tokenData.expires_in || 28800;
            consumer.oauth_expires_at = new Date(Date.now() + (expiresIn * 1000));

            await consumer.save();

            logger.info('Token refreshed successfully', {
                installId: consumer.installId,
                SiteId: consumer.SiteId
            });

            res.json({
                success: true,
                message: 'Token refreshed successfully',
                expiresAt: consumer.oauth_expires_at
            });

        } catch (error) {
            logger.error('Token refresh failed', { 
                installId: consumer.installId,
                error: error.message
            });
            
            res.status(500).json({ 
                error: 'Token refresh failed. Please re-authorize.',
                reAuthUrl: `/eloqua/app/authorize?installId=${consumer.installId}&SiteId=${consumer.SiteId}`
            });
        }
    });

    /**
     * Test Eloqua API connection
     * GET /eloqua/app/test-connection
     * FIXED: Uses SiteId lookup
     */
    static testConnection = asyncHandler(async (req, res) => {
        const { installId, SiteId } = req.query;

        logger.info('Testing Eloqua API connection', { installId, SiteId });

        // ✅ Use SiteId-based lookup
        const consumer = await getConsumerBySiteId(installId, SiteId);

        if (!consumer) {
            return res.status(404).json({ error: 'Consumer not found' });
        }

        try {
            const eloquaService = new EloquaService(consumer.installId, consumer.SiteId);
            await eloquaService.initialize();

            const result = await eloquaService.getContactFields(10);

            logger.info('Eloqua API connection successful', {
                installId: consumer.installId,
                SiteId: consumer.SiteId
            });

            res.json({
                success: true,
                message: 'Connection successful',
                installId: consumer.installId,
                siteId: consumer.SiteId,
                fieldsCount: result.items?.length || 0
            });

        } catch (error) {
            logger.error('Eloqua API connection failed', {
                installId: consumer.installId,
                error: error.message
            });

            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    /**
     * Debug token status
     * GET /eloqua/app/debug/token
     */
    static debugToken = asyncHandler(async (req, res) => {
        const { installId, SiteId } = req.query;

        logger.info('Debug token status check', { installId, SiteId });

        const consumer = await getConsumerBySiteId(installId, SiteId);

        if (!consumer) {
            return res.status(404).json({ error: 'Consumer not found' });
        }

        const now = new Date();
        const isExpired = consumer.oauth_expires_at ? now >= consumer.oauth_expires_at : null;

        res.json({
            installId: consumer.installId,
            siteId: consumer.SiteId,
            siteName: consumer.siteName,
            token: {
                exists: !!consumer.oauth_token,
                length: consumer.oauth_token?.length || 0
            },
            refreshToken: {
                exists: !!consumer.oauth_refresh_token
            },
            expiry: {
                expiresAt: consumer.oauth_expires_at,
                isExpired
            }
        });
    });

    /**
     * AJAX - Get custom objects
     * GET /eloqua/app/ajax/customobjects/:installId/:siteId/customObject
     */
    static getCustomObjects = asyncHandler(async (req, res) => {
        const { installId, siteId } = req.params;
        const { search = '', count = 50 } = req.query;

        logger.debug('AJAX: Fetching custom objects', { 
            installId, 
            siteId,
            search
        });

        try {
            // ✅ Use SiteId-based lookup
            const consumer = await getConsumerBySiteId(installId, siteId);
            
            if (!consumer) {
                return res.json({ elements: [], total: 0, error: 'Consumer not found' });
            }

            const eloquaService = new EloquaService(consumer.installId, consumer.SiteId);
            await eloquaService.initialize();
            
            const customObjects = await eloquaService.getCustomObjects(search, count);

            res.json(customObjects);
        } catch (error) {
            logger.error('Error fetching custom objects', {
                installId,
                siteId,
                error: error.message
            });

            res.json({
                elements: [],
                total: 0,
                error: error.message
            });
        }
    });

    /**
     * AJAX - Get custom object fields
     * GET /eloqua/app/ajax/customobject/:installId/:siteId/:customObjectId
     */
    static getCustomObjectFields = asyncHandler(async (req, res) => {
        const { installId, siteId, customObjectId } = req.params;

        logger.debug('AJAX: Fetching custom object fields', { 
            installId,
            siteId,
            customObjectId 
        });

        try {
            // ✅ Use SiteId-based lookup
            const consumer = await getConsumerBySiteId(installId, siteId);
            
            if (!consumer) {
                return res.json({ id: customObjectId, fields: [], error: 'Consumer not found' });
            }

            const eloquaService = new EloquaService(consumer.installId, consumer.SiteId);
            await eloquaService.initialize();
            
            const customObject = await eloquaService.getCustomObject(customObjectId);

            res.json(customObject);
        } catch (error) {
            logger.error('Error fetching custom object fields', {
                installId,
                siteId,
                customObjectId,
                error: error.message
            });

            res.json({
                id: customObjectId,
                fields: [],
                error: error.message
            });
        }
    });

    // controllers/appController.js - Add to saveSettings

    static saveSettings = asyncHandler(async (req, res) => {
        const { installId, siteId } = req.query;
        const { 
            transmitsms_api_key, 
            transmitsms_api_secret, 
            default_country,
            tps_limit  // ✅ NEW
        } = req.body;

        logger.info('Saving app settings', { 
            installId, 
            siteId,
            hasApiKey: !!transmitsms_api_key,
            tps_limit
        });

        const consumer = await Consumer.findOne({ installId });
        if (!consumer) {
            return res.status(404).json({ error: 'Consumer not found' });
        }

        // Update credentials
        if (transmitsms_api_key) {
            consumer.transmitsms_api_key = transmitsms_api_key;
        }
        if (transmitsms_api_secret) {
            consumer.transmitsms_api_secret = transmitsms_api_secret;
        }
        if (default_country) {
            consumer.default_country = default_country;
        }
        
        // ✅ Update TPS limit
        if (tps_limit) {
            const tps = parseInt(tps_limit);
            if (tps >= 1 && tps <= 100) {
                consumer.tps_limit = tps;
            }
        }

        await consumer.save();

        logger.info('App settings saved', { 
            installId,
            tps_limit: consumer.tps_limit
        });

        res.json({
            success: true,
            message: 'Settings saved successfully'
        });
    });

}

module.exports = AppController;