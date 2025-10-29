const axios = require('axios');
const { logger } = require('../utils');
const config = require('../config/transmitsms');

class TransmitSmsService {
    constructor(apiKey, apiSecret) {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.baseUrl = config.api.baseUrl;
        this.timeout = config.api.timeout;
    }

    /**
     * Get authorization header (Basic Auth)
     */
    getAuthHeader() {
        const credentials = Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString('base64');
        return `Basic ${credentials}`;
    }

    /**
     * Make API request to TransmitSMS
     * @param {string} method - HTTP method
     * @param {string} endpoint - API endpoint
     * @param {object} data - Request data (will be converted to URLSearchParams for POST)
     */
    async makeRequest(method, endpoint, data = null) {
        try {
            const url = `${this.baseUrl}${endpoint}`;
            
            const axiosConfig = {
                method,
                url,
                headers: {
                    'Authorization': this.getAuthHeader()
                },
                timeout: this.timeout
            };

            if (data) {
                if (method === 'GET') {
                    // For GET requests, use query parameters
                    axiosConfig.params = data;
                    axiosConfig.headers['Accept'] = 'application/json';
                } else if (method === 'POST' || method === 'PUT') {
                    // For POST/PUT requests, use URL-encoded form data
                    const params = new URLSearchParams();
                    Object.keys(data).forEach(key => {
                        if (data[key] !== undefined && data[key] !== null) {
                            params.append(key, data[key]);
                        }
                    });
                    axiosConfig.data = params;
                    axiosConfig.headers['Content-Type'] = 'application/x-www-form-urlencoded';
                    axiosConfig.headers['Accept'] = 'application/json';
                }
                
                logger.debug(`TransmitSMS API ${method} ${endpoint}`, { 
                    hasData: !!data,
                    dataKeys: Object.keys(data),
                    contentType: axiosConfig.headers['Content-Type']
                });
            }

            const response = await axios(axiosConfig);

            logger.api(endpoint, method, response.status, {
                service: 'TransmitSMS'
            });

            return response.data;
        } catch (error) {
            const errorMessage = JSON.stringify(error.response?.data?.error?.description || error.message);
            const statusCode = JSON.stringify(error.response?.status);

            logger.error(`TransmitSMS API Error: ${method} ${endpoint}`, {
                status: statusCode,
                error: errorMessage,
                requestData: data,
                responseData: error.response?.data
            });

            throw new Error(`TransmitSMS API Error (${statusCode}): ${errorMessage}`);
        }
    }

    /**
     * Send SMS
     * @param {string} to - Recipient phone number (E.164 format)
     * @param {string} message - SMS message (can include [tracked-link] placeholder)
     * @param {object} options - Additional options
     */
    async sendSms(to, message, options = {}) {
        try {
            // Validate required fields
            if (!to || !to.trim()) {
                throw new Error('Recipient phone number is required');
            }

            if (!message || !message.trim()) {
                throw new Error('Message is required');
            }

            // Build payload with required fields
            const payload = {
                to: to.trim(),
                message: message.trim()
            };

            // Add optional fields
            if (options.from) {
                payload.from = options.from;
            }

            if (options.validity) {
                payload.validity = options.validity;
            }

            if (options.send_at) {
                payload.send_at = options.send_at;
            }

            if (options.countrycode) {
                payload.countrycode = options.countrycode;
            }

            if (options.replies_to_email) {
                payload.replies_to_email = options.replies_to_email;
            }

            // Add callback URLs with tracking parameters
            if (options.dlr_callback) {
                payload.dlr_callback = options.dlr_callback;
            }

            if (options.reply_callback) {
                payload.reply_callback = options.reply_callback;
            }

            if (options.link_hits_callback) {
                payload.link_hits_callback = options.link_hits_callback;
            }

            // If message contains [tracked-link], add the URL
            if (message.includes('[tracked-link]') && options.tracked_link_url) {
                payload.tracked_link_url = options.tracked_link_url;
            }

            logger.sms('send_request', {
                to: payload.to,
                messageLength: payload.message.length,
                from: payload.from || 'default',
                hasTrackedLink: payload.message.includes('[tracked-link]'),
                trackedLinkUrl: payload.tracked_link_url,
                hasCallbacks: !!(options.dlr_callback || options.reply_callback || options.link_hits_callback),
                payloadKeys: Object.keys(payload)
            });

            const response = await this.makeRequest('POST', '/send-sms.json', payload);

            logger.sms('send_success', {
                to: payload.to,
                messageId: response.message_id,
                status: response.status
            });

            return response;
        } catch (error) {
            logger.sms('send_failed', {
                to,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Send bulk SMS
     * @param {Array} messages - Array of message objects [{to, message}, ...]
     * @param {object} options - Additional options
     */
    async sendBulkSms(messages, options = {}) {
        const results = [];
        
        for (const msg of messages) {
            try {
                const result = await this.sendSms(msg.to, msg.message, {
                    ...options,
                    from: msg.from || options.from
                });
                results.push({
                    to: msg.to,
                    success: true,
                    messageId: result.message_id,
                    response: result
                });
            } catch (error) {
                results.push({
                    to: msg.to,
                    success: false,
                    error: error.message
                });
            }
        }
        
        return results;
    }

    /**
     * Get SMS responses/replies
     * @param {object} filters - Filter options
     */
    async getSmsResponses(filters = {}) {
        const params = {};
        
        if (filters.message_id) {
            params.message_id = filters.message_id;
        }
        
        if (filters.max_results) {
            params.max_results = filters.max_results;
        }

        return await this.makeRequest('GET', '/get-sms-responses.json', params);
    }

    /**
     * Get delivery status
     * @param {string} messageId - Message ID
     */
    async getDeliveryStatus(messageId) {
        return await this.makeRequest('GET', '/get-delivery-status.json', {
            message_id: messageId
        });
    }

    /**
     * Get sender IDs (virtual numbers and business names)
     */
    async getSenderIds() {
        try {
            logger.debug('Fetching sender IDs from TransmitSMS');

            const response = await this.makeRequest('GET', '/get-sender-ids.json');

            const senderIds = response.result.caller_ids;

            logger.debug('Sender IDs fetched', {
                virtualNumbers: senderIds['Virtual Number'].length,
                businessNames: senderIds['Business Name'].length
            });

            return senderIds;
        } catch (error) {
            logger.error('Error fetching sender IDs', { error: error.message });
            // Return empty arrays instead of failing
            return {
                'Virtual Number': [],
                'Business Name': [],
                'Mobile Number': []
            };
        }
    }

    /**
     * Get account info
     */
    async getAccountInfo() {
        return await this.makeRequest('GET', '/get-balance.json');
    }

    /**
     * Get credit balance
     */
    async getBalance() {
        const info = await this.getAccountInfo();
        return {
            balance: info.balance,
            currency: info.currency
        };
    }

    /**
     * Validate credentials
     */
    async validateCredentials() {
        try {
            await this.getAccountInfo();
            return true;
        } catch (error) {
            return false;
        }
    }
}

module.exports = TransmitSmsService;