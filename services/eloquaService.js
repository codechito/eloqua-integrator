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
        this.accessToken = null;
        this.refreshToken = null;
        this.tokenExpiry = null;
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
     * Refresh OAuth access token using Eloqua's token endpoint
     * Matches the old working implementation exactly
     */
    async refreshAccessToken(consumer) {
        try {
            logger.info('Refreshing Eloqua OAuth token', {
                installId: this.installId
            });

            if (!consumer.oauth_refresh_token) {
                throw new Error('No refresh token available');
            }

            // Create Basic Auth credentials (exactly like old code)
            const credentials = Buffer.from(
                `${process.env.ELOQUA_CLIENT_ID}:${process.env.ELOQUA_CLIENT_SECRET}`
            ).toString('base64');

            // Build the body (exactly like old code)
            const body = {
                grant_type: 'refresh_token',
                refresh_token: consumer.oauth_refresh_token,
                scope: 'full',
                redirect_uri: process.env.ELOQUA_REDIRECT_URI
            };

            logger.debug('Token refresh request', {
                installId: this.installId,
                url: 'https://login.eloqua.com/auth/oauth2/token',
                hasRefreshToken: !!consumer.oauth_refresh_token,
                clientId: process.env.ELOQUA_CLIENT_ID,
                redirectUri: process.env.ELOQUA_REDIRECT_URI
            });

            // Make the request (matching old code structure)
            const response = await axios.post(
                'https://login.eloqua.com/auth/oauth2/token',
                body,
                {
                    headers: {
                        'Authorization': `Basic ${credentials}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            const result = response.data;

            // Validate response (like old code)
            if (!result.refresh_token || !result.access_token) {
                throw new Error('Invalid token response from Eloqua');
            }

            // Calculate expiry time
            const expiryDate = new Date();
            expiryDate.setSeconds(expiryDate.getSeconds() + (result.expires_in || 28800)); // 8 hours default

            logger.info('OAuth token refreshed successfully', {
                installId: this.installId,
                expiresAt: expiryDate.toISOString()
            });

            // Update consumer (like old code)
            consumer.oauth_token = result.access_token;
            consumer.oauth_refresh_token = result.refresh_token;
            consumer.oauth_expires_at = expiryDate;
            await consumer.save();

            return result.access_token;

        } catch (error) {
            const status = error.response?.status;
            const responseData = error.response?.data;

            logger.error('Failed to refresh OAuth token', {
                installId: this.installId,
                error: error.message,
                status: status,
                responseData: responseData
            });

            // Handle errors like old code
            if (status >= 400) {
                if (status === 401) {
                    throw new Error('OAuth refresh token invalid. Please reinstall the app in Eloqua.');
                }
                throw new Error(`Eloqua token refresh failed: ${responseData?.error_description || error.message}`);
            }

            throw new Error(`Failed to refresh OAuth token: ${error.message}`);
        }
    }

    /**
     * Ensure token is valid and refresh if needed
     */
    async ensureValidToken(consumer) {
        const now = new Date();
        const expiryDate = new Date(consumer.oauth_expires_at);
        const bufferTime = 5 * 60 * 1000; // 5 minutes buffer

        if (expiryDate.getTime() - bufferTime < now.getTime()) {
            logger.info('OAuth token expired or expiring soon, refreshing...', {
                installId: this.installId,
                expiresAt: consumer.oauth_expires_at,
                now: now.toISOString()
            });

            // Refresh the token
            const newToken = await this.refreshAccessToken(consumer);
            
            // Reload consumer with new token
            const updatedConsumer = await Consumer.findOne({ installId: this.installId })
                .select('+oauth_token +oauth_refresh_token +oauth_expires_at');

            return {
                token: updatedConsumer.oauth_token,
                expiry: updatedConsumer.oauth_expires_at
            };
        }

        return {
            token: consumer.oauth_token,
            expiry: consumer.oauth_expires_at
        };
    }

    /**
     * Initialize the Eloqua client with OAuth token
     */
    async initialize() {
        if (this.initialized && this.client) {
            // Check if token needs refresh
            const consumer = await Consumer.findOne({ installId: this.installId })
                .select('+oauth_token +oauth_expires_at +oauth_refresh_token');

            if (consumer) {
                const { token } = await this.ensureValidToken(consumer);
                
                // Update client headers if token was refreshed
                if (token !== this.accessToken) {
                    this.accessToken = token;
                    this.client.defaults.headers['Authorization'] = `Bearer ${token}`;
                    logger.debug('Updated client with refreshed token', {
                        installId: this.installId
                    });
                }
            }
            
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

            // Ensure token is valid and refresh if needed
            const { token, expiry } = await this.ensureValidToken(consumer);
            
            this.accessToken = token;
            this.tokenExpiry = expiry;
            this.refreshToken = consumer.oauth_refresh_token;

            // Get the actual Eloqua base URL using the /id endpoint
            this.baseURL = await this.getEloquaBaseUrl(this.accessToken);

            logger.info('Eloqua base URL set', {
                installId: this.installId,
                baseURL: this.baseURL
            });

            // Create axios client with Bearer token
            this.client = axios.create({
                baseURL: this.baseURL,
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });

            // Request interceptor
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

            // Response interceptor with auto-retry on 401
            this.client.interceptors.response.use(
                response => {
                    logger.debug('Eloqua API response success', {
                        status: response.status,
                        url: response.config.url
                    });
                    return response;
                },
                async error => {
                    const originalRequest = error.config;

                    // If 401 and not already retried, refresh token and retry
                    if (error.response?.status === 401 && !originalRequest._retry) {
                        originalRequest._retry = true;

                        logger.warn('Received 401, attempting to refresh token', {
                            installId: this.installId,
                            url: originalRequest.url
                        });

                        try {
                            const consumer = await Consumer.findOne({ installId: this.installId })
                                .select('+oauth_token +oauth_refresh_token +oauth_expires_at');

                            const newToken = await this.refreshAccessToken(consumer);
                            
                            this.accessToken = newToken;
                            this.client.defaults.headers['Authorization'] = `Bearer ${newToken}`;
                            originalRequest.headers['Authorization'] = `Bearer ${newToken}`;

                            logger.info('Token refreshed, retrying request', {
                                installId: this.installId,
                                url: originalRequest.url
                            });

                            return this.client(originalRequest);
                        } catch (refreshError) {
                            logger.error('Failed to refresh token on 401', {
                                installId: this.installId,
                                error: refreshError.message
                            });
                            return Promise.reject(refreshError);
                        }
                    }

                    logger.error('Eloqua API error', {
                        status: error.response?.status,
                        statusText: error.response?.statusText,
                        data: error.response?.data,
                        url: error.config?.url,
                        method: error.config?.method,
                        baseURL: this.baseURL
                    });
                    
                    return Promise.reject(error);
                }
            );

            this.initialized = true;

            logger.info('Eloqua client initialized successfully', {
                installId: this.installId,
                siteId: this.siteId,
                baseURL: this.baseURL,
                authType: 'Bearer',
                tokenExpiresAt: this.tokenExpiry
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
        } else {
            // Check token expiry even if initialized
            const consumer = await Consumer.findOne({ installId: this.installId })
                .select('+oauth_token +oauth_expires_at +oauth_refresh_token');

            if (consumer) {
                const { token } = await this.ensureValidToken(consumer);
                
                if (token !== this.accessToken) {
                    this.accessToken = token;
                    this.client.defaults.headers['Authorization'] = `Bearer ${token}`;
                    logger.debug('Token refreshed during ensureInitialized', {
                        installId: this.installId
                    });
                }
            }
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

    async getContactFields(count = 1000) {
        await this.ensureInitialized();
        
        try {
            logger.debug('Fetching contact fields from Bulk API', {
                installId: this.installId,
                count
            });

            const response = await this.client.get('/api/bulk/2.0/contacts/fields', {
                params: {
                    limit: count,
                    orderBy: 'name asc'
                }
            });

            logger.debug('Bulk API raw response sample', {
                sampleItem: response.data.items?.[0],
                itemKeys: response.data.items?.[0] ? Object.keys(response.data.items[0]) : []
            });

            const items = (response.data.items || []).map(field => {
                const mappedField = {
                    id: field.internalName,
                    name: field.name,
                    internalName: field.internalName,
                    dataType: field.dataType,
                    uri: field.uri
                };
                
                if (!mappedField.internalName) {
                    logger.warn('Field missing internalName in Bulk API response', {
                        fieldName: field.name,
                        fieldData: field
                    });
                }
                
                return mappedField;
            });

            logger.info('Contact fields mapped from Bulk API', {
                count: items.length,
                sampleMappedField: items[0]
            });

            return {
                items: items,
                total: response.data.totalResults || items.length,
                hasMore: response.data.hasMore || false
            };

        } catch (error) {
            logger.error('Failed to fetch contact fields from Bulk API', {
                installId: this.installId,
                error: error.message,
                status: error.response?.status,
                statusText: error.response?.statusText,
                responseData: error.response?.data
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

    async createBulkImport(type, definition) {
        await this.ensureInitialized();
        
        try {
            const endpoint = type === 'contacts' 
                ? '/api/bulk/2.0/contacts/imports'
                : `/api/bulk/2.0/customObjects/${type}/imports`;

            const response = await this.client.post(endpoint, definition);

            logger.info('Bulk import definition created', {
                uri: response.data.uri,
                type
            });

            return response.data;
        } catch (error) {
            logger.error('Error creating bulk import', {
                type,
                error: error.message
            });
            throw error;
        }
    }

    async uploadBulkImportData(importUri, data) {
        await this.ensureInitialized();
        
        try {
            const response = await this.client.post(`/api/bulk/2.0${importUri}/data`, data);

            logger.info('Bulk import data uploaded', {
                importUri,
                recordCount: data.length
            });

            return response.data;
        } catch (error) {
            logger.error('Error uploading bulk import data', {
                importUri,
                error: error.message
            });
            throw error;
        }
    }

    async syncBulkImport(importUri) {
        await this.ensureInitialized();
        
        try {
            const response = await this.client.post('/api/bulk/2.0/syncs', {
                syncedInstanceURI: importUri
            });

            logger.info('Bulk import sync started', {
                syncUri: response.data.uri,
                status: response.data.status
            });

            return response.data;
        } catch (error) {
            logger.error('Error syncing bulk import', {
                importUri,
                error: error.message
            });
            throw error;
        }
    }

    async checkSyncStatus(syncUri) {
        await this.ensureInitialized();
        
        try {
            const response = await this.client.get(`/api/bulk/2.0${syncUri}`);
            
            return response.data;
        } catch (error) {
            logger.error('Error checking sync status', {
                syncUri,
                error: error.message
            });
            throw error;
        }
    }
}

module.exports = EloquaService;