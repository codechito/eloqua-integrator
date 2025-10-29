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
     */
    async makeRequest(method, endpoint, data = null) {
        try {
            const url = `${this.baseUrl}${endpoint}`;
            
            const config = {
                method,
                url,
                headers: {
                    'Authorization': this.getAuthHeader(),
                    'Content-Type': 'application/json'
                },
                timeout: this.timeout
            };

            if (data) {
                config.data = data;
            }

            logger.debug(`TransmitSMS API ${method} ${endpoint}`, { hasData: !!data });

            const response = await axios(config);

            logger.api(endpoint, method, response.status, {
                service: 'TransmitSMS'
            });

            return response.data;
        } catch (error) {
            const errorMessage = error.response?.data?.error?.description || error.message;
            const statusCode = error.response?.status;

            logger.error(`TransmitSMS API Error: ${method} ${endpoint}`, {
                status: statusCode,
                error: errorMessage,
                data: error.response?.data
            });

            throw new Error(`TransmitSMS API Error (${statusCode}): ${errorMessage}`);
        }
    }

    /**
     * Send SMS
     * @param {string} to - Recipient phone number (E.164 format)
     * @param {string} message - SMS message
     * @param {object} options - Additional options
     */
    async sendSms(to, message, options = {}) {
        try {
            const payload = {
                to,
                message,
                ...options
            };

            // Add sender ID if provided
            if (options.from) {
                payload.from = options.from;
            }

            // Add validity period if message expiry is enabled
            if (options.validity) {
                payload.validity = options.validity;
            }

            // Add delivery report callback
            if (options.dlr_callback) {
                payload.dlr_callback = options.dlr_callback;
            }

            logger.sms('send_request', {
                to,
                messageLength: message.length,
                from: options.from
            });

            const response = await this.makeRequest('POST', '/send-sms.json', payload);

            logger.sms('send_success', {
                to,
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
        return await this.makeRequest('GET', `/get-delivery-status.json`, {
            message_id: messageId
        });
    }

    /**
     * Get sender IDs (virtual numbers and business names)
     */
    async getSenderIds() {
        try {
            logger.debug('Fetching sender IDs from TransmitSMS');

            const response = await this.makeRequest('GET', '/get-numbers.json');

            const senderIds = {
                'Virtual Number': [],
                'Business Name': []
            };

            // Extract virtual numbers
            if (response.numbers && Array.isArray(response.numbers)) {
                response.numbers.forEach(number => {
                    if (number.dedicated || number.type === 'dedicated') {
                        senderIds['Virtual Number'].push(number.number);
                    }
                });
            }

            // Extract business names/sender IDs
            if (response.sender_ids && Array.isArray(response.sender_ids)) {
                senderIds['Business Name'] = response.sender_ids;
            }

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
                'Business Name': []
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
    /**
     * Get sender IDs (virtual numbers, business names, mobile numbers)
     */
    async getSenderIds() {
        try {
            logger.debug('Fetching sender IDs from TransmitSMS');

            const response = await this.makeRequest('GET', '/get-sender-ids.json');

            const senderIds = {
                'Virtual Number': [],
                'Business Name': [],
                'Mobile Number': []
            };

            if (response.result && response.result.caller_ids) {
                const callerIds = response.result.caller_ids;
                
                // Extract all types of sender IDs
                if (callerIds['Virtual Number']) {
                    senderIds['Virtual Number'] = callerIds['Virtual Number'];
                }
                
                if (callerIds['Business Name']) {
                    senderIds['Business Name'] = callerIds['Business Name'];
                }
                
                if (callerIds['Mobile Number']) {
                    senderIds['Mobile Number'] = callerIds['Mobile Number'];
                }
            }

            logger.debug('Sender IDs fetched', {
                virtualNumbers: senderIds['Virtual Number'].length,
                businessNames: senderIds['Business Name'].length,
                mobileNumbers: senderIds['Mobile Number'].length
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
}

module.exports = TransmitSmsService;