const { Consumer } = require('../models');
const { EloquaService, OAuthService } = require('../services');
const { logger, generateId } = require('../utils');
const { asyncHandler } = require('../middleware');

class AppController {

    /**
     * Install app
     * GET or POST /eloqua/app/install
     */
    static install = asyncHandler(async (req, res) => {
        const { 
            siteName, 
            siteId,
            callback,
            callbackUrl,
            installId: existingInstallId 
        } = req.query;

        logger.info('App install request received', {
            method: req.method,
            siteName,
            siteId,
            callback,  // This is the Eloqua callback URL
            callbackUrl,
            existingInstallId
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

        let installId = existingInstallId;
        let consumer;

        if (existingInstallId) {
            consumer = await Consumer.findOne({ installId: existingInstallId });
            
            if (consumer) {
                logger.info('Reactivating existing consumer', { 
                    installId: existingInstallId,
                    oldSiteId: consumer.SiteId,
                    newSiteId: siteId
                });
                
                consumer.isActive = true;
                consumer.siteName = siteName;
                consumer.SiteId = siteId;
                await consumer.save();
                
                logger.info('Consumer updated', {
                    installId,
                    SiteId: consumer.SiteId,
                    siteName: consumer.siteName
                });
            }
        }

        if (!consumer) {
            installId = generateId();
            
            logger.info('Creating new consumer', { 
                installId, 
                siteName, 
                siteId
            });

            consumer = new Consumer({
                installId,
                siteName,
                SiteId: siteId,
                isActive: true
            });

            await consumer.save();
            
            const verifyConsumer = await Consumer.findOne({ installId });
            logger.info('Consumer created and verified', {
                installId,
                SiteId: verifyConsumer.SiteId,
                siteName: verifyConsumer.siteName,
                hasSiteId: !!verifyConsumer.SiteId
            });
        }

        // **FIX: Store callback URL in session with logging**
        req.session.installId = installId;
        req.session.eloquaCallbackUrl = callback || callbackUrl;

        logger.info('Session data stored for OAuth', {
            installId,
            eloquaCallbackUrl: req.session.eloquaCallbackUrl,
            hasCallback: !!(callback || callbackUrl),
            sessionId: req.sessionID
        });

        const authUrl = OAuthService.getAuthorizationUrl(installId);
        
        logger.info('Redirecting to OAuth', { 
            installId,
            SiteId: consumer.SiteId,
            authUrl,
            willRedirectBackTo: req.session.eloquaCallbackUrl || 'config page'
        });

        res.redirect(authUrl);
    });

    /**
     * Uninstall app
     * POST /eloqua/app/uninstall
     */
    static uninstall = asyncHandler(async (req, res) => {
        const { installId } = req.query;

        logger.info('App uninstall request', { installId });

        const consumer = await Consumer.findOne({ installId })
            .select('+oauth_token');

        if (!consumer) {
            return res.status(404).json({
                error: 'Installation not found'
            });
        }

        // Revoke OAuth token before uninstall
        if (consumer.oauth_token) {
            try {
                await OAuthService.revokeToken(consumer.oauth_token);
                logger.info('OAuth token revoked', { installId });
            } catch (error) {
                logger.warn('Failed to revoke token during uninstall', {
                    installId,
                    error: error.message
                });
            }
        }

        // Soft delete - mark as inactive
        consumer.isActive = false;
        consumer.oauth_token = null;
        consumer.oauth_refresh_token = null;
        consumer.oauth_expires_at = null;
        
        await consumer.save();

        logger.info('Consumer uninstalled', { installId });

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

        const consumer = await Consumer.findOne({ installId })
            .select('+oauth_token +oauth_expires_at +transmitsms_api_key +transmitsms_api_secret');

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
            isActive: consumer.isActive,
            siteName: consumer.siteName,
            siteId: consumer.SiteId,  // Use SiteId
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
     * Get app configuration page
     * GET /eloqua/app/config
     */
    static getConfig = asyncHandler(async (req, res) => {
        const { installId } = req.query;

        logger.info('Loading app configuration page', { installId });

        const consumer = await Consumer.findOne({ installId })
            .select('+oauth_token +oauth_expires_at');

        if (!consumer) {
            return res.status(404).send('Installation not found');
        }

        // Check if SiteId exists
        if (!consumer.SiteId) {
            logger.error('Consumer has no SiteId', { installId });
            return res.status(500).send('Installation data is incomplete. Please reinstall the app.');
        }

        // Check if OAuth token exists and is valid
        const now = new Date();
        const hasValidToken = consumer.oauth_token && 
            consumer.oauth_expires_at && 
            now < consumer.oauth_expires_at;

        logger.debug('Token validity check', {
            installId,
            SiteId: consumer.SiteId,
            hasToken: !!consumer.oauth_token,
            expiresAt: consumer.oauth_expires_at,
            now: now.toISOString(),
            hasValidToken
        });

        if (!hasValidToken) {
            logger.warn('No valid OAuth token for config page', {
                installId,
                hasToken: !!consumer.oauth_token,
                expiresAt: consumer.oauth_expires_at
            });

            return res.redirect(`/eloqua/app/authorize?installId=${installId}&returnTo=config`);
        }

        // Store in session
        req.session.installId = installId;
        req.session.siteId = consumer.SiteId;

        // Get countries data
        const countries = require('../data/countries.json');

        // Get custom objects
        let custom_objects = { elements: [] };
        
        try {
            logger.debug('Fetching custom objects', {
                installId,
                SiteId: consumer.SiteId
            });

            // Pass consumer.SiteId to EloquaService
            const eloquaService = new EloquaService(installId, consumer.SiteId);
            await eloquaService.initialize();
            custom_objects = await eloquaService.getCustomObjects('', 100);
            
            logger.info('Custom objects loaded for config', {
                installId,
                SiteId: consumer.SiteId,
                count: custom_objects.elements?.length || 0
            });
        } catch (error) {
            logger.error('Could not fetch custom objects for config', {
                installId,
                SiteId: consumer.SiteId,
                error: error.message,
                status: error.response?.status
            });

            // If 401, token is invalid
            if (error.response?.status === 401) {
                logger.error('Token is invalid (401), redirecting to reauth', { 
                    installId
                });
                return res.redirect(`/eloqua/app/authorize?installId=${installId}&returnTo=config`);
            }

            // For other errors, continue with empty custom objects
            logger.warn('Continuing with empty custom objects due to error');
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
     */
    static saveConfig = asyncHandler(async (req, res) => {
        const { installId } = req.query;
        const { consumer: consumerData } = req.body;

        logger.info('Saving app configuration', { 
            installId,
            hasApiKey: !!consumerData.transmitsms_api_key,
            hasApiSecret: !!consumerData.transmitsms_api_secret
        });

        const consumer = await Consumer.findOne({ installId })
            .select('+transmitsms_api_key +transmitsms_api_secret');

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

        // Set callback URLs with installId
        const baseUrl = process.env.APP_BASE_URL || 'https://eloqua-integrator.onrender.com';
        
        consumer.dlr_callback = `${baseUrl}/webhooks/dlr?installId=${installId}`;
        consumer.reply_callback = `${baseUrl}/webhooks/reply?installId=${installId}`;
        consumer.link_hits_callback = `${baseUrl}/webhooks/linkhit?installId=${installId}`;

        // Update action configurations if provided
        if (consumerData.actions) {
            consumer.actions = {
                ...consumer.actions.toObject(),
                ...consumerData.actions
            };
        }

        await consumer.save();

        logger.info('App configuration saved', { 
            installId,
            hasTransmitSmsCreds: !!(consumer.transmitsms_api_key && consumer.transmitsms_api_secret)
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
        const { installId, returnTo } = req.query;

        logger.info('OAuth authorization initiated', { installId, returnTo });

        if (!installId) {
            return res.status(400).send('InstallId is required');
        }

        const consumer = await Consumer.findOne({ installId });

        if (!consumer) {
            return res.status(404).send('Installation not found');
        }

        // Store in session for callback
        req.session.installId = installId;
        req.session.returnTo = returnTo || 'config';

        // Generate authorization URL
        const authUrl = OAuthService.getAuthorizationUrl(installId);

        logger.info('Redirecting to Eloqua authorization', {
            installId,
            returnTo,
            authUrl
        });

        res.redirect(authUrl);
    });

    /**
     * OAuth callback handler
     * GET /eloqua/app/oauth/callback
     */
    static oauthCallback = asyncHandler(async (req, res) => {
        const { code, state, error: oauthError } = req.query;

        // **FIX: Log session data immediately**
        logger.info('OAuth callback received', { 
            hasCode: !!code, 
            hasState: !!state,
            hasError: !!oauthError,
            state,
            error: oauthError,
            sessionData: {
                installId: req.session?.installId,
                returnTo: req.session?.returnTo,
                eloquaCallbackUrl: req.session?.eloquaCallbackUrl,
                hasSession: !!req.session
            }
        });

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
                    <a href="/eloqua/app/authorize?installId=${state}">Try Again</a>
                </body>
                </html>
            `);
        }

        if (!code) {
            logger.error('No authorization code received');
            return res.status(400).send('Authorization code missing');
        }

        try {
            logger.info('Exchanging authorization code for access token', {
                codeLength: code.length,
                codePreview: code.substring(0, 20) + '...'
            });
            
            const tokenData = await OAuthService.getAccessToken(code);

            if (!tokenData.access_token) {
                throw new Error('No access token received from Eloqua');
            }

            logger.info('Access token received from Eloqua', {
                hasAccessToken: !!tokenData.access_token,
                hasRefreshToken: !!tokenData.refresh_token,
                expiresIn: tokenData.expires_in,
                tokenLength: tokenData.access_token?.length || 0,
                tokenPreview: tokenData.access_token 
                    ? `${tokenData.access_token.substring(0, 15)}...${tokenData.access_token.substring(tokenData.access_token.length - 15)}`
                    : 'NO_TOKEN'
            });

            const installId = state || req.session?.installId;

            if (!installId) {
                logger.error('No installId found in state or session');
                return res.status(400).send('Installation ID missing');
            }

            const consumer = await Consumer.findOne({ installId })
                .select('+oauth_token +oauth_refresh_token');

            if (!consumer) {
                logger.error('Consumer not found', { installId });
                return res.status(404).send('Installation not found');
            }

            logger.info('Consumer found, saving OAuth tokens', {
                installId,
                siteName: consumer.siteName,
                SiteId: consumer.SiteId
            });

            const expiresIn = tokenData.expires_in || 28800;
            const expiresAt = new Date(Date.now() + (expiresIn * 1000));

            consumer.oauth_token = tokenData.access_token;
            consumer.oauth_refresh_token = tokenData.refresh_token;
            consumer.oauth_expires_at = expiresAt;

            await consumer.save();

            logger.info('OAuth tokens saved to database', {
                installId,
                tokenLength: tokenData.access_token.length,
                expiresAt: expiresAt.toISOString(),
                expiresInHours: Math.floor(expiresIn / 3600),
                hasRefreshToken: !!tokenData.refresh_token
            });

            // **FIX: Get session data BEFORE cleanup**
            const returnTo = req.session?.returnTo || 'config';
            const eloquaCallbackUrl = req.session?.eloquaCallbackUrl;

            logger.info('Redirect decision', {
                installId,
                eloquaCallbackUrl,
                hasEloquaCallbackUrl: !!eloquaCallbackUrl,
                returnTo,
                sessionStillExists: !!req.session
            });

            // **FIX: Clean up session AFTER getting values**
            if (req.session) {
                delete req.session.returnTo;
                delete req.session.eloquaCallbackUrl;
            }

            // **PRIORITY 1: If there's an Eloqua callback URL, redirect there**
            if (eloquaCallbackUrl) {
                logger.info('Redirecting to Eloqua callback URL to complete installation', {
                    installId,
                    callbackUrl: eloquaCallbackUrl
                });
                
                return res.redirect(eloquaCallbackUrl);
            }
            
            // **PRIORITY 2: Reauth flow - go to config**
            if (returnTo === 'config') {
                logger.info('No Eloqua callback - Redirecting to config page', { installId });
                return res.redirect(`/eloqua/app/config?installId=${installId}&success=true`);
            }
            
            // **PRIORITY 3: Default success page**
            logger.info('No specific redirect - Showing success page', { installId });
            
            return res.send(`
                <html>
                <head>
                    <title>Authorization Successful</title>
                    <style>
                        body {
                            font-family: Arial, sans-serif;
                            text-align: center;
                            padding: 50px;
                            background: #f5f5f5;
                        }
                        .success {
                            background: white;
                            padding: 40px;
                            border-radius: 8px;
                            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                            max-width: 500px;
                            margin: 0 auto;
                        }
                        .checkmark {
                            color: #4CAF50;
                            font-size: 60px;
                        }
                        h2 { color: #333; }
                        p { color: #666; }
                        .btn {
                            display: inline-block;
                            padding: 10px 20px;
                            background: #4CAF50;
                            color: white;
                            text-decoration: none;
                            border-radius: 4px;
                            margin-top: 20px;
                        }
                    </style>
                </head>
                <body>
                    <div class="success">
                        <div class="checkmark">✓</div>
                        <h2>Authorization Successful</h2>
                        <p>Your app has been successfully connected to Eloqua.</p>
                        <p>Token expires: ${expiresAt.toLocaleString()}</p>
                        <a href="/eloqua/app/config?installId=${installId}" class="btn">Go to Configuration</a>
                    </div>
                    <script>
                        if (window.opener) {
                            setTimeout(() => window.close(), 3000);
                        }
                    </script>
                </body>
                </html>
            `);

        } catch (error) {
            logger.error('OAuth callback error', {
                error: error.message,
                stack: error.stack,
                response: error.response?.data,
                status: error.response?.status
            });

            return res.status(500).send(`
                <html>
                <head>
                    <title>Authorization Failed</title>
                    <style>
                        body {
                            font-family: Arial, sans-serif;
                            text-align: center;
                            padding: 50px;
                            background: #f5f5f5;
                        }
                        .error {
                            background: white;
                            padding: 40px;
                            border-radius: 8px;
                            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                            max-width: 500px;
                            margin: 0 auto;
                        }
                        .error-icon {
                            color: #f44336;
                            font-size: 60px;
                        }
                        h2 { color: #333; }
                        p { color: #666; }
                        .details {
                            background: #f5f5f5;
                            padding: 15px;
                            border-radius: 4px;
                            margin: 20px 0;
                            font-family: monospace;
                            font-size: 12px;
                            text-align: left;
                        }
                        .btn {
                            display: inline-block;
                            padding: 10px 20px;
                            background: #2196F3;
                            color: white;
                            text-decoration: none;
                            border-radius: 4px;
                            margin-top: 20px;
                        }
                    </style>
                </head>
                <body>
                    <div class="error">
                        <div class="error-icon">✗</div>
                        <h2>Authorization Failed</h2>
                        <p>Failed to complete OAuth authentication.</p>
                        <div class="details">${error.message}</div>
                        <a href="/eloqua/app/authorize?installId=${state || req.session?.installId}" class="btn">Try Again</a>
                    </div>
                </body>
                </html>
            `);
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
            ? `${consumer.oauth_token.substring(0, 20)}...${consumer.oauth_token.substring(consumer.oauth_token.length - 20)}`
            : 'NO_TOKEN';

        const now = new Date();
        const isExpired = consumer.oauth_expires_at ? now >= consumer.oauth_expires_at : null;
        const timeUntilExpiry = consumer.oauth_expires_at 
            ? Math.floor((consumer.oauth_expires_at.getTime() - now.getTime()) / 1000 / 60)
            : null;

        const looksLikeBasicAuth = consumer.oauth_token 
            ? consumer.oauth_token.match(/^[A-Za-z0-9+/=]+$/)
            : false;

        let decodedToken = null;
        if (consumer.oauth_token && looksLikeBasicAuth) {
            try {
                decodedToken = Buffer.from(consumer.oauth_token, 'base64').toString('utf-8');
            } catch (e) {
                decodedToken = 'Failed to decode';
            }
        }

        res.json({
            installId,
            siteName: consumer.siteName,
            siteId: consumer.SiteId,  // Use SiteId
            token: {
                exists: !!consumer.oauth_token,
                length: consumer.oauth_token?.length || 0,
                preview: tokenPreview,
                looksLikeBasicAuth,
                decodedBasicAuth: decodedToken,
                isValidAppCloudToken: consumer.oauth_token && looksLikeBasicAuth
            },
            refreshToken: {
                exists: !!consumer.oauth_refresh_token,
                length: consumer.oauth_refresh_token?.length || 0
            },
            expiry: {
                expiresAt: consumer.oauth_expires_at,
                isExpired,
                timeUntilExpiryMinutes: timeUntilExpiry,
                now: now.toISOString()
            }
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

            logger.info('Token refresh successful', {
                hasAccessToken: !!tokenData.access_token,
                hasRefreshToken: !!tokenData.refresh_token,
                expiresIn: tokenData.expires_in,
                tokenLength: tokenData.access_token?.length
            });

            consumer.oauth_token = tokenData.access_token;
            
            if (tokenData.refresh_token) {
                consumer.oauth_refresh_token = tokenData.refresh_token;
            }
            
            const expiresIn = tokenData.expires_in || 28800;
            consumer.oauth_expires_at = new Date(Date.now() + (expiresIn * 1000));

            await consumer.save();

            logger.info('Refreshed token saved', {
                installId,
                expiresAt: consumer.oauth_expires_at.toISOString()
            });

            res.json({
                success: true,
                message: 'Token refreshed successfully',
                expiresAt: consumer.oauth_expires_at,
                expiresInMinutes: Math.floor(expiresIn / 60)
            });

        } catch (error) {
            logger.error('Token refresh failed', { 
                installId,
                error: error.message,
                response: error.response?.data,
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
     * Test Eloqua API connection
     * GET /eloqua/app/test-connection/:installId
     */
    static testConnection = asyncHandler(async (req, res) => {
        const { installId } = req.params;

        logger.info('Testing Eloqua API connection', { installId });

        const consumer = await Consumer.findOne({ installId })
            .select('+oauth_token +oauth_expires_at');

        if (!consumer) {
            return res.status(404).json({ error: 'Consumer not found' });
        }

        try {
            const eloquaService = new EloquaService(installId, consumer.SiteId);  // Use SiteId
            await eloquaService.initialize();

            const result = await eloquaService.getContactFields(10);

            logger.info('Eloqua API connection successful', {
                installId,
                SiteId: consumer.SiteId,
                fieldsCount: result.items?.length || 0
            });

            res.json({
                success: true,
                message: 'Connection successful',
                siteId: consumer.SiteId,
                baseURL: eloquaService.baseURL,
                fieldsCount: result.items?.length || 0
            });

        } catch (error) {
            logger.error('Eloqua API connection failed', {
                installId,
                error: error.message,
                status: error.response?.status,
                responseData: error.response?.data
            });

            res.status(500).json({
                success: false,
                error: error.message,
                status: error.response?.status,
                data: error.response?.data
            });
        }
    });

    /**
     * Fix SiteId field (temporary utility endpoint)
     * GET /eloqua/app/fix-siteid/:installId/:siteId
     */
    static fixSiteId = asyncHandler(async (req, res) => {
        const { installId, siteId } = req.params;

        const consumer = await Consumer.findOne({ installId });
        
        if (!consumer) {
            return res.status(404).json({ error: 'Consumer not found' });
        }

        consumer.SiteId = siteId;
        await consumer.save();

        logger.info('SiteId fixed', { installId, SiteId: siteId });

        res.json({ 
            success: true, 
            installId,
            SiteId: consumer.SiteId 
        });
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
            siteId,
            search, 
            count 
        });

        try {
            const eloquaService = new EloquaService(installId, siteId);
            await eloquaService.initialize();
            
            const customObjects = await eloquaService.getCustomObjects(search, count);

            logger.debug('Custom objects fetched for app', { 
                count: customObjects.elements?.length || 0 
            });

            res.json(customObjects);
        } catch (error) {
            logger.error('Error fetching custom objects for app', {
                installId,
                error: error.message,
                status: error.response?.status
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

        logger.debug('AJAX: Fetching custom object fields for app', { 
            installId,
            siteId,
            customObjectId 
        });

        try {
            const eloquaService = new EloquaService(installId, siteId);
            await eloquaService.initialize();
            
            const customObject = await eloquaService.getCustomObject(customObjectId);

            logger.debug('Custom object fields fetched for app', { 
                fieldCount: customObject.fields?.length || 0 
            });

            res.json(customObject);
        } catch (error) {
            logger.error('Error fetching custom object fields for app', {
                installId,
                customObjectId,
                error: error.message,
                status: error.response?.status
            });

            res.json({
                id: customObjectId,
                fields: [],
                error: error.message
            });
        }
    });
}

module.exports = AppController;