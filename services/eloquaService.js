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
     * Extract pod number from siteId
     */
    getPodFromSiteId(siteId) {
        if (!siteId) {
            logger.warn('No siteId provided, defaulting to p03');
            return 'p03';
        }

        const siteIdStr = String(siteId);
        
        let podNumber;
        if (siteIdStr.length >= 3) {
            podNumber = parseInt(siteIdStr.charAt(0));
        } else {
            podNumber = parseInt(siteIdStr);
        }

        const pod = `p${String(podNumber).padStart(2, '0')}`;
        
        logger.debug('Extracted pod from siteId', {
            siteId: siteIdStr,
            pod: pod
        });

        return pod;
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
                expiresAt: consumer.oauth_expires_at,
                isExpired: consumer.oauth_expires_at ? new Date() >= consumer.oauth_expires_at : 'NO_EXPIRY'
            });

            if (consumer.oauth_expires_at && new Date() >= consumer.oauth_expires_at) {
                logger.error('OAuth token is expired', {
                    installId: this.installId,
                    expiresAt: consumer.oauth_expires_at,
                    now: new Date()
                });
                throw new Error('OAuth token expired');
            }

            const pod = this.getPodFromSiteId(this.siteId);
            this.baseURL = `https://secure.${pod}.eloqua.com`;

            logger.info('Eloqua base URL constructed', {
                siteId: this.siteId,
                pod: pod,
                baseURL: this.baseURL
            });

            // **FIX: For App Cloud, use Basic Auth with the OAuth token**
            // The token is already in the format: company:sessionId (Base64 encoded)
            // We need to use it as Basic Auth, not Bearer
            
            this.client = axios.create({
                baseURL: this.baseURL,
                headers: {
                    'Authorization': `Basic ${consumer.oauth_token}`,  // Changed from Bearer to Basic
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
                        authType: config.headers?.Authorization?.substring(0, 10) || 'NO_AUTH'
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
                        baseURL: this.baseURL,
                        authHeader: error.config?.headers?.Authorization?.substring(0, 20) + '...'
                    });
                    throw error;
                }
            );

            this.initialized = true;

            logger.info('Eloqua client initialized successfully', {
                installId: this.installId,
                baseURL: this.baseURL,
                authType: 'Basic'
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

    // ... rest of the methods remain the same
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