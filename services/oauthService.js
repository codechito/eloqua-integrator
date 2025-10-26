const axios = require('axios');
const Consumer = require('../models/Consumer');
const { logger, buildQueryString } = require('../utils');
const eloquaConfig = require('../config/eloqua');

class OAuthService {
    /**
     * Get authorization URL for OAuth flow
     * @param {string} installId - Installation ID
     * @param {string} state - State parameter for security
     * @returns {string} Authorization URL
     */
    static getAuthorizationUrl(installId, state) {
        const params = {
            response_type: 'code',
            client_id: process.env.ELOQUA_CLIENT_ID,
            redirect_uri: process.env.ELOQUA_REDIRECT_URI,
            scope: eloquaConfig.oauth.scope,
            state: state || installId
        };

        const queryString = buildQueryString(params);
        const authUrl = `${eloquaConfig.oauth.authorizationUrl}?${queryString}`;

        logger.info('Generated OAuth authorization URL', {
            installId,
            redirectUri: process.env.ELOQUA_REDIRECT_URI
        });

        return authUrl;
    }

    /**
     * Exchange authorization code for access token
     * @param {string} code - Authorization code
     * @returns {object} Token data
     */
    static async exchangeCodeForToken(code) {
        try {
            logger.info('Exchanging authorization code for token');

            const response = await axios.post(
                eloquaConfig.oauth.tokenUrl,
                {
                    grant_type: 'authorization_code',
                    code,
                    client_id: process.env.ELOQUA_CLIENT_ID,
                    client_secret: process.env.ELOQUA_CLIENT_SECRET,
                    redirect_uri: process.env.ELOQUA_REDIRECT_URI
                },
                {
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );

            logger.info('Successfully exchanged code for token', {
                expiresIn: response.data.expires_in
            });

            return response.data;
        } catch (error) {
            const errorMessage = error.response?.data?.error_description || error.message;
            
            logger.error('OAuth token exchange failed', {
                error: errorMessage,
                statusCode: error.response?.status
            });

            throw new Error(`OAuth token exchange failed: ${errorMessage}`);
        }
    }

    /**
     * Refresh access token
     * @param {string} refreshToken - Refresh token
     * @returns {object} New token data
     */
    static async refreshAccessToken(refreshToken) {
        try {
            logger.info('Refreshing access token');

            const response = await axios.post(
                eloquaConfig.oauth.tokenUrl,
                {
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                    client_id: process.env.ELOQUA_CLIENT_ID,
                    client_secret: process.env.ELOQUA_CLIENT_SECRET
                },
                {
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );

            logger.info('Successfully refreshed access token', {
                expiresIn: response.data.expires_in
            });

            return response.data;
        } catch (error) {
            const errorMessage = error.response?.data?.error_description || error.message;
            
            logger.error('Token refresh failed', {
                error: errorMessage,
                statusCode: error.response?.status
            });

            throw new Error(`Token refresh failed: ${errorMessage}`);
        }
    }

    /**
     * Save tokens to database
     * @param {string} installId - Installation ID
     * @param {object} tokenData - Token data from OAuth response
     * @returns {object} Updated consumer
     */
    static async saveTokens(installId, tokenData) {
        try {
            const consumer = await Consumer.findOne({ installId });
            
            if (!consumer) {
                throw new Error('Consumer not found');
            }

            // Calculate expiration date
            const expiresIn = tokenData.expires_in || 28800; // Default 8 hours
            const expiresAt = new Date(Date.now() + expiresIn * 1000);

            // Update consumer with new tokens
            consumer.oauth_token = tokenData.access_token;
            consumer.oauth_refresh_token = tokenData.refresh_token;
            consumer.oauth_expires_at = expiresAt;
            consumer.oauth_token_type = tokenData.token_type || 'Bearer';

            await consumer.save();

            logger.info('OAuth tokens saved', {
                installId,
                expiresAt: expiresAt.toISOString()
            });

            return consumer;
        } catch (error) {
            logger.error('Error saving OAuth tokens', {
                installId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Revoke access token
     * @param {string} installId - Installation ID
     */
    static async revokeToken(installId) {
        try {
            const consumer = await Consumer.findOne({ installId })
                .select('+oauth_token +oauth_refresh_token');
            
            if (!consumer) {
                throw new Error('Consumer not found');
            }

            // Clear tokens
            consumer.oauth_token = null;
            consumer.oauth_refresh_token = null;
            consumer.oauth_expires_at = null;

            await consumer.save();

            logger.info('OAuth tokens revoked', { installId });

            return true;
        } catch (error) {
            logger.error('Error revoking OAuth tokens', {
                installId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Check if consumer has valid OAuth token
     * @param {string} installId - Installation ID
     * @returns {boolean}
     */
    static async hasValidToken(installId) {
        try {
            const consumer = await Consumer.findOne({ installId })
                .select('+oauth_token +oauth_expires_at');
            
            if (!consumer || !consumer.oauth_token) {
                return false;
            }

            // Check if token is expired
            if (consumer.oauth_expires_at && new Date() >= consumer.oauth_expires_at) {
                return false;
            }

            return true;
        } catch (error) {
            logger.error('Error checking token validity', {
                installId,
                error: error.message
            });
            return false;
        }
    }
}

module.exports = OAuthService;