const Consumer = require('../models/Consumer');
const { EloquaService, OAuthService } = require('../services');
const { logger, generateId } = require('../utils');
const { asyncHandler } = require('../middleware');

class AppController {
    /**
     * Install app
     * POST /eloqua/app/install
     */
    static install = asyncHandler(async (req, res) => {
        const { installId, siteId, siteName } = req.query;

        logger.info('App installation started', { installId, siteId, siteName });

        // Check if already installed
        let consumer = await Consumer.findOne({ installId });

        if (!consumer) {
            consumer = new Consumer({
                installId,
                SiteId: siteId,
                siteName: siteName || 'Unknown Site',
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

        res.json({
            success: true,
            message: 'App installed successfully',
            installId,
            requiresAuth: !consumer.oauth_token,
            requiresConfig: !consumer.isConfigured
        });
    });

    /**
     * Uninstall app
     * POST /eloqua/app/uninstall
     */
    static uninstall = asyncHandler(async (req, res) => {
        const { installId } = req.query;

        logger.info('App uninstallation started', { installId });

        const consumer = await Consumer.findOne({ installId });
        
        if (consumer) {
            consumer.isActive = false;
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
        const hasOAuth = !!consumer.oauth_token;

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
            return res.status(400).send('Authorization code not provided');
        }

        logger.info('OAuth callback received', { state });

        try {
            // Exchange code for token
            const tokenData = await OAuthService.exchangeCodeForToken(code);
            
            // Save tokens
            await OAuthService.saveTokens(state, tokenData);

            logger.info('OAuth authorization successful', { installId: state });

            res.send(`
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
                                font-size: 24px;
                                margin-bottom: 20px;
                            }
                            .message {
                                color: #666;
                                margin-bottom: 20px;
                            }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="success">✓ Authorization Successful</div>
                            <div class="message">You can now close this window and return to Eloqua.</div>
                        </div>
                        <script>
                            setTimeout(() => {
                                window.close();
                            }, 3000);
                        </script>
                    </body>
                </html>
            `);
        } catch (error) {
            logger.error('OAuth authorization failed', { 
                error: error.message,
                state 
            });
            
            res.status(500).send(`
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
                            .message {
                                color: #666;
                            }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="error">✗ Authorization Failed</div>
                            <div class="message">${error.message}</div>
                        </div>
                    </body>
                </html>
            `);
        }
    });

    /**
     * Initiate OAuth flow
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