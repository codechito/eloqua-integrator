const axios = require('axios');
const querystring = require('querystring');
const { logger } = require('../utils');

class OAuthService {
    constructor() {
        this.clientId = process.env.ELOQUA_CLIENT_ID;
        this.clientSecret = process.env.ELOQUA_CLIENT_SECRET;
        this.redirectUri = process.env.ELOQUA_REDIRECT_URI; // Base redirect URI without trailing slash
        this.authorizationURL = 'https://login.eloqua.com/auth/oauth2/authorize';
        this.tokenURL = 'https://login.eloqua.com/auth/oauth2/token';
    }

    /**
     * Get authorization URL with installId embedded in redirect URI
     * OLD CODE PATTERN: callbackUrl with installId/siteId in path
     */
    getAuthorizationUrl(installId) {
        // **FIX: Include installId in redirect URI like old code**
        const redirectUri = `${this.redirectUri}/${installId}`;
        
        const params = {
            response_type: 'code',
            client_id: this.clientId,
            redirect_uri: redirectUri,
            scope: 'full',
            state: installId
        };

        const url = `${this.authorizationURL}?${querystring.stringify(params)}`;

        logger.info('Generated authorization URL', {
            clientId: this.clientId,
            redirectUri,
            installId,
            fullUrl: url
        });

        return url;
    }

    /**
     * Exchange authorization code for access token
     * Must use same redirect_uri as authorization
     */
    async getAccessToken(code, installId) {
        try {
            logger.info('Exchanging authorization code for access token', {
                code: code.substring(0, 10) + '...',
                tokenURL: this.tokenURL,
                installId
            });

            // **FIX: Use same redirect URI with installId as in authorization**
            const redirectUri = `${this.redirectUri}/${installId}`;

            const data = {
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: redirectUri
            };

            const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

            logger.debug('Token request details', {
                url: this.tokenURL,
                grantType: data.grant_type,
                redirectUri: data.redirect_uri,
                hasCode: !!data.code,
                authHeader: `Basic ${auth.substring(0, 20)}...`
            });

            const response = await axios.post(
                this.tokenURL,
                querystring.stringify(data),
                {
                    headers: {
                        'Authorization': `Basic ${auth}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            logger.info('Access token received', {
                hasAccessToken: !!response.data.access_token,
                hasRefreshToken: !!response.data.refresh_token,
                expiresIn: response.data.expires_in,
                tokenType: response.data.token_type
            });

            return {
                access_token: response.data.access_token,
                refresh_token: response.data.refresh_token,
                expires_in: response.data.expires_in || 28800,
                token_type: response.data.token_type
            };

        } catch (error) {
            logger.error('Failed to get access token', {
                error: error.message,
                response: error.response?.data,
                status: error.response?.status,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Refresh access token using refresh token
     */
    async refreshAccessToken(refreshToken) {
        try {
            logger.info('Refreshing access token', {
                refreshToken: refreshToken.substring(0, 10) + '...'
            });

            const data = {
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                scope: 'full'
            };

            const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

            const response = await axios.post(
                this.tokenURL,
                querystring.stringify(data),
                {
                    headers: {
                        'Authorization': `Basic ${auth}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            logger.info('Access token refreshed', {
                hasAccessToken: !!response.data.access_token,
                hasRefreshToken: !!response.data.refresh_token,
                expiresIn: response.data.expires_in
            });

            return {
                access_token: response.data.access_token,
                refresh_token: response.data.refresh_token || refreshToken,
                expires_in: response.data.expires_in || 28800
            };

        } catch (error) {
            logger.error('Failed to refresh access token', {
                error: error.message,
                response: error.response?.data,
                status: error.response?.status,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Revoke access token
     */
    async revokeToken(token) {
        try {
            logger.info('Revoking access token');

            const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

            await axios.post(
                'https://login.eloqua.com/auth/oauth2/revoke',
                querystring.stringify({ token }),
                {
                    headers: {
                        'Authorization': `Basic ${auth}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            logger.info('Access token revoked');

        } catch (error) {
            logger.error('Failed to revoke token', {
                error: error.message
            });
            throw error;
        }
    }
}

module.exports = new OAuthService();