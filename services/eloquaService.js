const axios = require('axios');
const { logger } = require('../utils');
const { Consumer } = require('../models');

class EloquaService {
    constructor(installId, siteId) {
        this.installId = installId;
        this.siteId = siteId;
        this.baseURL = null;
        this.client = null;
        this.initialized = false;
    }

    /**
     * Initialize the Eloqua client with OAuth token
     */
    async initialize() {
        if (this.initialized) {
            return; // Already initialized
        }

        try {
            logger.debug('Initializing Eloqua client', {
                installId: this.installId,
                siteId: this.siteId
            });

            // Get consumer with OAuth token
            const consumer = await Consumer.findOne({ installId: this.installId })
                .select('+oauth_token +oauth_expires_at');

            if (!consumer) {
                throw new Error(`Consumer not found for installId: ${this.installId}`);
            }

            if (!consumer.oauth_token) {
                throw new Error('OAuth token not found for consumer');
            }

            // Check if token is expired
            if (consumer.oauth_expires_at && new Date() >= consumer.oauth_expires_at) {
                throw new Error('OAuth token expired');
            }

            // Set base URL - extract site number from siteId
            const siteNumber = this.siteId.substring(0, 2);
            this.baseURL = `https://secure.p${siteNumber}.eloqua.com`;

            logger.debug('Eloqua base URL set', {
                baseURL: this.baseURL,
                siteId: this.siteId
            });

            // Create axios client
            this.client = axios.create({
                baseURL: this.baseURL,
                headers: {
                    'Authorization': `Bearer ${consumer.oauth_token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });

            // Add response interceptor for error handling
            this.client.interceptors.response.use(
                response => {
                    logger.debug('Eloqua API response', {
                        status: response.status,
                        url: response.config.url
                    });
                    return response;
                },
                error => {
                    logger.error('Eloqua API error', {
                        status: error.response?.status,
                        statusText: error.response?.statusText,
                        data: error.response?.data,
                        url: error.config?.url,
                        method: error.config?.method
                    });
                    throw error;
                }
            );

            this.initialized = true;

            logger.info('Eloqua client initialized successfully', {
                installId: this.installId,
                baseURL: this.baseURL
            });

        } catch (error) {
            logger.error('Failed to initialize Eloqua client', {
                installId: this.installId,
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Ensure client is initialized before making requests
     */
    async ensureInitialized() {
        if (!this.initialized || !this.client) {
            logger.debug('Client not initialized, initializing now', {
                installId: this.installId
            });
            await this.initialize();
        }
    }

    /**
     * Update action instance with recordDefinition
     * PUT /api/cloud/1.0/actions/instances/{id}
     */
    async updateActionInstance(instanceId, updatePayload) {
        await this.ensureInitialized();
        
        if (!this.client) {
            throw new Error('Eloqua client is not initialized');
        }

        const url = `/api/cloud/1.0/actions/instances/${instanceId}`;
        
        logger.info('Updating Eloqua action instance', {
            instanceId,
            fullUrl: `${this.baseURL}${url}`,
            payload: updatePayload
        });

        try {
            const response = await this.client.put(url, updatePayload);
            
            logger.info('Eloqua action instance updated successfully', {
                instanceId,
                status: response.status,
                requiresConfiguration: updatePayload.requiresConfiguration
            });
            
            return response.data;
        } catch (error) {
            logger.error('Failed to update Eloqua action instance', {
                instanceId,
                error: error.message,
                status: error.response?.status,
                statusText: error.response?.statusText,
                responseData: error.response?.data,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Update decision instance with recordDefinition
     * PUT /api/cloud/1.0/decisions/instances/{id}
     */
    async updateDecisionInstance(instanceId, updatePayload) {
        await this.ensureInitialized();
        
        if (!this.client) {
            throw new Error('Eloqua client is not initialized');
        }

        const url = `/api/cloud/1.0/decisions/instances/${instanceId}`;
        
        logger.info('Updating Eloqua decision instance', {
            instanceId,
            fullUrl: `${this.baseURL}${url}`,
            payload: updatePayload
        });

        try {
            const response = await this.client.put(url, updatePayload);
            
            logger.info('Eloqua decision instance updated successfully', {
                instanceId,
                status: response.status,
                requiresConfiguration: updatePayload.requiresConfiguration
            });
            
            return response.data;
        } catch (error) {
            logger.error('Failed to update Eloqua decision instance', {
                instanceId,
                error: error.message,
                status: error.response?.status,
                responseData: error.response?.data,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Update feeder instance with recordDefinition
     * PUT /api/cloud/1.0/content/instances/{id}
     */
    async updateFeederInstance(instanceId, updatePayload) {
        await this.ensureInitialized();
        
        if (!this.client) {
            throw new Error('Eloqua client is not initialized');
        }

        const url = `/api/cloud/1.0/content/instances/${instanceId}`;
        
        logger.info('Updating Eloqua feeder instance', {
            instanceId,
            fullUrl: `${this.baseURL}${url}`,
            payload: updatePayload
        });

        try {
            const response = await this.client.put(url, updatePayload);
            
            logger.info('Eloqua feeder instance updated successfully', {
                instanceId,
                status: response.status,
                requiresConfiguration: updatePayload.requiresConfiguration
            });
            
            return response.data;
        } catch (error) {
            logger.error('Failed to update Eloqua feeder instance', {
                instanceId,
                error: error.message,
                status: error.response?.status,
                responseData: error.response?.data,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Get action instance details
     * GET /api/cloud/1.0/actions/instances/{id}
     */
    async getActionInstance(instanceId) {
        await this.ensureInitialized();
        
        const url = `/api/cloud/1.0/actions/instances/${instanceId}`;
        
        try {
            const response = await this.client.get(url);
            return response.data;
        } catch (error) {
            logger.error('Failed to get action instance', {
                instanceId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get decision instance details
     * GET /api/cloud/1.0/decisions/instances/{id}
     */
    async getDecisionInstance(instanceId) {
        await this.ensureInitialized();
        
        const url = `/api/cloud/1.0/decisions/instances/${instanceId}`;
        
        try {
            const response = await this.client.get(url);
            return response.data;
        } catch (error) {
            logger.error('Failed to get decision instance', {
                instanceId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get feeder instance details
     * GET /api/cloud/1.0/content/instances/{id}
     */
    async getFeederInstance(instanceId) {
        await this.ensureInitialized();
        
        const url = `/api/cloud/1.0/content/instances/${instanceId}`;
        
        try {
            const response = await this.client.get(url);
            return response.data;
        } catch (error) {
            logger.error('Failed to get feeder instance', {
                instanceId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get custom objects
     * GET /api/REST/2.0/assets/customObjects
     */
    async getCustomObjects(search = '', count = 50) {
        await this.ensureInitialized();
        
        const params = {
            count: count,
            depth: 'minimal'
        };

        if (search) {
            params.search = search;
        }

        try {
            const response = await this.client.get('/api/REST/2.0/assets/customObjects', {
                params
            });

            logger.debug('Custom objects fetched', {
                count: response.data.elements?.length || 0,
                search
            });

            return response.data;
        } catch (error) {
            logger.error('Failed to fetch custom objects', {
                error: error.message,
                status: error.response?.status
            });
            throw error;
        }
    }

    /**
     * Get custom object by ID
     * GET /api/REST/2.0/assets/customObject/{id}
     */
    async getCustomObject(customObjectId) {
        await this.ensureInitialized();
        
        try {
            const response = await this.client.get(
                `/api/REST/2.0/assets/customObject/${customObjectId}`,
                {
                    params: { depth: 'complete' }
                }
            );

            logger.debug('Custom object fetched', {
                customObjectId,
                name: response.data.name,
                fieldCount: response.data.fields?.length || 0
            });

            return response.data;
        } catch (error) {
            logger.error('Failed to fetch custom object', {
                customObjectId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create custom object record
     * POST /api/REST/2.0/data/customObject/{id}
     */
    async createCustomObjectRecord(customObjectId, data) {
        await this.ensureInitialized();
        
        try {
            const response = await this.client.post(
                `/api/REST/2.0/data/customObject/${customObjectId}`,
                data
            );

            logger.debug('Custom object record created', {
                customObjectId,
                recordId: response.data.id
            });

            return response.data;
        } catch (error) {
            logger.error('Failed to create custom object record', {
                customObjectId,
                error: error.message,
                response: error.response?.data
            });
            throw error;
        }
    }

    /**
     * Get contact fields
     * GET /api/REST/2.0/assets/contact/fields
     */
    async getContactFields(count = 200) {
        await this.ensureInitialized();
        
        try {
            const response = await this.client.get('/api/REST/2.0/assets/contact/fields', {
                params: {
                    count: count,
                    depth: 'minimal'
                }
            });

            logger.debug('Contact fields fetched', {
                count: response.data.elements?.length || 0
            });

            // Transform to match expected format
            return {
                items: response.data.elements || [],
                total: response.data.total || 0
            };
        } catch (error) {
            logger.error('Failed to fetch contact fields', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get contact by ID
     * GET /api/REST/2.0/data/contact/{id}
     */
    async getContact(contactId) {
        await this.ensureInitialized();
        
        try {
            const response = await this.client.get(
                `/api/REST/2.0/data/contact/${contactId}`,
                {
                    params: { depth: 'complete' }
                }
            );

            return response.data;
        } catch (error) {
            logger.error('Failed to fetch contact', {
                contactId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Update contact
     * PUT /api/REST/2.0/data/contact/{id}
     */
    async updateContact(contactId, data) {
        await this.ensureInitialized();
        
        try {
            const response = await this.client.put(
                `/api/REST/2.0/data/contact/${contactId}`,
                data
            );

            logger.debug('Contact updated', { contactId });

            return response.data;
        } catch (error) {
            logger.error('Failed to update contact', {
                contactId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get campaigns
     * GET /api/REST/2.0/assets/campaigns
     */
    async getCampaigns(search = '', count = 50) {
        await this.ensureInitialized();
        
        const params = {
            count: count,
            depth: 'minimal'
        };

        if (search) {
            params.search = search;
        }

        try {
            const response = await this.client.get('/api/REST/2.0/assets/campaigns', {
                params
            });

            return response.data;
        } catch (error) {
            logger.error('Failed to fetch campaigns', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get campaign by ID
     * GET /api/REST/2.0/assets/campaign/{id}
     */
    async getCampaign(campaignId) {
        await this.ensureInitialized();
        
        try {
            const response = await this.client.get(
                `/api/REST/2.0/assets/campaign/${campaignId}`,
                {
                    params: { depth: 'complete' }
                }
            );

            return response.data;
        } catch (error) {
            logger.error('Failed to fetch campaign', {
                campaignId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Search contacts
     * GET /api/REST/2.0/data/contacts
     */
    async searchContacts(searchQuery, count = 50) {
        await this.ensureInitialized();
        
        try {
            const response = await this.client.get('/api/REST/2.0/data/contacts', {
                params: {
                    search: searchQuery,
                    count: count,
                    depth: 'minimal'
                }
            });

            return response.data;
        } catch (error) {
            logger.error('Failed to search contacts', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get activity types
     * GET /api/REST/2.0/assets/visitor/activityTypes
     */
    async getActivityTypes() {
        await this.ensureInitialized();
        
        try {
            const response = await this.client.get('/api/REST/2.0/assets/visitor/activityTypes');
            return response.data;
        } catch (error) {
            logger.error('Failed to fetch activity types', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create activity
     * POST /api/REST/2.0/data/activity
     */
    async createActivity(activityData) {
        await this.ensureInitialized();
        
        try {
            const response = await this.client.post(
                '/api/REST/2.0/data/activity',
                activityData
            );

            logger.debug('Activity created', {
                activityType: activityData.type
            });

            return response.data;
        } catch (error) {
            logger.error('Failed to create activity', {
                error: error.message
            });
            throw error;
        }
    }
}

module.exports = EloquaService;