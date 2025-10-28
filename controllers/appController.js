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
            appId,
            installId, 
            callback,
            UserName,
            UserId,
            siteId,
            siteName,
            SiteId,
            SiteName
        } = req.query;

        // Use either naming convention
        const finalSiteId = siteId || SiteId;
        const finalSiteName = siteName || SiteName;

        logger.info('App installation started', { 
            appId,
            installId, 
            siteId: finalSiteId, 
            siteName: finalSiteName,
            userName: UserName,
            userId: UserId,
            hasCallback: !!callback
        });

        // Check if already installed
        let consumer = await Consumer.findOne({ installId });

        if (!consumer) {
            consumer = new Consumer({
                installId,
                SiteId: finalSiteId,
                siteName: finalSiteName || 'Unknown Site',
                eloqua_callback_url: callback,  // Save callback URL
                eloqua_user_name: UserName,
                eloqua_user_id: UserId,
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
                consumerId: consumer._id,
                callbackUrl: callback
            });
        } else {
            // Update callback URL in case it changed
            consumer.eloqua_callback_url = callback;
            consumer.eloqua_user_name = UserName;
            consumer.eloqua_user_id = UserId;
            consumer.SiteId = finalSiteId;
            consumer.siteName = finalSiteName || consumer.siteName;
            await consumer.save();

            logger.info('App already installed, updated callback URL', { 
                installId,
                callbackUrl: callback
            });
        }

        // Generate OAuth 2.0 authorization URL
        const authUrl = OAuthService.getAuthorizationUrl(installId, installId);

        logger.info('Redirecting to OAuth', { installId, authUrl });

        // Redirect to OAuth
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
     * OAuth callback
     * GET /eloqua/app/oauth/callback
     */
    static oauthCallback = asyncHandler(async (req, res) => {
        const { code, state } = req.query;
        
        if (!code) {
            logger.error('OAuth callback: missing authorization code');
            return res.status(400).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Authorization Error</title>
                    <style>
                        body {
                            font-family: Arial, sans-serif;
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            height: 100vh;
                            margin: 0;
                            background: #f5f5f5;
                        }
                        .container {
                            text-align: center;
                            background: white;
                            padding: 40px;
                            border-radius: 8px;
                            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                            max-width: 500px;
                        }
                        .error {
                            color: #f44336;
                            font-size: 24px;
                            margin-bottom: 20px;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="error">✗ Authorization Failed</div>
                        <p>Authorization code was not provided.</p>
                        <p>Please try installing the app again.</p>
                    </div>
                </body>
                </html>
            `);
        }

        const installId = state; // state contains the installId

        logger.info('OAuth callback received', { installId, hasCode: true });

        try {
            // Exchange code for token
            const tokenData = await OAuthService.exchangeCodeForToken(code);
            
            // Save tokens
            const consumer = await OAuthService.saveTokens(installId, tokenData);

            logger.info('OAuth authorization successful', { installId });

            // Get the callback URL from the consumer
            const callbackUrl = consumer.eloqua_callback_url;

            if (callbackUrl) {
                logger.info('Redirecting to Eloqua callback URL', { 
                    installId,
                    callbackUrl
                });

                // Redirect to Eloqua's callback URL
                return res.redirect(callbackUrl);
            }

            // Fallback: If no callback URL, show success message
            logger.warn('No callback URL found, showing success message', { installId });

            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Authorization Successful</title>
                    <style>
                        body {
                            font-family: Arial, sans-serif;
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            height: 100vh;
                            margin: 0;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        }
                        .container {
                            text-align: center;
                            background: white;
                            padding: 40px;
                            border-radius: 10px;
                            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                            max-width: 500px;
                        }
                        .success {
                            color: #4CAF50;
                            font-size: 64px;
                            margin-bottom: 20px;
                            animation: scaleIn 0.5s ease-out;
                        }
                        @keyframes scaleIn {
                            from { transform: scale(0); }
                            to { transform: scale(1); }
                        }
                        h2 {
                            color: #333;
                            margin-bottom: 10px;
                        }
                        p {
                            color: #666;
                            margin: 10px 0;
                        }
                        .info {
                            background: #e3f2fd;
                            padding: 15px;
                            border-radius: 5px;
                            margin-top: 20px;
                            font-size: 14px;
                            color: #1565c0;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="success">✓</div>
                        <h2>Authorization Successful!</h2>
                        <p>Your Eloqua account has been connected to TransmitSMS.</p>
                        <div class="info">
                            <strong>You can close this window.</strong><br>
                            Return to Eloqua to continue the setup.
                        </div>
                    </div>
                    <script>
                        // Try to close the window after 3 seconds
                        setTimeout(function() {
                            try {
                                window.close();
                            } catch (e) {
                                console.log('Cannot close window automatically');
                            }
                        }, 3000);
                    </script>
                </body>
                </html>
            `);
            
        } catch (error) {
            logger.error('OAuth authorization failed', { 
                error: error.message,
                installId 
            });
            
            res.status(500).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Authorization Failed</title>
                    <style>
                        body {
                            font-family: Arial, sans-serif;
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            height: 100vh;
                            margin: 0;
                            background: #f5f5f5;
                        }
                        .container {
                            text-align: center;
                            background: white;
                            padding: 40px;
                            border-radius: 8px;
                            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                            max-width: 500px;
                        }
                        .error {
                            color: #f44336;
                            font-size: 48px;
                            margin-bottom: 20px;
                        }
                        h2 {
                            color: #333;
                            margin-bottom: 10px;
                        }
                        .details {
                            background: #fff3cd;
                            border: 1px solid #ffeaa7;
                            color: #856404;
                            padding: 15px;
                            border-radius: 4px;
                            margin: 20px 0;
                            text-align: left;
                            font-size: 14px;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="error">✗</div>
                        <h2>Authorization Failed</h2>
                        <div class="details">
                            <strong>Error:</strong><br>
                            ${error.message}
                        </div>
                        <p>Please check your credentials and try again.</p>
                        <p style="font-size: 14px; color: #666;">You can close this window.</p>
                    </div>
                </body>
                </html>
            `);
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