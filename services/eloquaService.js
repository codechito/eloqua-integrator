const axios = require('axios');
const Consumer = require('../models/Consumer');
const { logger, buildQueryString } = require('../utils');

class EloquaService {
    constructor(installId, siteId) {
        this.installId = installId;
        this.siteId = siteId;
        this.baseUrl = null; // Will be set dynamically
    }

    /**
     * Get Eloqua base URL from site ID or discover it
     */
    async getBaseUrl() {
        if (this.baseUrl) {
            return this.baseUrl;
        }

        // Method 1: Try to get from login API (most reliable)
        try {
            const token = await this.getAccessToken();
            
            // Call the login API to get the correct base URL
            const response = await axios.get('https://login.eloqua.com/id', {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (response.data && response.data.urls && response.data.urls.base) {
                this.baseUrl = response.data.urls.base;
                logger.info('Eloqua base URL discovered', { 
                    installId: this.installId,
                    baseUrl: this.baseUrl 
                });
                return this.baseUrl;
            }
        } catch (error) {
            logger.warn('Could not discover base URL from login API', {
                error: error.message
            });
        }

        // Method 2: Fallback to constructing from siteId
        // SiteId format is usually like "1234" where first 1-2 digits might indicate pod
        // But this is unreliable, better to use Method 1
        const podNumber = this.siteId ? this.siteId.substring(0, 2).padStart(2, '0') : '01';
        this.baseUrl = `https://secure.p${podNumber}.eloqua.com`;
        
        logger.warn('Using fallback base URL', {
            installId: this.installId,
            siteId: this.siteId,
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

        // Check if token needs refresh
        if (consumer.needsTokenRefresh()) {
            logger.info('OAuth token needs refresh', { installId: this.installId });
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
                    }
                }
            );

            // Update consumer with new tokens
            consumer.oauth_token = response.data.access_token;
            consumer.oauth_refresh_token = response.data.refresh_token;
            consumer.oauth_expires_at = new Date(Date.now() + response.data.expires_in * 1000);
            await consumer.save();

            logger.info('OAuth token refreshed successfully', { installId: this.installId });

            return response.data.access_token;
        } catch (error) {
            logger.error('Error refreshing OAuth token', {
                installId: this.installId,
                error: error.message
            });
            throw new Error('Failed to refresh OAuth token: ' + error.message);
        }
    }

    /**
     * Make API request to Eloqua
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
                hasData: !!data 
            });

            const response = await axios(config);

            logger.api(endpoint, method, response.status, {
                installId: this.installId
            });

            return response.data;
        } catch (error) {
            const errorMessage = error.response?.data?.message || error.message;
            const statusCode = error.response?.status;

            logger.error(`Eloqua API Error: ${method} ${endpoint}`, {
                installId: this.installId,
                status: statusCode,
                error: errorMessage,
                baseUrl: this.baseUrl
            });

            throw new Error(`Eloqua API Error (${statusCode || 'Network'}): ${errorMessage}`);
        }
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
    async getContactFields(limit = 1000) {
        const params = { 
            limit,
            offset: 0
        };
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