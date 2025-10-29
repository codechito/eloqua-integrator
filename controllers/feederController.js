const FeederInstance = require('../models/FeederInstance');
const Consumer = require('../models/Consumer');
const SmsReply = require('../models/SmsReply');
const LinkHit = require('../models/LinkHit');
const { logger, generateId } = require('../utils');
const { asyncHandler } = require('../middleware');
const { TransmitSmsService, EloquaService } = require('../services');

class FeederController {
    /**
     * Create feeder instance
     * GET /eloqua/feeder/create
     */
    static create = asyncHandler(async (req, res) => {
        const { installId, siteId, assetId } = req.query;
        const instanceId = generateId();

        // Determine feeder type from query param
        const feederType = req.query.feederType || 'incoming_sms';

        logger.info('Creating feeder instance', { 
            installId, 
            instanceId,
            feederType 
        });

        const instance = new FeederInstance({
            instanceId,
            installId,
            SiteId: siteId,
            assetId,
            feederType,
            senderIds: [],
            fieldMappings: {}
        });

        await instance.save();

        logger.info('Feeder instance created', { instanceId, feederType });

        res.json({
            success: true,
            instanceId
        });
    });

    /**
     * Get feeder configuration page
     * GET /eloqua/feeder/configure
     */
    static configure = asyncHandler(async (req, res) => {
        const { installId, siteId, instanceId } = req.query;

        logger.info('Loading feeder configuration page', { installId, instanceId });

        const consumer = await Consumer.findOne({ installId });
        if (!consumer) {
            return res.status(404).send('Consumer not found');
        }

        // Store in session
        req.session.installId = installId;
        req.session.siteId = siteId;

        let instance = await FeederInstance.findOne({ instanceId });
        
        if (!instance) {
            // Create default instance
            instance = {
                instanceId,
                installId,
                SiteId: siteId,
                feederType: req.query.feederType || 'incoming_sms',
                senderIds: [],
                fieldMappings: {}
            };
        }

        // Get sender IDs for incoming SMS feeder
        let sender_ids = {
            'Virtual Number': [],
            'Business Name': [],
            'Mobile Number': []
        };

        if (instance.feederType === 'incoming_sms' && 
            consumer.transmitsms_api_key && 
            consumer.transmitsms_api_secret) {
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

        // Render appropriate view based on feeder type
        const viewName = instance.feederType === 'incoming_sms' 
            ? 'feeder-incoming-sms' 
            : 'feeder-link-hits';

        res.render(viewName, {
            consumer: consumer.toObject(),
            instance,
            sender_ids,
            custom_objects
        });
    });

    /**
     * Save feeder configuration
     * POST /eloqua/feeder/configure
     */
    static saveConfiguration = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;
        const { instance: instanceData } = req.body;

        logger.info('Saving feeder configuration', { instanceId, feederType: instanceData.feederType });

        let instance = await FeederInstance.findOne({ instanceId });
        
        if (!instance) {
            instance = new FeederInstance({ 
                instanceId, 
                ...instanceData 
            });
        } else {
            Object.assign(instance, instanceData);
        }

        await instance.save();

        // If incoming SMS feeder, configure forward URLs for sender IDs
        if (instance.feederType === 'incoming_sms' && 
            instance.senderIds && 
            instance.senderIds.length > 0) {
            
            await FeederController.configureForwardUrls(instance);
        }

        logger.info('Feeder configuration saved', { instanceId });

        res.json({
            success: true,
            message: 'Configuration saved successfully'
        });
    });

    /**
     * Configure forward URLs for sender IDs in TransmitSMS
     */
    static async configureForwardUrls(instance) {
        try {
            const consumer = await Consumer.findOne({ installId: instance.installId })
                .select('+transmitsms_api_key +transmitsms_api_secret');

            if (!consumer || !consumer.transmitsms_api_key) {
                logger.warn('Cannot configure forward URLs - no TransmitSMS credentials');
                return;
            }

            const transmitSmsService = new TransmitSmsService(
                consumer.transmitsms_api_key,
                consumer.transmitsms_api_secret
            );

            const baseUrl = process.env.APP_BASE_URL || 'https://eloqua-integrator.onrender.com';
            const forwardUrl = `${baseUrl}/eloqua/feeder/incomingsms?instanceId=${instance.instanceId}&installId=${instance.installId}`;

            for (const senderId of instance.senderIds) {
                try {
                    await transmitSmsService.configureNumberForwarding(senderId, forwardUrl);
                    
                    logger.info('Configured forward URL for sender ID', {
                        senderId,
                        forwardUrl
                    });
                } catch (error) {
                    logger.error('Error configuring forward URL', {
                        senderId,
                        error: error.message
                    });
                }
            }
        } catch (error) {
            logger.error('Error in configureForwardUrls', {
                error: error.message,
                instanceId: instance.instanceId
            });
        }
    }

    /**
     * Notify - Get feeder data
     * POST /eloqua/feeder/notify
     */
    static notify = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;
        const { maxRows = 100, offset = 0 } = req.body;

        logger.info('Feeder notify called', { instanceId, maxRows, offset });

        const instance = await FeederInstance.findOne({ instanceId });
        if (!instance) {
            return res.status(404).json({ error: 'Instance not found' });
        }

        let records = [];

        if (instance.feederType === 'incoming_sms') {
            records = await FeederController.getIncomingSmsRecords(instance, maxRows, offset);
        } else if (instance.feederType === 'link_hits') {
            records = await FeederController.getLinkHitsRecords(instance, maxRows, offset);
        }

        // Update stats
        if (records.length > 0) {
            await instance.incrementRecordsSent(records.length);
        }

        logger.info('Feeder notify complete', {
            instanceId,
            recordCount: records.length
        });

        res.json({
            success: true,
            count: records.length,
            items: records
        });
    });

    /**
     * Get incoming SMS records
     */
    static async getIncomingSmsRecords(instance, maxRows, offset) {
        try {
            const query = {
                installId: instance.installId,
                processed: { $ne: true }
            };

            // Filter by sender IDs if configured
            if (instance.senderIds && instance.senderIds.length > 0) {
                query.toNumber = { $in: instance.senderIds };
            }

            // Filter by keyword if configured
            if (instance.textType === 'Keyword' && instance.keyword) {
                query.message = { $regex: instance.keyword, $options: 'i' };
            }

            const replies = await SmsReply.find(query)
                .sort({ receivedAt: 1 })
                .skip(offset)
                .limit(maxRows);

            const records = [];

            for (const reply of replies) {
                const record = {};

                // Map fields based on configuration
                if (instance.fieldMappings.mobile) {
                    record[instance.fieldMappings.mobile] = reply.fromNumber;
                }
                if (instance.fieldMappings.email) {
                    record[instance.fieldMappings.email] = reply.emailAddress || '';
                }
                if (instance.fieldMappings.message) {
                    record[instance.fieldMappings.message] = reply.message;
                }
                if (instance.fieldMappings.timestamp) {
                    record[instance.fieldMappings.timestamp] = reply.receivedAt.toISOString();
                }
                if (instance.fieldMappings.messageId) {
                    record[instance.fieldMappings.messageId] = reply.messageId || reply.responseId;
                }
                if (instance.fieldMappings.senderId) {
                    record[instance.fieldMappings.senderId] = reply.toNumber;
                }

                // Mark as processed
                reply.processed = true;
                await reply.save();

                records.push(record);
            }

            return records;
        } catch (error) {
            logger.error('Error getting incoming SMS records', {
                error: error.message,
                instanceId: instance.instanceId
            });
            return [];
        }
    }

    /**
     * Get link hits records
     */
    static async getLinkHitsRecords(instance, maxRows, offset) {
        try {
            const query = {
                installId: instance.installId,
                processed: { $ne: true }
            };

            const linkHits = await LinkHit.find(query)
                .sort({ clickedAt: 1 })
                .skip(offset)
                .limit(maxRows);

            const records = [];

            for (const hit of linkHits) {
                const record = {};

                // Map fields based on configuration
                if (instance.fieldMappings.mobile) {
                    record[instance.fieldMappings.mobile] = hit.mobileNumber;
                }
                if (instance.fieldMappings.url) {
                    record[instance.fieldMappings.url] = hit.shortUrl;
                }
                if (instance.fieldMappings.originalUrl) {
                    record[instance.fieldMappings.originalUrl] = hit.originalUrl;
                }
                if (instance.fieldMappings.timestamp) {
                    record[instance.fieldMappings.timestamp] = hit.clickedAt.toISOString();
                }
                if (instance.fieldMappings.linkHits) {
                    record[instance.fieldMappings.linkHits] = 1; // Each record is one hit
                }
                if (instance.fieldMappings.email) {
                    record[instance.fieldMappings.email] = hit.emailAddress || '';
                }

                // Mark as processed
                hit.processed = true;
                await hit.save();

                records.push(record);
            }

            return records;
        } catch (error) {
            logger.error('Error getting link hits records', {
                error: error.message,
                instanceId: instance.instanceId
            });
            return [];
        }
    }

    /**
     * Handle incoming SMS webhook (for feeder)
     * GET/POST /eloqua/feeder/incomingsms
     */
    static handleIncomingSms = asyncHandler(async (req, res) => {
        const data = { ...req.query, ...req.body };
        const { instanceId, installId } = req.query;

        logger.webhook('incoming_sms_feeder', {
            instanceId,
            from: data.mobile,
            message: data.response
        });

        try {
            // Find the instance to get contact info if available
            let contactId = null;
            let emailAddress = '';

            if (instanceId) {
                const instance = await FeederInstance.findOne({ instanceId });
                if (instance && instance.customObjectId) {
                    // Try to find linked SMS log
                    const smsLog = await require('../models/SmsLog').findOne({
                        installId: installId || data.installId || instance.installId,
                        mobileNumber: data.mobile
                    }).sort({ sentAt: -1 }).limit(1);

                    if (smsLog) {
                        contactId = smsLog.contactId;
                        emailAddress = smsLog.emailAddress;
                    }
                }
            }

            // Create SMS reply record
            const smsReply = new SmsReply({
                installId: installId || data.installId,
                contactId: contactId,
                emailAddress: emailAddress,
                fromNumber: data.mobile,
                toNumber: data.longcode,
                message: data.response,
                messageId: data.message_id,
                responseId: data.response_id,
                receivedAt: data.datetime_entry ? new Date(data.datetime_entry) : new Date(),
                isOptOut: data.is_optout === 'yes',
                webhookData: data,
                processed: false // Will be picked up by feeder
            });

            await smsReply.save();

            logger.info('Incoming SMS saved for feeder', {
                replyId: smsReply._id,
                instanceId
            });

            res.json({ 
                success: true,
                message: 'SMS received'
            });
        } catch (error) {
            logger.error('Error handling incoming SMS for feeder', {
                error: error.message,
                data
            });
            
            res.json({ 
                success: false,
                error: error.message
            });
        }
    });

    /**
     * Copy instance
     * POST /eloqua/feeder/copy
     */
    static copy = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;
        const newInstanceId = generateId();

        logger.info('Copying feeder instance', { instanceId, newInstanceId });

        const instance = await FeederInstance.findOne({ instanceId });
        if (!instance) {
            return res.status(404).json({ error: 'Instance not found' });
        }

        const newInstance = new FeederInstance({
            ...instance.toObject(),
            _id: undefined,
            instanceId: newInstanceId,
            totalRecordsSent: 0,
            lastPolledAt: undefined,
            createdAt: undefined,
            updatedAt: undefined
        });

        await newInstance.save();

        logger.info('Feeder instance copied', { newInstanceId });

        res.json({
            success: true,
            instanceId: newInstanceId
        });
    });

    /**
     * Delete instance
     * POST /eloqua/feeder/delete
     */
    static delete = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;

        logger.info('Deleting feeder instance', { instanceId });

        await FeederInstance.findOneAndUpdate(
            { instanceId },
            { isActive: false }
        );

        logger.info('Feeder instance deleted', { instanceId });

        res.json({
            success: true,
            message: 'Instance deleted successfully'
        });
    });
}

module.exports = FeederController;