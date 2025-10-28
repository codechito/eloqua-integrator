const ActionInstance = require('../models/ActionInstance');
const Consumer = require('../models/Consumer');
const SmsLog = require('../models/SmsLog');
const { EloquaService, TransmitSmsService } = require('../services');
const { 
    logger, 
    formatPhoneNumber, 
    generateId,
    replaceMergeFields,
    extractMergeFields
} = require('../utils');
const { asyncHandler } = require('../middleware');

class ActionController {
    /**
     * Create action instance
     * GET /eloqua/action/create
     */
    static create = asyncHandler(async (req, res) => {
        const { installId, siteId, assetId } = req.query;
        const instanceId = generateId();

        logger.info('Creating action instance', { installId, instanceId });

        const instance = new ActionInstance({
            instanceId,
            installId,
            SiteId: siteId,
            assetId,
            message: '',
            recipient_field: 'mobilePhone',
            message_expiry: 'NO',
            message_validity: 1,
            send_mode: 'all'
        });

        await instance.save();

        logger.info('Action instance created', { instanceId });

        res.json({
            success: true,
            instanceId
        });
    });

    /**
     * Get configure page
     * GET /eloqua/action/configure
     */
    static configure = asyncHandler(async (req, res) => {
        const { installId, siteId, instanceId } = req.query;

        logger.info('Loading action configuration page', { installId, instanceId });

        const consumer = await Consumer.findOne({ installId });
        if (!consumer) {
            return res.status(404).send('Consumer not found');
        }

        let instance = await ActionInstance.findOne({ instanceId });
        
        if (!instance) {
            instance = {
                instanceId,
                installId,
                SiteId: siteId,
                message: '',
                send_mode: 'all',
                message_expiry: 'NO',
                message_validity: 1
            };
        }

        // Get Eloqua data
        const eloquaService = new EloquaService(installId, siteId);
        
        const custom_objects = await eloquaService.getCustomObjects('', 100);
        const contactFieldsData = await eloquaService.getContactFields(200);
        const merge_fields = contactFieldsData.elements || [];

        // Get sender IDs from TransmitSMS
        let sender_ids = { 'Virtual Number': [], 'Business Name': [] };
        if (consumer.transmitsms_api_key && consumer.transmitsms_api_secret) {
            try {
                const smsService = new TransmitSmsService(
                    consumer.transmitsms_api_key,
                    consumer.transmitsms_api_secret
                );
                sender_ids = await smsService.getSenderIds();
            } catch (error) {
                logger.warn('Could not fetch sender IDs', { error: error.message });
            }
        }

        const countries = require('../data/countries.json');

        res.render('action-config', {
            consumer: consumer.toObject(),
            instance,
            custom_objects,
            merge_fields,
            sender_ids,
            countries
        });
    });

    /**
     * Save configuration
     * POST /eloqua/action/configure
     */
    static saveConfiguration = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;
        const { instance: instanceData } = req.body;

        logger.info('Saving action configuration', { instanceId });

        let instance = await ActionInstance.findOne({ instanceId });
        
        if (!instance) {
            instance = new ActionInstance({ 
                instanceId, 
                ...instanceData 
            });
        } else {
            Object.assign(instance, instanceData);
        }

        await instance.save();

        logger.info('Action configuration saved', { instanceId });

        res.json({
            success: true,
            message: 'Configuration saved successfully'
        });
    });

    /**
     * Notify (Execute action)
     * POST /eloqua/action/notify
     */
    static notify = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;
        const executionData = req.body;

        logger.info('Action notify received', { 
            instanceId, 
            recordCount: executionData.records?.length || 0 
        });

        const instance = await ActionInstance.findOne({ instanceId });
        if (!instance) {
            return res.status(404).json({ error: 'Instance not found' });
        }

        const consumer = await Consumer.findOne({ installId: instance.installId });
        if (!consumer) {
            return res.status(404).json({ error: 'Consumer not found' });
        }

        // Validate configuration
        if (!consumer.transmitsms_api_key || !consumer.transmitsms_api_secret) {
            logger.error('TransmitSMS not configured', { instanceId });
            return res.status(400).json({ 
                error: 'TransmitSMS API not configured' 
            });
        }

        // Process SMS sending
        const results = await ActionController.processSendSms(
            instance, 
            consumer, 
            executionData
        );

        logger.info('Action notify completed', { 
            instanceId, 
            successCount: results.filter(r => r.success).length,
            failCount: results.filter(r => !r.success).length
        });

        res.json({
            success: true,
            results
        });
    });

    /**
     * Process SMS sending
     */
    static async processSendSms(instance, consumer, executionData) {
        const smsService = new TransmitSmsService(
            consumer.transmitsms_api_key,
            consumer.transmitsms_api_secret
        );

        const eloquaService = new EloquaService(
            instance.installId,
            instance.SiteId
        );

        const results = [];
        const records = executionData.records || [];

        for (const record of records) {
            try {
                // Get mobile number
                const mobileNumber = ActionController.getFieldValue(
                    record, 
                    instance.recipient_field
                );

                if (!mobileNumber) {
                    results.push({
                        contactId: record.contactId,
                        success: false,
                        error: 'Mobile number not found'
                    });
                    continue;
                }

                // Format phone number
                const formattedNumber = formatPhoneNumber(
                    mobileNumber, 
                    consumer.default_country
                );

                // Process message with merge fields
                let message = replaceMergeFields(instance.message, record);

                // Handle tracked link
                let trackedLinkData = null;
                if (instance.tracked_link && message.includes('[tracked-link]')) {
                    const linkResponse = await smsService.addTrackedLink(
                        instance.tracked_link,
                        instance.assetName || 'Campaign'
                    );
                    trackedLinkData = {
                        shortUrl: linkResponse.short_url,
                        originalUrl: instance.tracked_link
                    };
                    message = message.replace('[tracked-link]', linkResponse.short_url);
                }

                // Send SMS
                const smsOptions = {
                    from: instance.caller_id || undefined,
                    dlr_callback: consumer.dlr_callback
                };

                if (instance.message_expiry === 'YES') {
                    smsOptions.validity = instance.message_validity;
                }

                const smsResponse = await smsService.sendSms(
                    formattedNumber,
                    message,
                    smsOptions
                );

                // Log SMS
                const smsLog = new SmsLog({
                    installId: instance.installId,
                    instanceId: instance.instanceId,
                    contactId: record.contactId,
                    emailAddress: record.emailAddress || '',
                    mobileNumber: formattedNumber,
                    message,
                    messageId: smsResponse.message_id,
                    senderId: instance.caller_id,
                    campaignTitle: instance.assetName,
                    status: 'sent',
                    transmitSmsResponse: smsResponse,
                    sentAt: new Date(),
                    trackedLink: trackedLinkData
                });

                await smsLog.save();

                // Update custom object if configured
                if (instance.custom_object_id) {
                    await ActionController.updateCustomObject(
                        eloquaService,
                        instance,
                        record,
                        smsLog,
                        'sent'
                    );
                }

                // Update stats
                await instance.incrementSent();

                results.push({
                    contactId: record.contactId,
                    success: true,
                    messageId: smsResponse.message_id
                });

                logger.sms('sent', {
                    instanceId: instance.instanceId,
                    to: formattedNumber,
                    messageId: smsResponse.message_id
                });

            } catch (error) {
                logger.error('Error sending SMS', {
                    instanceId: instance.instanceId,
                    contactId: record.contactId,
                    error: error.message
                });

                await instance.incrementFailed();

                results.push({
                    contactId: record.contactId,
                    success: false,
                    error: error.message
                });
            }
        }

        return results;
    }

    /**
     * Get field value from record
     */
    static getFieldValue(record, fieldPath) {
        if (!fieldPath) return null;
        
        const parts = fieldPath.split('__');
        if (parts.length > 1) {
            return record[parts[1]] || null;
        }
        
        return record[fieldPath] || null;
    }

    /**
     * Update custom object
     */
    static async updateCustomObject(eloquaService, instance, record, smsLog, status) {
        try {
            const cdoData = {
                fieldValues: []
            };

            if (instance.mobile_field) {
                cdoData.fieldValues.push({
                    id: instance.mobile_field,
                    value: smsLog.mobileNumber
                });
            }

            if (instance.email_field) {
                cdoData.fieldValues.push({
                    id: instance.email_field,
                    value: smsLog.emailAddress
                });
            }

            if (instance.outgoing_field) {
                cdoData.fieldValues.push({
                    id: instance.outgoing_field,
                    value: smsLog.message
                });
            }

            if (instance.notification_field) {
                cdoData.fieldValues.push({
                    id: instance.notification_field,
                    value: status
                });
            }

            if (instance.vn_field && smsLog.senderId) {
                cdoData.fieldValues.push({
                    id: instance.vn_field,
                    value: smsLog.senderId
                });
            }

            if (instance.title_field) {
                cdoData.fieldValues.push({
                    id: instance.title_field,
                    value: smsLog.campaignTitle || ''
                });
            }

            await eloquaService.createCustomObjectRecord(
                instance.custom_object_id, 
                cdoData
            );

            logger.debug('Custom object updated', {
                customObjectId: instance.custom_object_id,
                contactId: record.contactId
            });

        } catch (error) {
            logger.error('Error updating custom object', {
                error: error.message,
                customObjectId: instance.custom_object_id
            });
        }
    }

    /**
     * Copy instance
     * POST /eloqua/action/copy
     */
    static copy = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;
        const newInstanceId = generateId();

        logger.info('Copying action instance', { instanceId, newInstanceId });

        const instance = await ActionInstance.findOne({ instanceId });
        if (!instance) {
            return res.status(404).json({ error: 'Instance not found' });
        }

        const newInstance = new ActionInstance({
            ...instance.toObject(),
            _id: undefined,
            instanceId: newInstanceId,
            totalSent: 0,
            totalFailed: 0,
            lastExecutedAt: undefined,
            createdAt: undefined,
            updatedAt: undefined
        });

        await newInstance.save();

        logger.info('Action instance copied', { newInstanceId });

        res.json({
            success: true,
            instanceId: newInstanceId
        });
    });

    /**
     * Delete instance
     * POST /eloqua/action/delete
     */
    static delete = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;

        logger.info('Deleting action instance', { instanceId });

        await ActionInstance.findOneAndUpdate(
            { instanceId },
            { isActive: false }
        );

        logger.info('Action instance deleted', { instanceId });

        res.json({
            success: true,
            message: 'Instance deleted successfully'
        });
    });

    /**
     * Test SMS
     * POST /eloqua/action/ajax/testsms/:installId/:siteId/:country/:phone
     */
    static testSms = asyncHandler(async (req, res) => {
        const { installId, siteId, country, phone } = req.params;
        const { message, caller_id, tracked_link_url } = req.body;

        logger.info('Testing SMS', { installId, phone });

        const consumer = await Consumer.findOne({ installId });
        if (!consumer) {
            return res.status(404).json({ 
                error: 'Consumer not found',
                description: 'Consumer not found' 
            });
        }

        if (!consumer.transmitsms_api_key || !consumer.transmitsms_api_secret) {
            return res.status(400).json({ 
                error: 'Not configured',
                description: 'TransmitSMS API not configured' 
            });
        }

        const smsService = new TransmitSmsService(
            consumer.transmitsms_api_key,
            consumer.transmitsms_api_secret
        );

        const formattedNumber = formatPhoneNumber(phone, country);

        let finalMessage = message;
        if (tracked_link_url && message.includes('[tracked-link]')) {
            const linkResponse = await smsService.addTrackedLink(
                tracked_link_url, 
                'Test'
            );
            finalMessage = message.replace('[tracked-link]', linkResponse.short_url);
        }

        const response = await smsService.sendSms(
            formattedNumber,
            finalMessage,
            { from: caller_id || undefined }
        );

        logger.sms('test_sent', { to: formattedNumber });

        res.json({
            success: true,
            message: 'Test SMS sent successfully',
            response
        });
    });

    /**
     * Get custom objects (AJAX) with pagination and search
     * GET /eloqua/action/ajax/customobjects/:installId/:siteId/customObject
     */
    static getCustomObjects = asyncHandler(async (req, res) => {
        const { installId, siteId } = req.params;
        const { search = '', page = 1, count = 50 } = req.query;

        logger.debug('AJAX: Fetching custom objects', { 
            installId, 
            search, 
            page, 
            count 
        });

        // Use auth from session middleware
        const eloquaService = new EloquaService(installId, siteId);
        
        try {
            const customObjects = await eloquaService.getCustomObjects(search, count);

            logger.debug('Custom objects fetched', { 
                count: customObjects.elements?.length || 0 
            });

            res.json(customObjects);
        } catch (error) {
            logger.error('Error fetching custom objects', {
                installId,
                error: error.message
            });

            res.status(500).json({
                error: 'Failed to fetch custom objects',
                message: error.message,
                elements: []
            });
        }
    });

    /**
     * Get custom object fields (AJAX)
     * GET /eloqua/action/ajax/customobject/:installId/:siteId/:customObjectId
     */
    static getCustomObjectFields = asyncHandler(async (req, res) => {
        const { installId, siteId, customObjectId } = req.params;

        logger.debug('AJAX: Fetching custom object fields', { 
            installId, 
            customObjectId 
        });

        const eloquaService = new EloquaService(installId, siteId);
        
        try {
            const customObject = await eloquaService.getCustomObject(customObjectId);

            logger.debug('Custom object fields fetched', { 
                fieldCount: customObject.fields?.length || 0 
            });

            res.json(customObject);
        } catch (error) {
            logger.error('Error fetching custom object fields', {
                installId,
                customObjectId,
                error: error.message
            });

            res.status(500).json({
                error: 'Failed to fetch fields',
                message: error.message,
                fields: []
            });
        }
    });
}

module.exports = ActionController;