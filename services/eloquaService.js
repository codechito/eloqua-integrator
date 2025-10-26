const axios = require('axios');
const Consumer = require('../models/Consumer');
const { logger, buildQueryString } = require('../utils');

class EloquaService {
    constructor(installId, siteId) {
        this.installId = installId;
        this.siteId = siteId;
        this.baseUrl = this.getBaseUrl(siteId);
    }

    /**
     * Get Eloqua base URL from site ID
     */
    getBaseUrl(siteId) {
        // Extract pod number from site ID (first 2 digits)
        const podNumber = siteId.substring(0, 2);
        return `https://secure.p${podNumber}.eloqua.com`;
    }

    /**
     * Get access token from database
     */
    async getAccessToken() {
        const consumer = await Consumer.findOne({ installId: this.installId })
            .select('+oauth_token +oauth_refresh_token');
        
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

            const response = await axios.post('https://login.eloqua.com/auth/oauth2/token', {
                grant_type: 'refresh_token',
                refresh_token: consumer.oauth_refresh_token,
                client_id: process.env.ELOQUA_CLIENT_ID,
                client_secret: process.env.ELOQUA_CLIENT_SECRET
            }, {
                headers: {
                    'Content-Type': 'application/json'
                }
            });

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
            
            const url = `${this.baseUrl}${endpoint}`;
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

            logger.debug(`Eloqua API ${method} ${endpoint}`, { params, hasData: !!data });

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
                error: errorMessage
            });

            throw new Error(`Eloqua API Error (${statusCode}): ${errorMessage}`);
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
    async getContactFields(count = 200) {
        const params = { count };
        return await this.makeRequest('GET', '/api/REST/2.0/assets/contact/fields', null, params);
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