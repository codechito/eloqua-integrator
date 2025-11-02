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
     * Get Eloqua base URL using the id endpoint
     * This is required for App Cloud apps
     */
    async getEloquaBaseUrl(accessToken) {
        try {
            logger.debug('Fetching Eloqua base URL', {
                installId: this.installId
            });

            const response = await axios.get('https://login.eloqua.com/id', {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            });

            const baseUrl = response.data.urls.base;
            
            logger.info('Eloqua base URL retrieved', {
                installId: this.installId,
                baseUrl
            });

            return baseUrl;

        } catch (error) {
            logger.error('Failed to get Eloqua base URL', {
                installId: this.installId,
                error: error.message,
                response: error.response?.data
            });
            throw error;
        }
    }

    /**
     * Initialize the Eloqua client with OAuth token
     */
    async initialize() {
        if (this.initialized) {
            return;
        }

        try {
            logger.debug('Initializing Eloqua client', {
                installId: this.installId,
                siteId: this.siteId
            });

            const consumer = await Consumer.findOne({ installId: this.installId })
                .select('+oauth_token +oauth_expires_at +oauth_refresh_token');

            if (!consumer) {
                throw new Error(`Consumer not found for installId: ${this.installId}`);
            }

            if (!consumer.oauth_token) {
                throw new Error('OAuth token not found for consumer');
            }

            const tokenPreview = consumer.oauth_token 
                ? `${consumer.oauth_token.substring(0, 10)}...${consumer.oauth_token.substring(consumer.oauth_token.length - 10)}`
                : 'NO_TOKEN';

            logger.debug('OAuth token found', {
                installId: this.installId,
                tokenPreview,
                tokenLength: consumer.oauth_token?.length || 0,
                expiresAt: consumer.oauth_expires_at
            });

            if (consumer.oauth_expires_at && new Date() >= consumer.oauth_expires_at) {
                logger.error('OAuth token is expired', {
                    installId: this.installId,
                    expiresAt: consumer.oauth_expires_at,
                    now: new Date()
                });
                throw new Error('OAuth token expired');
            }

            // **KEY FIX: Get the actual Eloqua base URL using the /id endpoint**
            this.baseURL = await this.getEloquaBaseUrl(consumer.oauth_token);

            logger.info('Eloqua base URL set', {
                installId: this.installId,
                baseURL: this.baseURL
            });

            // **KEY FIX: Use Bearer token, not Basic**
            this.client = axios.create({
                baseURL: this.baseURL,
                headers: {
                    'Authorization': `Bearer ${consumer.oauth_token}`,  // Bearer, not Basic!
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });

            this.client.interceptors.request.use(
                config => {
                    logger.debug('Eloqua API request', {
                        method: config.method?.toUpperCase(),
                        url: config.url,
                        baseURL: config.baseURL,
                        hasAuth: !!config.headers?.Authorization,
                        authType: 'Bearer'
                    });
                    return config;
                },
                error => {
                    logger.error('Request interceptor error', {
                        error: error.message
                    });
                    return Promise.reject(error);
                }
            );

            this.client.interceptors.response.use(
                response => {
                    logger.debug('Eloqua API response success', {
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
                        method: error.config?.method,
                        baseURL: this.baseURL
                    });
                    throw error;
                }
            );

            this.initialized = true;

            logger.info('Eloqua client initialized successfully', {
                installId: this.installId,
                siteId: this.siteId,
                baseURL: this.baseURL,
                authType: 'Bearer'
            });

        } catch (error) {
            logger.error('Failed to initialize Eloqua client', {
                installId: this.installId,
                siteId: this.siteId,
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    async ensureInitialized() {
        if (!this.initialized || !this.client) {
            logger.debug('Client not initialized, initializing now', {
                installId: this.installId
            });
            await this.initialize();
        }
    }

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

    async getCustomObjects(search = '', count = 50) {
        await this.ensureInitialized();
        
        const params = {
            count: count,
            depth: 'minimal'
        };

        if (search) {
            params.search = `name=${search}*`;
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

    async createCustomObjectRecord(customObjectId, data) {
        await this.ensureInitialized();
        
        try {
            const response = await this.client.post(
                `/api/REST/2.0/data/customObject/${customObjectId}/instance`,
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