const Consumer = require('../models/Consumer');
const { EloquaService, OAuthService } = require('../services');
const { logger, generateId } = require('../utils');
const { asyncHandler } = require('../middleware');

class AppController {
    /**
     * Install app
     * GET /eloqua/app/install
     * This should redirect to OAuth authorization
     */
    static install = asyncHandler(async (req, res) => {
        const { installId, siteId, siteName } = req.query;

        if (!installId || !siteId) {
            return res.status(400).json({ 
                error: 'Missing required parameters',
                message: 'installId and siteId are required'
            });
        }

        logger.info('App installation initiated', { installId, siteId, siteName });

        // Check if already installed
        let consumer = await Consumer.findOne({ installId });

        if (!consumer) {
            // Create new consumer record
            consumer = new Consumer({
                installId,
                SiteId: siteId,
                siteName: siteName || 'Unknown Site',
                actions: {
                    sendsms: {},
                    receivesms: {},
                    incomingsms: {},
                    tracked_link: {}
                },
                isActive: true
            });
            await consumer.save();

            logger.info('Consumer record created', { 
                installId, 
                consumerId: consumer._id 
            });
        } else {
            // Update existing consumer
            consumer.siteName = siteName || consumer.siteName;
            consumer.SiteId = siteId;
            consumer.isActive = true;
            await consumer.save();

            logger.info('Consumer record updated', { installId });
        }

        // Redirect to OAuth authorization
        const authUrl = OAuthService.getAuthorizationUrl(installId, installId);
        
        logger.info('Redirecting to OAuth authorization', { 
            installId,
            authUrl 
        });

        // Return HTML with auto-redirect
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Installing TransmitSMS</title>
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
                    }
                    .spinner {
                        border: 4px solid #f3f3f3;
                        border-top: 4px solid #4CAF50;
                        border-radius: 50%;
                        width: 40px;
                        height: 40px;
                        animation: spin 1s linear infinite;
                        margin: 20px auto;
                    }
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h2>Installing TransmitSMS...</h2>
                    <div class="spinner"></div>
                    <p>Redirecting to Eloqua for authorization...</p>
                    <p style="font-size: 12px; color: #666;">
                        If you are not redirected automatically, 
                        <a href="${authUrl}">click here</a>.
                    </p>
                </div>
                <script>
                    // Redirect after 2 seconds
                    setTimeout(function() {
                        window.location.href = "${authUrl}";
                    }, 2000);
                </script>
            </body>
            </html>
        `);
    });

    /**
     * OAuth callback
     * GET /eloqua/app/oauth/callback
     * This is called after user authorizes the app
     */
    static oauthCallback = asyncHandler(async (req, res) => {
        const { code, state, error, error_description } = req.query;
        
        // Check for OAuth errors
        if (error) {
            logger.error('OAuth authorization failed', { 
                error, 
                description: error_description 
            });
            
            return res.send(`
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
                            font-size: 24px;
                            margin-bottom: 20px;
                        }
                        .message {
                            color: #666;
                            margin-bottom: 20px;
                        }
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
                    <div class="container">
                        <div class="error">✗ Authorization Failed</div>
                        <div class="message">
                            ${error_description || error || 'An error occurred during authorization'}
                        </div>
                        <p>Please try installing the app again.</p>
                        <a href="#" onclick="window.close()" class="btn">Close Window</a>
                    </div>
                </body>
                </html>
            `);
        }

        if (!code) {
            logger.error('OAuth callback: missing authorization code');
            return res.status(400).send('Authorization code not provided');
        }

        const installId = state; // state contains the installId

        logger.info('OAuth callback received', { installId, hasCode: !!code });

        try {
            // Exchange code for tokens
            const tokenData = await OAuthService.exchangeCodeForToken(code);
            
            // Save tokens to consumer
            await OAuthService.saveTokens(installId, tokenData);

            logger.info('OAuth authorization successful', { installId });

            // Return success page
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
                            background: #f5f5f5;
                        }
                        .container {
                            text-align: center;
                            background: white;
                            padding: 40px;
                            border-radius: 8px;
                            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                        }
                        .success {
                            color: #4CAF50;
                            font-size: 48px;
                            margin-bottom: 20px;
                        }
                        .message {
                            color: #333;
                            font-size: 18px;
                            margin-bottom: 10px;
                        }
                        .sub-message {
                            color: #666;
                            font-size: 14px;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="success">✓</div>
                        <div class="message">Authorization Successful!</div>
                        <div class="sub-message">
                            TransmitSMS has been successfully installed and authorized.
                        </div>
                        <div class="sub-message" style="margin-top: 20px;">
                            You can now close this window and return to Eloqua.
                        </div>
                    </div>
                    <script>
                        // Attempt to close window after 3 seconds
                        setTimeout(function() {
                            window.close();
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
                        <p>${error.message}</p>
                        <p style="font-size: 12px; color: #666;">
                            Please contact support if this problem persists.
                        </p>
                    </div>
                </body>
                </html>
            `);
        }
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
            consumer.isActive = false;
            // Clear OAuth tokens on uninstall
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
            return res.status(404).send('Consumer not found. Please install the app first.');
        }

        // Check if OAuth token exists
        const consumerWithToken = await Consumer.findOne({ installId })
            .select('+oauth_token');

        if (!consumerWithToken.oauth_token) {
            // Redirect to OAuth if not authorized
            const authUrl = OAuthService.getAuthorizationUrl(installId, installId);
            
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Authorization Required</title>
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
                        }
                        .btn {
                            display: inline-block;
                            padding: 12px 24px;
                            background: #4CAF50;
                            color: white;
                            text-decoration: none;
                            border-radius: 4px;
                            margin-top: 20px;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h2>Authorization Required</h2>
                        <p>Please authorize this app to access Eloqua.</p>
                        <a href="${authUrl}" class="btn">Authorize Now</a>
                    </div>
                </body>
                </html>
            `);
        }

        // Get custom objects from Eloqua
        let custom_objects = { elements: [] };
        try {
            const eloquaService = new EloquaService(installId, siteId);
            custom_objects = await eloquaService.getCustomObjects('', 100);
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
     * Initiate OAuth flow (alternative entry point)
     * GET /eloqua/app/authorize
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