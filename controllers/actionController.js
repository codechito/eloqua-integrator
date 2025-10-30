const ActionInstance = require('../models/ActionInstance');
const Consumer = require('../models/Consumer');
const SmsLog = require('../models/SmsLog');
const SmsJob = require('../models/SmsJob');
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
     * Get sender IDs from TransmitSMS
     * GET /eloqua/action/ajax/sender-ids/:installId/:siteId
     */
    static getSenderIds = asyncHandler(async (req, res) => {
        const { installId, siteId } = req.params;

        logger.info('Fetching sender IDs', { installId, siteId });

        const consumer = await Consumer.findOne({ installId })
            .select('+transmitsms_api_key +transmitsms_api_secret');
        
        if (!consumer) {
            return res.status(404).json({ error: 'Consumer not found' });
        }

        if (!consumer.transmitsms_api_key || !consumer.transmitsms_api_secret) {
            return res.status(400).json({ 
                error: 'TransmitSMS credentials not configured',
                result: {
                    caller_ids: {
                        'Virtual Number': [],
                        'Business Name': [],
                        'Mobile Number': []
                    }
                }
            });
        }

        try {
            const transmitSmsService = new TransmitSmsService(
                consumer.transmitsms_api_key,
                consumer.transmitsms_api_secret
            );

            const senderIds = await transmitSmsService.getSenderIds();

            logger.info('Sender IDs fetched successfully', { 
                installId,
                virtualNumbers: senderIds['Virtual Number']?.length || 0,
                businessNames: senderIds['Business Name']?.length || 0,
                mobileNumbers: senderIds['Mobile Number']?.length || 0
            });

            res.json({
                result: {
                    caller_ids: senderIds
                },
                error: {
                    code: 'SUCCESS',
                    description: 'OK'
                }
            });

        } catch (error) {
            logger.error('Error fetching sender IDs', {
                installId,
                error: error.message
            });

            res.status(500).json({
                error: 'Failed to fetch sender IDs',
                message: error.message,
                result: {
                    caller_ids: {
                        'Virtual Number': [],
                        'Business Name': [],
                        'Mobile Number': []
                    }
                }
            });
        }
    });

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
            send_mode: 'all',
            requiresConfiguration: true // Initially requires configuration
        });

        await instance.save();

        logger.info('Action instance created', { instanceId });

        res.json({
            success: true,
            instanceId
        });
    });

    /**
     * Get action configure page
     * GET /eloqua/action/configure
     */
    static configure = asyncHandler(async (req, res) => {
        const { installId, siteId, instanceId } = req.query;

        logger.info('Loading action configuration page', { installId, instanceId });

        const consumer = await Consumer.findOne({ installId });
        if (!consumer) {
            return res.status(404).send('Consumer not found');
        }

        // Store in session
        req.session.installId = installId;
        req.session.siteId = siteId;

        let instance = await ActionInstance.findOne({ instanceId });
        
        if (!instance) {
            instance = {
                instanceId,
                installId,
                SiteId: siteId,
                message_expiry: 'NO',
                message_validity: 1,
                send_mode: 'all',
                requiresConfiguration: true
            };
        }

        // Get countries data
        const countries = require('../data/countries.json');

        // Get sender IDs
        let sender_ids = {
            'Virtual Number': [],
            'Business Name': [],
            'Mobile Number': []
        };

        if (consumer.transmitsms_api_key && consumer.transmitsms_api_secret) {
            try {
                const transmitSmsService = new TransmitSmsService(
                    consumer.transmitsms_api_key,
                    consumer.transmitsms_api_secret
                );
                
                sender_ids = await transmitSmsService.getSenderIds();
            } catch (error) {
                logger.warn('Could not fetch sender IDs', { error: error.message });
            }
        }

        // Get custom objects
        let custom_objects = { elements: [] };
        try {
            const eloquaService = new EloquaService(installId, siteId);
            custom_objects = await eloquaService.getCustomObjects('', 100);
        } catch (error) {
            logger.warn('Could not fetch custom objects', { error: error.message });
        }

        // Get contact fields for merge
        let merge_fields = [];
        try {
            const eloquaService = new EloquaService(installId, siteId);
            const contactFieldsResponse = await eloquaService.getContactFields(200);
            logger.info('contactFieldsResponse', contactFieldsResponse);
            merge_fields = contactFieldsResponse.items || [];
        } catch (error) {
            logger.warn('Could not fetch contact fields', { error: error.message });
        }

        res.render('action-config', {
            consumer: consumer.toObject(),
            instance,
            custom_objects,
            countries,
            sender_ids,
            merge_fields
        });
    });

    /**
     * Save configuration and update Eloqua instance
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

        // Check if configuration is complete
        const isConfigured = ActionController.validateConfiguration(instance);
        instance.requiresConfiguration = !isConfigured;

        await instance.save();

        logger.info('Action configuration saved', { 
            instanceId,
            requiresConfiguration: instance.requiresConfiguration
        });

        // Update Eloqua instance with recordDefinition
        try {
            await ActionController.updateEloquaInstance(instance);
            
            logger.info('Eloqua instance updated successfully', { instanceId });

            res.json({
                success: true,
                message: 'Configuration saved successfully',
                requiresConfiguration: instance.requiresConfiguration
            });

        } catch (error) {
            logger.error('Failed to update Eloqua instance', {
                instanceId,
                error: error.message
            });

            // Still return success for local save, but warn about Eloqua update
            res.json({
                success: true,
                message: 'Configuration saved locally, but failed to update Eloqua',
                warning: error.message,
                requiresConfiguration: instance.requiresConfiguration
            });
        }
    });

    /**
     * Validate if configuration is complete
     */
    static validateConfiguration(instance) {
        // Check required fields
        if (!instance.message || !instance.message.trim()) {
            return false;
        }

        if (!instance.recipient_field) {
            return false;
        }

        // If custom object is configured, check required mappings
        if (instance.custom_object_id) {
            if (!instance.email_field || !instance.mobile_field) {
                return false;
            }
        }

        return true;
    }

    /**
     * Update Eloqua instance with recordDefinition
     */
    static async updateEloquaInstance(instance) {
        let eloquaService;
        
        try {
            logger.info('Creating Eloqua service for instance update', {
                instanceId: instance.instanceId,
                installId: instance.installId,
                SiteId: instance.SiteId
            });

            eloquaService = new EloquaService(instance.installId, instance.SiteId);
            
            // Explicitly initialize the service
            await eloquaService.initialize();

            logger.info('Eloqua service initialized, building recordDefinition', {
                instanceId: instance.instanceId
            });

            // Build recordDefinition based on configuration
            const recordDefinition = await ActionController.buildRecordDefinition(instance, eloquaService);

            // Prepare update payload
            const updatePayload = {
                recordDefinition: recordDefinition,
                requiresConfiguration: instance.requiresConfiguration
            };

            logger.info('Updating Eloqua instance with payload', {
                instanceId: instance.instanceId,
                recordDefinition,
                requiresConfiguration: instance.requiresConfiguration
            });

            // Call Eloqua API to update instance
            await eloquaService.updateActionInstance(instance.instanceId, updatePayload);

            logger.info('Eloqua instance updated successfully', {
                instanceId: instance.instanceId
            });

        } catch (error) {
            logger.error('Error updating Eloqua instance', {
                instanceId: instance.instanceId,
                error: error.message,
                stack: error.stack,
                installId: instance.installId,
                siteId: instance.SiteId
            });
            throw error;
        }
    }

    /**
     * Build recordDefinition object for Eloqua
     */
    static async buildRecordDefinition(instance, eloquaService = null) {
        const recordDefinition = {};

        // Always include contact basic fields
        recordDefinition.ContactID = instance.recipient_field || 'ContactID';
        recordDefinition.EmailAddress = 'EmailAddress';

        // Add custom object fields if configured
        if (instance.custom_object_id) {
            if (!eloquaService) {
                eloquaService = new EloquaService(instance.installId, instance.SiteId);
                await eloquaService.initialize();
            }
            
            try {
                // Get custom object details to get field names
                const customObject = await eloquaService.getCustomObject(instance.custom_object_id);
                
                logger.debug('Custom object fetched for recordDefinition', {
                    customObjectId: instance.custom_object_id,
                    name: customObject.name,
                    fieldCount: customObject.fields?.length || 0
                });

                // Map configured fields
                if (instance.mobile_field) {
                    const field = customObject.fields.find(f => f.internalName === instance.mobile_field);
                    recordDefinition[field?.name || 'Mobile'] = instance.mobile_field;
                }

                if (instance.email_field) {
                    const field = customObject.fields.find(f => f.internalName === instance.email_field);
                    recordDefinition[field?.name || 'Email'] = instance.email_field;
                }

                if (instance.title_field) {
                    const field = customObject.fields.find(f => f.internalName === instance.title_field);
                    recordDefinition[field?.name || 'Title'] = instance.title_field;
                }

                if (instance.notification_field) {
                    const field = customObject.fields.find(f => f.internalName === instance.notification_field);
                    recordDefinition[field?.name || 'Notification'] = instance.notification_field;
                }

                if (instance.outgoing_field) {
                    const field = customObject.fields.find(f => f.internalName === instance.outgoing_field);
                    recordDefinition[field?.name || 'Message'] = instance.outgoing_field;
                }

                if (instance.vn_field) {
                    const field = customObject.fields.find(f => f.internalName === instance.vn_field);
                    recordDefinition[field?.name || 'VirtualNumber'] = instance.vn_field;
                }

            } catch (error) {
                logger.warn('Could not fetch custom object for recordDefinition', {
                    customObjectId: instance.custom_object_id,
                    error: error.message
                });

                // Fallback to internal names
                if (instance.mobile_field) recordDefinition.Mobile = instance.mobile_field;
                if (instance.email_field) recordDefinition.Email = instance.email_field;
                if (instance.title_field) recordDefinition.Title = instance.title_field;
                if (instance.notification_field) recordDefinition.Notification = instance.notification_field;
                if (instance.outgoing_field) recordDefinition.Message = instance.outgoing_field;
                if (instance.vn_field) recordDefinition.VirtualNumber = instance.vn_field;
            }
        }

        // Add country field if configured
        if (instance.country_field) {
            recordDefinition.Country = instance.country_field;
        }

        logger.debug('Built recordDefinition', {
            instanceId: instance.instanceId,
            recordDefinition
        });

        return recordDefinition;
    }


    /**
     * Notify (Execute action) - Queue SMS jobs
     * POST /eloqua/action/notify
     */
    static notify = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;
        const executionData = req.body;

        logger.info('Action notify received', { 
            instanceId, 
            recordCount: executionData.items?.length || 0 
        });

        logger.info('Action notify content', executionData);

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

        // Queue SMS jobs instead of sending immediately
        const results = await ActionController.queueSmsJobs(
            instance, 
            consumer, 
            executionData
        );

        logger.info('Action notify completed - jobs queued', { 
            instanceId, 
            queuedCount: results.filter(r => r.success).length,
            failCount: results.filter(r => !r.success).length
        });

        res.json({
            success: true,
            message: 'SMS jobs queued for processing',
            results
        });
    });

    /**
     * Queue SMS jobs for background processing
     */
    static async queueSmsJobs(instance, consumer, executionData) {
        const results = [];
        const records = executionData.items || [];

        const baseUrl = process.env.APP_BASE_URL || 'https://eloqua-integrator.onrender.com';

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

                // Get country for formatting
                let country = consumer.default_country || 'Australia';
                if (instance.country_field) {
                    const countryValue = ActionController.getFieldValue(record, instance.country_field);
                    if (countryValue) {
                        country = countryValue;
                    }
                }

                // Format phone number
                const formattedNumber = formatPhoneNumber(mobileNumber, country);

                // Process message with merge fields
                let message = replaceMergeFields(instance.message, record);

                // Clean up message
                message = message.replace(/\n\n+/g, '\n\n').trim();

                // Build callback URLs with tracking parameters
                const callbackParams = new URLSearchParams({
                    installId: instance.installId,
                    instanceId: instance.instanceId,
                    contactId: record.contactId,
                    emailAddress: record.emailAddress || '',
                    campaignId: instance.assetId || ''
                }).toString();

                // Build SMS options
                const smsOptions = {
                    from: instance.caller_id || undefined
                };

                if (instance.message_expiry === 'YES') {
                    smsOptions.validity = parseInt(instance.message_validity) * 60;
                }

                // Add tracked link URL if message contains [tracked-link]
                if (message.includes('[tracked-link]') && instance.tracked_link) {
                    smsOptions.tracked_link_url = instance.tracked_link;
                }

                // Add callback URLs
                if (consumer.dlr_callback) {
                    smsOptions.dlr_callback = `${baseUrl}/webhooks/dlr?${callbackParams}`;
                }

                if (consumer.reply_callback) {
                    smsOptions.reply_callback = `${baseUrl}/webhooks/reply?${callbackParams}`;
                }

                if (consumer.link_hits_callback) {
                    smsOptions.link_hits_callback = `${baseUrl}/webhooks/linkhit?${callbackParams}`;
                }

                // Prepare custom object data
                const customObjectData = instance.custom_object_id ? {
                    customObjectId: instance.custom_object_id,
                    fieldMappings: {
                        mobile_field: instance.mobile_field,
                        email_field: instance.email_field,
                        title_field: instance.title_field,
                        notification_field: instance.notification_field,
                        outgoing_field: instance.outgoing_field,
                        vn_field: instance.vn_field
                    },
                    recordData: record
                } : null;

                // Create SMS job
                const jobId = generateId();
                const smsJob = new SmsJob({
                    jobId,
                    installId: instance.installId,
                    instanceId: instance.instanceId,
                    contactId: record.contactId,
                    emailAddress: record.emailAddress || '',
                    mobileNumber: formattedNumber,
                    message,
                    senderId: instance.caller_id,
                    campaignId: instance.assetId,
                    campaignTitle: instance.assetName,
                    assetName: instance.assetName,
                    smsOptions,
                    customObjectData,
                    status: 'pending',
                    scheduledAt: new Date()
                });

                await smsJob.save();

                results.push({
                    contactId: record.contactId,
                    success: true,
                    jobId: jobId,
                    message: 'SMS job queued'
                });

                logger.info('SMS job queued', {
                    jobId,
                    contactId: record.contactId,
                    to: formattedNumber
                });

            } catch (error) {
                logger.error('Error queuing SMS job', {
                    instanceId: instance.instanceId,
                    contactId: record.contactId,
                    error: error.message
                });

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
     * Process a single SMS job (called by worker)
     */
    static async processSmsJob(job) {
        try {
            // Mark as processing
            await job.markAsProcessing();

            logger.info('Processing SMS job', {
                jobId: job.jobId,
                contactId: job.contactId,
                to: job.mobileNumber
            });

            // Get consumer credentials
            const consumer = await Consumer.findOne({ installId: job.installId })
                .select('+transmitsms_api_key +transmitsms_api_secret');

            if (!consumer || !consumer.transmitsms_api_key) {
                throw new Error('Consumer credentials not found');
            }

            const smsService = new TransmitSmsService(
                consumer.transmitsms_api_key,
                consumer.transmitsms_api_secret
            );

            // Send SMS
            const smsResponse = await smsService.sendSms(
                job.mobileNumber,
                job.message,
                job.smsOptions
            );

            // Mark job as sent
            await job.markAsSent(smsResponse.message_id, smsResponse);

            // Create SMS log
            const smsLog = new SmsLog({
                installId: job.installId,
                instanceId: job.instanceId,
                contactId: job.contactId,
                emailAddress: job.emailAddress,
                mobileNumber: job.mobileNumber,
                message: job.message,
                messageId: smsResponse.message_id,
                senderId: job.senderId,
                campaignTitle: job.campaignTitle,
                status: 'sent',
                transmitSmsResponse: smsResponse,
                sentAt: new Date(),
                trackedLink: smsResponse.tracked_link ? {
                    shortUrl: smsResponse.tracked_link.short_url,
                    originalUrl: smsResponse.tracked_link.original_url
                } : undefined
            });

            await smsLog.save();

            // Link smsLog to job
            job.smsLogId = smsLog._id;
            await job.save();

            // Update custom object if configured
            if (job.customObjectData && job.customObjectData.customObjectId) {
                const instance = await ActionInstance.findOne({ instanceId: job.instanceId });
                if (instance) {
                    const eloquaService = new EloquaService(job.installId, instance.SiteId);
                    await ActionController.updateCustomObjectForJob(
                        eloquaService,
                        job,
                        smsLog
                    );
                }
            }

            // Update instance stats
            const instance = await ActionInstance.findOne({ instanceId: job.instanceId });
            if (instance) {
                await instance.incrementSent();
            }

            logger.sms('sent', {
                jobId: job.jobId,
                messageId: smsResponse.message_id,
                to: job.mobileNumber
            });

            return {
                success: true,
                jobId: job.jobId,
                messageId: smsResponse.message_id
            };

        } catch (error) {
            logger.error('Error processing SMS job', {
                jobId: job.jobId,
                error: error.message,
                stack: error.stack
            });

            // Mark as failed
            await job.markAsFailed(error.message, error.code);

            // Update instance stats
            const instance = await ActionInstance.findOne({ instanceId: job.instanceId });
            if (instance) {
                await instance.incrementFailed();
            }

            // Check if can retry
            if (job.canRetry()) {
                logger.info('SMS job will be retried', {
                    jobId: job.jobId,
                    retryCount: job.retryCount,
                    maxRetries: job.maxRetries
                });

                // Reset for retry (will be picked up again by worker)
                await job.resetForRetry();
            } else {
                logger.error('SMS job failed after max retries', {
                    jobId: job.jobId,
                    retryCount: job.retryCount
                });
            }

            return {
                success: false,
                jobId: job.jobId,
                error: error.message
            };
        }
    }

    /**
     * Update custom object after SMS sent
     */
    static async updateCustomObjectForJob(eloquaService, job, smsLog) {
        try {
            const cdoData = {
                fieldValues: []
            };

            const { customObjectId, fieldMappings } = job.customObjectData;

            if (fieldMappings.mobile_field) {
                cdoData.fieldValues.push({
                    id: fieldMappings.mobile_field,
                    value: smsLog.mobileNumber
                });
            }

            if (fieldMappings.email_field) {
                cdoData.fieldValues.push({
                    id: fieldMappings.email_field,
                    value: smsLog.emailAddress
                });
            }

            if (fieldMappings.outgoing_field) {
                cdoData.fieldValues.push({
                    id: fieldMappings.outgoing_field,
                    value: smsLog.message
                });
            }

            if (fieldMappings.notification_field) {
                cdoData.fieldValues.push({
                    id: fieldMappings.notification_field,
                    value: 'sent'
                });
            }

            if (fieldMappings.vn_field && smsLog.senderId) {
                cdoData.fieldValues.push({
                    id: fieldMappings.vn_field,
                    value: smsLog.senderId
                });
            }

            if (fieldMappings.title_field) {
                cdoData.fieldValues.push({
                    id: fieldMappings.title_field,
                    value: smsLog.campaignTitle || ''
                });
            }

            await eloquaService.createCustomObjectRecord(customObjectId, cdoData);

            logger.debug('Custom object updated for job', {
                jobId: job.jobId,
                customObjectId
            });

        } catch (error) {
            logger.error('Error updating custom object for job', {
                jobId: job.jobId,
                error: error.message
            });
        }
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
            updatedAt: undefined,
            requiresConfiguration: true // New copy requires configuration
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

        logger.info('Test SMS request', { 
            installId, 
            country, 
            phone,
            hasMessage: !!message,
            messageLength: message?.length || 0,
            hasTrackedLinkPlaceholder: message?.includes('[tracked-link]') || false,
            trackedLinkUrl: tracked_link_url
        });

        // Validate inputs
        if (!message || !message.trim()) {
            return res.status(400).json({ 
                error: 'Message is required',
                description: 'Message field cannot be empty' 
            });
        }

        if (!phone || !phone.trim()) {
            return res.status(400).json({ 
                error: 'Phone number is required',
                description: 'Phone number field cannot be empty' 
            });
        }

        const consumer = await Consumer.findOne({ installId })
            .select('+transmitsms_api_key +transmitsms_api_secret');

        if (!consumer) {
            return res.status(404).json({ 
                error: 'Consumer not found',
                description: 'Consumer not found' 
            });
        }

        if (!consumer.transmitsms_api_key || !consumer.transmitsms_api_secret) {
            return res.status(400).json({ 
                error: 'Not configured',
                description: 'TransmitSMS API credentials not configured. Please configure them first.' 
            });
        }

        try {
            const smsService = new TransmitSmsService(
                consumer.transmitsms_api_key,
                consumer.transmitsms_api_secret
            );

            // Format phone number
            const formattedNumber = formatPhoneNumber(phone, country);
            
            logger.info('Formatted phone number for test', { 
                original: phone, 
                formatted: formattedNumber,
                country 
            });

            // Prepare message
            let finalMessage = message.trim();
            finalMessage = finalMessage.replace(/\n\n+/g, '\n\n');

            if (!finalMessage) {
                return res.status(400).json({ 
                    error: 'Message is empty after processing',
                    description: 'Message cannot be empty' 
                });
            }

            logger.info('Sending test SMS', { 
                to: formattedNumber,
                messageLength: finalMessage.length,
                from: caller_id || 'default',
                hasTrackedLinkPlaceholder: finalMessage.includes('[tracked-link]'),
                trackedLinkUrl: tracked_link_url
            });

            // Build callback URLs with tracking parameters
            const baseUrl = process.env.APP_BASE_URL || 'https://eloqua-integrator.onrender.com';
            
            const callbackParams = new URLSearchParams({
                installId: installId,
                test: 'true',
                phone: formattedNumber
            }).toString();

            // Prepare SMS options
            const smsOptions = {};
            
            if (caller_id) {
                smsOptions.from = caller_id;
            }

            // Add tracked link URL if message contains [tracked-link]
            if (finalMessage.includes('[tracked-link]') && tracked_link_url) {
                smsOptions.tracked_link_url = tracked_link_url;
            }

            // Add callback URLs for test
            if (consumer.dlr_callback) {
                smsOptions.dlr_callback = `${baseUrl}/webhooks/dlr?${callbackParams}`;
            }

            if (consumer.reply_callback) {
                smsOptions.reply_callback = `${baseUrl}/webhooks/reply?${callbackParams}`;
            }

            if (consumer.link_hits_callback) {
                smsOptions.link_hits_callback = `${baseUrl}/webhooks/linkhit?${callbackParams}`;
            }

            logger.info('SMS options with callbacks', {
                hasCallbacks: !!(smsOptions.dlr_callback || smsOptions.reply_callback || smsOptions.link_hits_callback),
                dlr: !!smsOptions.dlr_callback,
                reply: !!smsOptions.reply_callback,
                linkHits: !!smsOptions.link_hits_callback
            });

            // Send SMS
            const response = await smsService.sendSms(
                formattedNumber,
                finalMessage,
                smsOptions
            );

            logger.sms('test_sent', { 
                to: formattedNumber,
                messageId: response.message_id
            });

            res.json({
                success: true,
                message: 'Test SMS sent successfully',
                messageId: response.message_id,
                to: formattedNumber,
                messageLength: finalMessage.length,
                callbacks: {
                    dlr: smsOptions.dlr_callback,
                    reply: smsOptions.reply_callback,
                    linkHits: smsOptions.link_hits_callback
                },
                response
            });

        } catch (error) {
            logger.error('Error sending test SMS', {
                error: error.message,
                stack: error.stack,
                phone,
                country
            });

            res.status(500).json({
                error: 'Failed to send test SMS',
                description: error.message
            });
        }
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

    /**
     * Get contact fields (AJAX)
     * GET /eloqua/action/ajax/contactfields/:installId/:siteId
     */
    static getContactFields = asyncHandler(async (req, res) => {
        const { installId, siteId } = req.params;

        logger.debug('AJAX: Fetching contact fields', { installId });

        const eloquaService = new EloquaService(installId, siteId);
        
        try {
            const contactFields = await eloquaService.getContactFields(1000);

            logger.debug('Contact fields fetched', { 
                count: contactFields.items?.length || 0 
            });

            res.json(contactFields);
        } catch (error) {
            logger.error('Error fetching contact fields', {
                installId,
                error: error.message
            });

            res.status(500).json({
                error: 'Failed to fetch contact fields',
                message: error.message,
                elements: []
            });
        }
    });

    /**
     * Get SMS Worker Status
     * GET /eloqua/action/worker/status
     */
    static getWorkerStatus = asyncHandler(async (req, res) => {
        const { installId } = req.query;

        // Get stats for this install
        const stats = await SmsJob.aggregate([
            { $match: { installId } },
            {
                $group: {
                    _id: '$status',
                    count: { $sum: 1 }
                }
            }
        ]);

        const statsMap = {
            pending: 0,
            processing: 0,
            sent: 0,
            failed: 0,
            cancelled: 0
        };

        stats.forEach(stat => {
            statsMap[stat._id] = stat.count;
        });

        // Get recent jobs
        const recentJobs = await SmsJob.find({ installId })
            .sort({ createdAt: -1 })
            .limit(10)
            .select('jobId status contactId mobileNumber errorMessage createdAt sentAt');

        res.json({
            success: true,
            stats: statsMap,
            recentJobs
        });
    });
}

module.exports = ActionController;