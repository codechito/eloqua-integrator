const axios = require('axios');
const { logger } = require('../utils');
const config = require('../config/eloqua');

class OAuthService {
    /**
     * Get access token from authorization code
     */
    static async getAccessToken(code) {
        try {
            logger.info('Exchanging authorization code for access token');

            const response = await axios.post(
                config.oauth.tokenURL,
                new URLSearchParams({
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: config.oauth.callbackURL
                }).toString(),
                {
                    auth: {
                        username: config.oauth.clientID,
                        password: config.oauth.clientSecret
                    },
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            logger.info('Token exchange successful', {
                hasAccessToken: !!response.data.access_token,
                hasRefreshToken: !!response.data.refresh_token,
                tokenType: response.data.token_type,
                expiresIn: response.data.expires_in
            });

            return response.data;
        } catch (error) {
            logger.error('Token exchange failed', {
                error: error.message,
                status: error.response?.status,
                data: error.response?.data,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Refresh access token using refresh token
     */
    static async refreshAccessToken(refreshToken) {
        try {
            logger.info('Refreshing access token');

            const response = await axios.post(
                config.oauth.tokenURL,
                new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                    scope: config.oauth.scope || 'full'
                }).toString(),
                {
                    auth: {
                        username: config.oauth.clientID,
                        password: config.oauth.clientSecret
                    },
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            logger.info('Token refresh successful', {
                hasAccessToken: !!response.data.access_token,
                hasRefreshToken: !!response.data.refresh_token,
                tokenType: response.data.token_type,
                expiresIn: response.data.expires_in
            });

            return response.data;
        } catch (error) {
            logger.error('Token refresh failed', {
                error: error.message,
                status: error.response?.status,
                data: error.response?.data,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Get authorization URL
     */
    static getAuthorizationUrl(installId) {
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: config.oauth.clientID,
            redirect_uri: config.oauth.callbackURL,
            scope: config.oauth.scope || 'full',
            state: installId
        });

        const authUrl = `${config.oauth.authorizationURL}?${params.toString()}`;

        logger.info('Authorization URL generated', {
            installId,
            redirectUri: config.oauth.callbackURL
        });

        return authUrl;
    }
}

module.exports = OAuthService;