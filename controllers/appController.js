const Consumer = require('../models/Consumer');
const { EloquaService, OAuthService } = require('../services');
const { logger } = require('../utils');
const { asyncHandler } = require('../middleware');

class AppController {
    /**
     * Install app
     * GET /eloqua/app/install
     */
    static install = asyncHandler(async (req, res) => {
        const { 
            installId, 
            siteId, 
            siteName,
            callback,
            oauth_consumer_key,
            oauth_nonce,
            oauth_signature_method,
            oauth_version,
            oauth_signature,
            UserName,
            UserId,
            SiteId,
            SiteName
        } = req.query;

        logger.info('App installation started', { 
            installId, 
            siteId: siteId || SiteId, 
            siteName: siteName || SiteName,
            userName: UserName,
            userId: UserId,
            callback
        });

        // Use either naming convention
        const finalSiteId = siteId || SiteId;
        const finalSiteName = siteName || SiteName;

        // Check if already installed
        let consumer = await Consumer.findOne({ installId });

        if (!consumer) {
            consumer = new Consumer({
                installId,
                SiteId: finalSiteId,
                siteName: finalSiteName || 'Unknown Site',
                actions: {
                    sendsms: {},
                    receivesms: {},
                    incomingsms: {},
                    tracked_link: {}
                }
            });
            await consumer.save();

            logger.info('App installed successfully', { 
                installId, 
                consumerId: consumer._id 
            });
        } else {
            logger.info('App already installed', { installId });
        }

        // Generate OAuth authorization URL
        const authUrl = OAuthService.getAuthorizationUrl(installId, installId);

        logger.info('Redirecting to OAuth', { 
            installId, 
            authUrl 
        });

        // Simple server-side redirect (like your old app)
        res.redirect(authUrl);
    });

    /**
     * Uninstall app
     * GET /eloqua/app/uninstall
     */
    static uninstall = asyncHandler(async (req, res) => {
        const { installId } = req.query;

        logger.info('App uninstallation started', { installId });

        const consumer = await Consumer.findOne({ installId });
        
        if (consumer) {
            // Deactivate and clear OAuth tokens
            consumer.isActive = false;
            consumer.oauth_token = null;
            consumer.oauth_refresh_token = null;
            consumer.oauth_expires_at = null;
            await consumer.save();

            logger.info('App uninstalled successfully', { installId });
        }

        res.json({
            success: true,
            message: 'App uninstalled successfully'
        });
    });

    /**
     * Get app configuration page
     * GET /eloqua/app/configure
     */
    static configure = asyncHandler(async (req, res) => {
        const { installId, siteId } = req.query;

        logger.info('Loading configuration page', { installId });

        const consumer = await Consumer.findOne({ installId });
        
        if (!consumer) {
            return res.status(404).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Error</title>
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
                    </style>
                </head>
                <body>
                    <div class="error">
                        <h2>Consumer Not Found</h2>
                        <p>Please install the app first.</p>
                    </div>
                </body>
                </html>
            `);
        }

        // Check if OAuth token exists
        const consumerWithToken = await Consumer.findOne({ installId })
            .select('+oauth_token');

        if (!consumerWithToken.oauth_token) {
            // Redirect to OAuth if not authorized
            const authUrl = OAuthService.getAuthorizationUrl(installId, installId);
            
            logger.info('OAuth token missing, redirecting to authorization', { installId });
            
            return res.redirect(authUrl);
        }

        // Get custom objects from Eloqua
        let custom_objects = { elements: [] };
        try {
            const eloquaService = new EloquaService(installId, siteId);
            custom_objects = await eloquaService.getCustomObjects('', 100);
            
            logger.info('Fetched custom objects', { 
                installId, 
                count: custom_objects.elements?.length || 0 
            });
        } catch (error) {
            logger.warn('Could not fetch custom objects', { 
                installId, 
                error: error.message 
            });
        }

        // Get countries data
        const countries = require('../data/countries.json');

        // Set default callback URLs if not set
        if (!consumer.dlr_callback) {
            consumer.dlr_callback = `${process.env.APP_BASE_URL}/webhooks/dlr`;
        }
        if (!consumer.reply_callback) {
            consumer.reply_callback = `${process.env.APP_BASE_URL}/webhooks/reply`;
        }
        if (!consumer.link_hits_callback) {
            consumer.link_hits_callback = `${process.env.APP_BASE_URL}/webhooks/linkhit`;
        }

        // Render configuration page
        res.render('app-config', {
            consumer: consumer.toObject(),
            custom_objects,
            countries
        });
    });

    /**
     * Save app configuration
     * POST /eloqua/app/configure
     */
    static saveConfiguration = asyncHandler(async (req, res) => {
        const { installId } = req.query;
        const { consumer: consumerData } = req.body;

        logger.info('Saving app configuration', { installId });

        const consumer = await Consumer.findOne({ installId });
        
        if (!consumer) {
            return res.status(404).json({ 
                error: 'Consumer not found' 
            });
        }

        // Update consumer data
        if (consumerData.transmitsms_api_key) {
            consumer.transmitsms_api_key = consumerData.transmitsms_api_key;
        }
        if (consumerData.transmitsms_api_secret) {
            consumer.transmitsms_api_secret = consumerData.transmitsms_api_secret;
        }
        if (consumerData.default_country) {
            consumer.default_country = consumerData.default_country;
        }
        if (consumerData.dlr_callback) {
            consumer.dlr_callback = consumerData.dlr_callback;
        }
        if (consumerData.reply_callback) {
            consumer.reply_callback = consumerData.reply_callback;
        }
        if (consumerData.link_hits_callback) {
            consumer.link_hits_callback = consumerData.link_hits_callback;
        }
        if (consumerData.actions) {
            consumer.actions = consumerData.actions;
        }

        await consumer.save();

        logger.info('Configuration saved successfully', { installId });

        res.json({
            success: true,
            message: 'Configuration saved successfully'
        });
    });

    /**
     * Get app status
     * GET /eloqua/app/status
     */
    static status = asyncHandler(async (req, res) => {
        const { installId } = req.query;

        const consumer = await Consumer.findOne({ installId });
        
        if (!consumer) {
            return res.status(404).json({ 
                error: 'Consumer not found' 
            });
        }

        const isConfigured = !!(consumer.transmitsms_api_key && consumer.transmitsms_api_secret);
        
        const consumerWithToken = await Consumer.findOne({ installId })
            .select('+oauth_token');
        const hasOAuth = !!consumerWithToken.oauth_token;

        res.json({
            success: true,
            status: consumer.isActive ? 'active' : 'inactive',
            configured: isConfigured,
            authenticated: hasOAuth,
            lastConfigured: consumer.configuredAt,
            lastSynced: consumer.lastSyncedAt
        });
    });

    /**
     * OAuth callback - Simple redirect version
     * GET /eloqua/app/oauth/callback
     */
    static oauthCallback = asyncHandler(async (req, res) => {
        const { code, state } = req.query;
        
        if (!code) {
            logger.error('OAuth callback: missing authorization code');
            return res.redirect(`/eloqua/app/install?installId=${state}&error=missing_code`);
        }

        const installId = state;

        logger.info('OAuth callback received', { installId, hasCode: true });

        try {
            // Exchange code for token
            const tokenData = await OAuthService.exchangeCodeForToken(code);
            
            // Save tokens
            const consumer = await OAuthService.saveTokens(installId, tokenData);

            logger.info('OAuth authorization successful', { installId });

            // Redirect directly to configuration page
            const configureUrl = `/eloqua/app/configure?installId=${installId}&siteId=${consumer.SiteId}`;
            
            res.redirect(configureUrl);
            
        } catch (error) {
            logger.error('OAuth authorization failed', { 
                error: error.message,
                installId 
            });
            
            // Redirect back to install with error
            res.redirect(`/eloqua/app/install?installId=${installId}&error=auth_failed`);
        }
    });

    /**
     * Initiate OAuth flow
     * GET /eloqua/app/authorize
     * Alternative entry point for OAuth authorization
     */
    static authorize = asyncHandler(async (req, res) => {
        const { installId } = req.query;

        if (!installId) {
            return res.status(400).json({ 
                error: 'installId is required' 
            });
        }

        const authUrl = OAuthService.getAuthorizationUrl(installId, installId);

        logger.info('OAuth authorization initiated', { installId });

        res.redirect(authUrl);
    });
}

module.exports = AppController;