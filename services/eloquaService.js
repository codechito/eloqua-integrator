const axios = require('axios');
const Consumer = require('../models/Consumer');
const { logger, buildQueryString } = require('../utils');
const eloquaConfig = require('../config/eloqua');

class EloquaService {
    constructor(installId, siteId) {
        this.installId = installId;
        this.siteId = siteId;
        this.baseUrl = null;
        this.retryCount = 0;
        this.maxRetries = 1; // Only retry once after token refresh
    }

    /**
     * Get Eloqua base URL
     */
    async getBaseUrl() {
        if (this.baseUrl) {
            return this.baseUrl;
        }

        const consumer = await Consumer.findOne({ installId: this.installId });
        
        if (consumer && consumer.eloqua_base_url) {
            this.baseUrl = consumer.eloqua_base_url;
            logger.debug('Using stored base URL', { 
                installId: this.installId,
                baseUrl: this.baseUrl 
            });
            return this.baseUrl;
        }

        try {
            const token = await this.getAccessToken();
            const response = await axios.get('https://login.eloqua.com/id', {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (response.data && response.data.urls && response.data.urls.base) {
                this.baseUrl = response.data.urls.base;
                
                if (consumer) {
                    consumer.eloqua_base_url = this.baseUrl;
                    consumer.eloqua_apis_url = response.data.urls.apis;
                    await consumer.save();
                }
                
                logger.info('Eloqua base URL discovered and stored', { 
                    installId: this.installId,
                    baseUrl: this.baseUrl 
                });
                return this.baseUrl;
            }
        } catch (error) {
            logger.error('Could not discover base URL', {
                installId: this.installId,
                error: error.message
            });
        }

        this.baseUrl = 'https://secure.eloqua.com';
        logger.warn('Using default base URL', {
            installId: this.installId,
            baseUrl: this.baseUrl
        });
        
        return this.baseUrl;
    }

    /**
     * Get access token from database
     */
    async getAccessToken() {
        const consumer = await Consumer.findOne({ installId: this.installId })
            .select('+oauth_token +oauth_refresh_token +oauth_expires_at');
        
        if (!consumer || !consumer.oauth_token) {
            throw new Error('OAuth token not found. Please authenticate the app.');
        }

        // Check if token is expired or about to expire (within 5 minutes)
        const now = new Date();
        const expiresAt = consumer.oauth_expires_at;
        const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

        if (expiresAt && expiresAt <= fiveMinutesFromNow) {
            logger.info('OAuth token expired or expiring soon, refreshing', { 
                installId: this.installId,
                expiresAt,
                now
            });
            
            return await this.refreshToken(consumer);
        }

        return consumer.oauth_token;
    }

    /**
     * Refresh OAuth token
     */
    async refreshToken(consumer) {
        try {
            logger.info('Refreshing OAuth token', { installId: this.installId });

            if (!consumer.oauth_refresh_token) {
                throw new Error('Refresh token not found. Re-authorization required.');
            }

            const credentials = Buffer.from(
                `${process.env.ELOQUA_CLIENT_ID}:${process.env.ELOQUA_CLIENT_SECRET}`
            ).toString('base64');

            const params = new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: consumer.oauth_refresh_token
            });

            const response = await axios.post(
                'https://login.eloqua.com/auth/oauth2/token',
                params.toString(),
                {
                    headers: {
                        'Authorization': `Basic ${credentials}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    timeout: 30000
                }
            );

            // Update consumer with new tokens
            consumer.oauth_token = response.data.access_token;
            
            // Refresh token might be rotated (new one provided) or stay the same
            if (response.data.refresh_token) {
                consumer.oauth_refresh_token = response.data.refresh_token;
            }
            
            const expiresIn = response.data.expires_in || 28800; // Default 8 hours
            consumer.oauth_expires_at = new Date(Date.now() + expiresIn * 1000);
            
            await consumer.save();

            logger.info('OAuth token refreshed successfully', { 
                installId: this.installId,
                expiresAt: consumer.oauth_expires_at
            });

            return response.data.access_token;
        } catch (error) {
            logger.error('Error refreshing OAuth token', {
                installId: this.installId,
                error: error.message,
                errorCode: error.response?.data?.error
            });

            // If refresh fails, clear tokens
            if (error.response?.status === 400 || error.response?.status === 401) {
                consumer.oauth_token = null;
                consumer.oauth_refresh_token = null;
                consumer.oauth_expires_at = null;
                await consumer.save();
                
                throw new Error('REAUTH_REQUIRED');
            }

            throw new Error(`Failed to refresh OAuth token: ${error.message}`);
        }
    }

    /**
     * Make API request to Eloqua with automatic token refresh
     */
    async makeRequest(method, endpoint, data = null, params = {}) {
        try {
            const token = await this.getAccessToken();
            const baseUrl = await this.getBaseUrl();
            
            const url = `${baseUrl}${endpoint}`;
            const queryString = buildQueryString(params);
            const fullUrl = queryString ? `${url}?${queryString}` : url;
            
            const config = {
                method,
                url: fullUrl,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            };

            if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
                config.data = data;
            }

            logger.debug(`Eloqua API ${method} ${endpoint}`, { 
                baseUrl,
                params, 
                hasData: !!data,
                retryCount: this.retryCount
            });

            const response = await axios(config);

            logger.api(endpoint, method, response.status, {
                installId: this.installId
            });

            // Reset retry count on success
            this.retryCount = 0;

            return response.data;

        } catch (error) {
            const errorMessage = error.response?.data?.message || error.message;
            const statusCode = error.response?.status;

            logger.error(`Eloqua API Error: ${method} ${endpoint}`, {
                installId: this.installId,
                status: statusCode,
                error: errorMessage,
                baseUrl: this.baseUrl,
                retryCount: this.retryCount
            });

            // Handle 401 Unauthorized - Token expired
            if (statusCode === 401 && this.retryCount < this.maxRetries) {
                logger.warn('Received 401, attempting token refresh', {
                    installId: this.installId,
                    retryCount: this.retryCount
                });

                this.retryCount++;

                try {
                    // Get fresh consumer data
                    const consumer = await Consumer.findOne({ installId: this.installId })
                        .select('+oauth_token +oauth_refresh_token +oauth_expires_at');
                    
                    if (!consumer) {
                        throw new Error('REAUTH_REQUIRED');
                    }

                    // Force token refresh
                    await this.refreshToken(consumer);

                    // Retry the original request
                    logger.info('Retrying request with new token', {
                        installId: this.installId,
                        endpoint
                    });

                    return await this.makeRequest(method, endpoint, data, params);

                } catch (refreshError) {
                    if (refreshError.message === 'REAUTH_REQUIRED') {
                        // Build re-authorization URL
                        const reAuthUrl = this.buildReAuthUrl();
                        
                        logger.error('Token refresh failed, re-authorization required', {
                            installId: this.installId,
                            reAuthUrl
                        });

                        const error = new Error('Re-authorization required');
                        error.code = 'REAUTH_REQUIRED';
                        error.reAuthUrl = reAuthUrl;
                        throw error;
                    }

                    throw refreshError;
                }
            }

            // If we've already retried or it's not a 401, throw the error
            const finalError = new Error(`Eloqua API Error (${statusCode || 'Network'}): ${errorMessage}`);
            finalError.statusCode = statusCode;
            finalError.originalError = error;
            
            throw finalError;
        }
    }

    /**
     * Build re-authorization URL
     */
    buildReAuthUrl() {
        const baseUrl = process.env.APP_BASE_URL || 'https://eloqua-integrator.onrender.com';
        const installUrl = `${baseUrl}/eloqua/app/install?installId=${this.installId}&siteId=${this.siteId}`;
        return installUrl;
    }

    /**
     * Get custom objects
     */
    async getCustomObjects(search = '', count = 100) {
        const params = {
            search,
            count,
            orderBy: 'name'
        };
        return await this.makeRequest('GET', '/api/REST/2.0/assets/customObjects', null, params);
    }

    /**
     * Get custom object by ID
     */
    async getCustomObject(customObjectId) {
        return await this.makeRequest('GET', `/api/REST/2.0/assets/customObject/${customObjectId}`);
    }

    /**
     * Get custom object data
     */
    async getCustomObjectData(customObjectId, search = '', count = 100) {
        const params = { search, count };
        return await this.makeRequest('GET', `/api/REST/2.0/data/customObject/${customObjectId}/instances`, null, params);
    }

    /**
     * Create custom object record
     */
    async createCustomObjectRecord(customObjectId, data) {
        return await this.makeRequest('POST', `/api/REST/2.0/data/customObject/${customObjectId}/instance`, data);
    }

    /**
     * Update custom object record
     */
    async updateCustomObjectRecord(customObjectId, recordId, data) {
        return await this.makeRequest('PUT', `/api/REST/2.0/data/customObject/${customObjectId}/instance/${recordId}`, data);
    }

    /**
     * Delete custom object record
     */
    async deleteCustomObjectRecord(customObjectId, recordId) {
        return await this.makeRequest('DELETE', `/api/REST/2.0/data/customObject/${customObjectId}/instance/${recordId}`);
    }

    /**
     * Get contact by ID
     */
    async getContact(contactId) {
        return await this.makeRequest('GET', `/api/REST/2.0/data/contact/${contactId}`);
    }

    /**
     * Get contact by email
     */
    async getContactByEmail(email) {
        const params = {
            search: email,
            count: 1
        };
        const response = await this.makeRequest('GET', '/api/REST/2.0/data/contacts', null, params);
        return response.elements && response.elements.length > 0 ? response.elements[0] : null;
    }

    /**
     * Get contact fields
     */
    async getContactFields(count = 200) {
        const params = { count };
        return await this.makeRequest('GET', '/api/bulk/2.0/contacts/fields', null, params);
    }

    /**
     * Update contact
     */
    async updateContact(contactId, data) {
        return await this.makeRequest('PUT', `/api/REST/2.0/data/contact/${contactId}`, data);
    }

    /**
     * Search contacts
     */
    async searchContacts(searchTerm, count = 100) {
        const params = {
            search: searchTerm,
            count
        };
        return await this.makeRequest('GET', '/api/REST/2.0/data/contacts', null, params);
    }

    /**
     * Get campaign by ID
     */
    async getCampaign(campaignId) {
        return await this.makeRequest('GET', `/api/REST/2.0/assets/campaign/${campaignId}`);
    }

    /**
     * Get email by ID
     */
    async getEmail(emailId) {
        return await this.makeRequest('GET', `/api/REST/2.0/assets/email/${emailId}`);
    }
}

module.exports = EloquaService;