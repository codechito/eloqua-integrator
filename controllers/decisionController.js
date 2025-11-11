const Consumer = require('../models/Consumer');
const DecisionInstance = require('../models/DecisionInstance');
const SmsLog = require('../models/SmsLog');
const SmsReply = require('../models/SmsReply');
const EloquaService = require('../services/eloquaService');
const logger = require('../utils/logger');
const { generateId } = require('../utils/helpers');
const asyncHandler = require('../middleware/asyncHandler');

class DecisionController {

    /**
     * Create decision instance
     * GET /eloqua/decision/create
     */
    static create = asyncHandler(async (req, res) => {
        const { installId, siteId, assetId, assetName, assetType } = req.query;
        const instanceId = generateId();

        logger.info('Creating decision instance', { 
            installId, 
            instanceId,
            assetType 
        });

        const instance = new DecisionInstance({
            instanceId,
            installId,
            SiteId: siteId,
            assetId,
            evaluation_period: 1,
            text_type: 'Anything',
            requiresConfiguration: true
        });

        await instance.save();

        logger.info('Decision instance created', { instanceId });

        res.json({
            success: true,
            instanceId
        });
    });

    /**
     * Get decision configure page
     * GET /eloqua/decision/configure
     */
    static configure = asyncHandler(async (req, res) => {
        const { installId, siteId, instanceId, CustomObjectId, AssetType } = req.query;

        logger.info('Loading decision configuration page', { 
            installId, 
            instanceId,
            CustomObjectId,
            AssetType
        });

        const consumer = await Consumer.findOne({ installId });
        if (!consumer) {
            return res.status(404).send('Consumer not found');
        }

        req.session.installId = installId;
        req.session.siteId = siteId;

        let instance = await DecisionInstance.findOne({ instanceId });
        
        if (!instance) {
            instance = {
                instanceId,
                installId,
                SiteId: siteId,
                evaluation_period: 1,
                text_type: 'Anything',
                requiresConfiguration: true
            };
        }

        if (CustomObjectId) {
            instance.program_coid = CustomObjectId;
        }

        const hasCdoConfig = !!(consumer.actions?.receivesms?.custom_object_id);
        
        logger.info('Decision config page loaded', {
            instanceId,
            hasCdoConfig,
            customObjectId: consumer.actions?.receivesms?.custom_object_id
        });

        res.render('decision-config', {
            consumer: consumer.toObject(),
            instance
        });
    });

    /**
     * Save configuration
     * POST /eloqua/decision/configure
     */
    static saveConfiguration = asyncHandler(async (req, res) => {
        const { instanceId, installId, siteId } = req.query;
        const { instance: instanceData } = req.body;

        logger.info('Saving decision configuration', { 
            instanceId,
            installId,
            siteId,
            receivedData: instanceData
        });

        if (!instanceData.evaluation_period) {
            return res.status(400).json({
                success: false,
                message: 'Evaluation period is required'
            });
        }

        if (!instanceData.text_type) {
            return res.status(400).json({
                success: false,
                message: 'Text type is required'
            });
        }

        const validTextTypes = ['Anything', 'Keyword'];
        if (!validTextTypes.includes(instanceData.text_type)) {
            return res.status(400).json({
                success: false,
                message: `Invalid text_type. Must be one of: ${validTextTypes.join(', ')}`
            });
        }

        if (instanceData.text_type === 'Keyword' && (!instanceData.keyword || !instanceData.keyword.trim())) {
            return res.status(400).json({
                success: false,
                message: 'Keyword is required when Response Type is "Specific Keyword(s)"'
            });
        }

        let instance = await DecisionInstance.findOne({ instanceId });
        
        if (!instance) {
            logger.info('Creating new decision instance', { instanceId });
            instance = new DecisionInstance({ 
                instanceId, 
                installId: installId || instanceData.installId,
                SiteId: siteId || instanceData.SiteId
            });
        } else {
            logger.info('Updating existing decision instance', { instanceId });
        }

        instance.evaluation_period = parseInt(instanceData.evaluation_period);
        instance.text_type = String(instanceData.text_type);
        instance.keyword = instanceData.keyword ? String(instanceData.keyword).trim() : null;
        
        instance.configureAt = new Date();
        instance.requiresConfiguration = false;

        await instance.save();

        logger.info('Decision configuration saved', { 
            instanceId,
            evaluation_period: instance.evaluation_period,
            text_type: instance.text_type,
            keyword: instance.keyword,
            requiresConfiguration: false
        });

        try {
            await DecisionController.updateEloquaInstance(instance);
            
            logger.info('Eloqua decision instance updated successfully', { instanceId });

            res.json({
                success: true,
                message: 'Configuration saved successfully',
                requiresConfiguration: false
            });

        } catch (error) {
            logger.error('Failed to update Eloqua decision instance', {
                instanceId,
                error: error.message,
                stack: error.stack
            });

            res.json({
                success: true,
                message: 'Configuration saved locally, but failed to update Eloqua',
                warning: error.message,
                requiresConfiguration: false
            });
        }
    });

    /**
     * Update Eloqua decision instance with recordDefinition
     */
    static async updateEloquaInstance(instance) {
        try {
            logger.info('Updating Eloqua decision instance', {
                instanceId: instance.instanceId,
                installId: instance.installId,
                SiteId: instance.SiteId
            });

            const eloquaService = new EloquaService(instance.installId, instance.SiteId);
            await eloquaService.initialize();

            const recordDefinition = await DecisionController.buildRecordDefinition(instance);

            const updatePayload = {
                recordDefinition: recordDefinition,
                requiresConfiguration: false
            };

            logger.info('Updating Eloqua decision instance with recordDefinition', {
                instanceId: instance.instanceId,
                recordDefinition,
                requiresConfiguration: false
            });

            await eloquaService.updateDecisionInstance(instance.instanceId, updatePayload);

            logger.info('Eloqua decision instance updated successfully', {
                instanceId: instance.instanceId
            });

        } catch (error) {
            logger.error('Error updating Eloqua decision instance', {
                instanceId: instance.instanceId,
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Build recordDefinition for decision instance
     */
    static async buildRecordDefinition(instance) {
        const recordDefinition = {};

        logger.debug('Building recordDefinition for decision', {
            instanceId: instance.instanceId,
            hasProgramCDO: !!instance.program_coid
        });

        if (instance.program_coid) {
            recordDefinition.ContactID = "{{CustomObject.Contact.Id}}";
            recordDefinition.EmailAddress = "{{CustomObject.Contact.Field(C_EmailAddress)}}";
            recordDefinition.Id = "{{CustomObject.Id}}";
        } else {
            recordDefinition.ContactID = "{{Contact.Id}}";
            recordDefinition.EmailAddress = "{{Contact.Field(C_EmailAddress)}}";
        }

        logger.info('RecordDefinition built for decision', {
            instanceId: instance.instanceId,
            recordDefinition,
            fieldCount: Object.keys(recordDefinition).length
        });

        return recordDefinition;
    }

    /**
     * Retrieve instance configuration
     * GET /eloqua/decision/retrieve
     */
    static retrieve = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;

        logger.info('Retrieving decision instance configuration', { instanceId });

        const instance = await DecisionInstance.findOne({ instanceId });
        
        if (!instance) {
            return res.status(404).json({
                error: 'Instance not found'
            });
        }

        res.json({
            success: true,
            instance: instance.toObject()
        });
    });

    /**
     * Notify - Execute decision
     * POST /eloqua/decision/notify
     */
    static notify = asyncHandler(async (req, res) => {
        const instanceId = req.query.instanceId || req.params.instanceId;
        const installId = req.query.installId || req.params.installId;
        const assetId = req.query.AssetId || req.query.assetId || req.params.assetId;
        const executionId = req.query.ExecutionId || req.query.executionId || req.params.executionId;
        const siteId = req.query.siteId || req.query.SiteId || req.params.SiteId;
        
        logger.debug('Decision notify - Raw request data', {
            instanceId,
            executionId,
            headers: {
                contentType: req.headers['content-type'],
                contentLength: req.headers['content-length'],
                hasBody: !!req.body,
                bodyType: typeof req.body,
                bodyIsObject: typeof req.body === 'object',
                bodyIsArray: Array.isArray(req.body),
                bodyConstructor: req.body?.constructor?.name
            },
            body: {
                raw: JSON.stringify(req.body).substring(0, 500),
                keys: Object.keys(req.body || {}),
                hasItems: 'items' in (req.body || {}),
                itemsType: typeof req.body?.items,
                itemsIsArray: Array.isArray(req.body?.items),
                itemsLength: req.body?.items?.length
            }
        });

        let items = [];
        
        if (req.body && req.body.items && Array.isArray(req.body.items)) {
            items = req.body.items;
            logger.info('Items found via req.body.items', { count: items.length });
        } else if (Array.isArray(req.body)) {
            items = req.body;
            logger.info('Items found via req.body (direct array)', { count: items.length });
        } else if (typeof req.body === 'string') {
            try {
                const parsed = JSON.parse(req.body);
                if (Array.isArray(parsed)) {
                    items = parsed;
                    logger.info('Items found via JSON.parse(req.body) - direct array', { count: items.length });
                } else if (parsed.items && Array.isArray(parsed.items)) {
                    items = parsed.items;
                    logger.info('Items found via JSON.parse(req.body).items', { count: items.length });
                }
            } catch (e) {
                logger.error('Failed to parse req.body as JSON', { error: e.message });
            }
        } else {
            logger.warn('No items found in any format', {
                bodyExists: !!req.body,
                bodyType: typeof req.body,
                bodyKeys: Object.keys(req.body || {}),
                rawBodyPreview: JSON.stringify(req.body).substring(0, 200)
            });
        }

        const executionData = {
            items: items,
            hasMore: req.body?.hasMore || false
        };

        logger.info('Decision notify received', { 
            instanceId, 
            installId,
            assetId,
            executionId,
            siteId,
            recordCount: items.length,
            hasMore: executionData.hasMore,
            bodyKeys: Object.keys(req.body || {}),
            hasItems: !!req.body?.items,
            bodyIsArray: Array.isArray(req.body),
            itemsExtracted: items.length,
            firstItemSample: items[0] ? JSON.stringify(items[0]).substring(0, 200) : 'none'
        });

        res.status(204).send();

        DecisionController.processNotifyAsync(
            instanceId, 
            installId,
            siteId,
            assetId,
            executionId,
            executionData
        ).catch(error => {
            logger.error('Async decision notify failed', {
                instanceId,
                error: error.message,
                stack: error.stack
            });
        });
    });

    /**
     * Copy instance
     * POST /eloqua/decision/copy
     */
    static copy = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;
        const newInstanceId = generateId();

        logger.info('Copying decision instance', { 
            sourceInstanceId: instanceId,
            newInstanceId 
        });

        const instance = await DecisionInstance.findOne({ instanceId });
        if (!instance) {
            return res.status(404).json({ error: 'Instance not found' });
        }

        const newInstance = new DecisionInstance({
            ...instance.toObject(),
            _id: undefined,
            instanceId: newInstanceId,
            createdAt: undefined,
            updatedAt: undefined,
            requiresConfiguration: true
        });

        await newInstance.save();

        logger.info('Decision instance copied', { 
            sourceInstanceId: instanceId,
            newInstanceId 
        });

        res.json({
            success: true,
            instanceId: newInstanceId
        });
    });

    /**
     * Delete instance
     * POST /eloqua/decision/delete
     * POST /eloqua/decision/remove (alias)
     */
    static delete = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;

        logger.info('Deleting decision instance', { instanceId });

        const instance = await DecisionInstance.findOne({ instanceId });
        if (!instance) {
            return res.status(404).json({ error: 'Instance not found' });
        }

        instance.Status = 'removed';
        instance.RemoveAt = new Date();
        instance.isActive = false;
        await instance.save();

        logger.info('Decision instance deleted', { instanceId });

        res.json({
            success: true,
            message: 'Instance removed successfully'
        });
    });

    /**
     * Process notify asynchronously
     */
    static async processNotifyAsync(instanceId, installId, siteId, assetId, executionId, executionData) {
        try {
            logger.info('Starting async decision notify processing', {
                instanceId,
                installId,
                siteId,
                assetId,
                executionId,
                recordCount: executionData.items?.length || 0,
                hasMore: executionData.hasMore
            });

            if (!executionData.items || !Array.isArray(executionData.items)) {
                logger.warn('No items array in execution data', {
                    instanceId,
                    executionId,
                    executionDataKeys: Object.keys(executionData),
                    executionDataType: typeof executionData
                });
                return;
            }

            if (executionData.items.length === 0) {
                logger.warn('Empty items array in execution data', {
                    instanceId,
                    executionId
                });
                return;
            }

            const instance = await DecisionInstance.findOne({ 
                instanceId, 
                installId,
                isActive: true 
            });
            
            if (!instance) {
                logger.error('Decision instance not found', { 
                    instanceId,
                    installId 
                });
                return;
            }

            const consumer = await Consumer.findOne({ installId });
            if (!consumer) {
                logger.error('Consumer not found', { installId });
                return;
            }

            logger.info('Processing decision for SMS responses', {
                instanceId,
                evaluationPeriod: instance.evaluation_period,
                textType: instance.text_type,
                keyword: instance.keyword,
                itemsToProcess: executionData.items.length
            });

            const results = {
                yes: [],
                no: [],
                errors: []
            };

            for (const item of executionData.items) {
                try {
                    const contactId = item.ContactID || item.Id;
                    const emailAddress = item.EmailAddress || item.C_EmailAddress;

                    if (!contactId) {
                        logger.warn('Item missing ContactID', {
                            itemKeys: Object.keys(item)
                        });
                        continue;
                    }

                    logger.debug('Evaluating decision for contact', {
                        contactId,
                        emailAddress
                    });

                    const evaluationHours = instance.evaluation_period === -1 
                        ? 24 * 365
                        : instance.evaluation_period;

                    const cutoffDate = new Date(Date.now() - evaluationHours * 60 * 60 * 1000);

                    const smsLog = await SmsLog.findOne({
                        installId,
                        contactId: contactId,
                        status: { $in: ['sent', 'delivered'] },
                        sentAt: { $gte: cutoffDate },
                        messageId: { $exists: true, $ne: null }
                    }).sort({ sentAt: -1 });

                    if (!smsLog) {
                        logger.debug('No recent SMS found for contact', {
                            contactId,
                            cutoffDate
                        });
                        
                        results.no.push({
                            contactId,
                            emailAddress,
                            reason: 'no_sms_sent'
                        });
                        continue;
                    }

                    logger.debug('Found SMS to evaluate', {
                        contactId,
                        messageId: smsLog.messageId,
                        sentAt: smsLog.sentAt,
                        hasResponse: smsLog.hasResponse
                    });

                    smsLog.decisionInstanceId = instanceId;
                    smsLog.decisionStatus = smsLog.hasResponse ? 'yes' : 'pending';
                    smsLog.decisionDeadline = new Date(
                        smsLog.sentAt.getTime() + (evaluationHours * 60 * 60 * 1000)
                    );
                    await smsLog.save();

                    if (smsLog.hasResponse) {
                        const matches = DecisionController.evaluateReply(
                            smsLog.responseMessage,
                            instance.text_type,
                            instance.keyword
                        );

                        if (matches) {
                            logger.info('Contact already responded (matches)', {
                                contactId,
                                messageId: smsLog.messageId
                            });

                            results.yes.push({
                                contactId,
                                emailAddress,
                                messageId: smsLog.messageId,
                                responseMessage: smsLog.responseMessage
                            });
                        } else {
                            logger.info('Contact already responded (no match)', {
                                contactId,
                                messageId: smsLog.messageId
                            });

                            results.no.push({
                                contactId,
                                emailAddress,
                                messageId: smsLog.messageId,
                                reason: 'response_no_match'
                            });
                        }
                    } else {
                        logger.debug('Contact pending response', {
                            contactId,
                            messageId: smsLog.messageId,
                            deadline: smsLog.decisionDeadline
                        });

                        results.no.push({
                            contactId,
                            emailAddress,
                            messageId: smsLog.messageId,
                            reason: 'no_response_yet'
                        });
                    }

                } catch (error) {
                    logger.error('Error processing contact decision', {
                        contactId: item.ContactID,
                        error: error.message
                    });

                    results.errors.push({
                        contactId: item.ContactID,
                        error: error.message
                    });
                }
            }

            logger.info('Decision evaluation completed', {
                instanceId,
                yesCount: results.yes.length,
                noCount: results.no.length,
                errorCount: results.errors.length
            });

            await DecisionController.syncBulkDecisionResults(
                consumer,
                instance,
                results
            );

            logger.info('Decision results synced to Eloqua', {
                instanceId,
                executionId
            });

        } catch (error) {
            logger.error('Error in decision notify async processing', {
                instanceId,
                error: error.message,
                stack: error.stack
            });
        }
    }

    /**
     * Sync bulk decision results to Eloqua using Decision API
     */
    static async syncBulkDecisionResults(consumer, instance, results) {
        try {
            logger.info('Syncing bulk decision results', {
                instanceId: instance.instanceId,
                yesCount: results.yes.length,
                noCount: results.no.length
            });

            const eloquaService = new EloquaService(consumer.installId, instance.SiteId);
            await eloquaService.initialize();

            for (const contact of results.yes) {
                try {
                    await DecisionController.syncSingleDecisionResult(
                        instance,
                        eloquaService,
                        { contactId: contact.contactId, emailAddress: contact.emailAddress },
                        'yes'
                    );
                } catch (error) {
                    logger.error('Error syncing YES decision for contact', {
                        contactId: contact.contactId,
                        error: error.message
                    });
                }
            }

            for (const contact of results.no) {
                try {
                    await DecisionController.syncSingleDecisionResult(
                        instance,
                        eloquaService,
                        { contactId: contact.contactId, emailAddress: contact.emailAddress },
                        'no'
                    );
                } catch (error) {
                    logger.error('Error syncing NO decision for contact', {
                        contactId: contact.contactId,
                        error: error.message
                    });
                }
            }

            logger.info('Bulk decision sync completed', {
                instanceId: instance.instanceId,
                yesCount: results.yes.length,
                noCount: results.no.length
            });

        } catch (error) {
            logger.error('Error syncing bulk decision results', {
                instanceId: instance.instanceId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Sync single decision result using Decision API (CORRECT VERSION - NO BULK API!)
     */
    static async syncSingleDecisionResult(instance, eloquaService, contact, decision) {
        try {
            logger.info('Syncing single decision result', {
                instanceId: instance.instanceId,
                contactId: contact.contactId,
                decision
            });

            const instanceIdNoDashes = instance.instanceId.replace(/-/g, '');
            
            logger.debug('Setting decision via Decision API', {
                instanceId: instanceIdNoDashes,
                contactId: contact.contactId,
                decision,
                fullUrl: `${eloquaService.baseURL}/api/cloud/1.0/decisions/instances/${instanceIdNoDashes}/contacts/${contact.contactId}`
            });

            await eloquaService.setDecision(instanceIdNoDashes, contact.contactId, decision);

            logger.info('Decision set successfully via Decision API', {
                instanceId: instance.instanceId,
                contactId: contact.contactId,
                decision
            });

        } catch (error) {
            logger.error('Error syncing single decision result', {
                instanceId: instance.instanceId,
                contactId: contact.contactId,
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Process SMS reply and evaluate decision
     */
    static async processReply(reply, smsLog = null) {
        try {
            logger.info('Processing reply for decision', {
                replyId: reply._id,
                fromNumber: reply.fromNumber,
                message: reply.message?.substring(0, 50),
                hasSmsLog: !!smsLog
            });

            if (!smsLog) {
                if (reply.messageId) {
                    smsLog = await SmsLog.findOne({
                        messageId: reply.messageId,
                        decisionInstanceId: { $ne: null },
                        decisionStatus: 'pending'
                    });
                }

                if (!smsLog && reply.fromNumber) {
                    const recentSmsLogs = await SmsLog.find({
                        mobileNumber: reply.fromNumber,
                        decisionInstanceId: { $ne: null },
                        decisionStatus: 'pending',
                        decisionDeadline: { $gte: new Date() }
                    }).sort({ sentAt: -1 }).limit(5);

                    if (recentSmsLogs.length > 0) {
                        smsLog = recentSmsLogs[0];
                        
                        logger.info('Found SMS log by mobile number', {
                            mobile: reply.fromNumber,
                            smsLogId: smsLog._id,
                            candidateCount: recentSmsLogs.length
                        });
                    }
                }
            }

            if (!smsLog) {
                logger.debug('No pending SMS log found for reply', {
                    mobile: reply.fromNumber,
                    messageId: reply.messageId
                });
                return null;
            }

            const instance = await DecisionInstance.findOne({
                instanceId: smsLog.decisionInstanceId,
                isActive: true
            });

            if (!instance) {
                logger.warn('Decision instance not found or inactive', {
                    instanceId: smsLog.decisionInstanceId
                });
                return null;
            }

            const isWithinPeriod = new Date() <= smsLog.decisionDeadline;

            if (!isWithinPeriod) {
                logger.info('Reply received after deadline', {
                    smsLogId: smsLog._id,
                    deadline: smsLog.decisionDeadline,
                    receivedAt: new Date()
                });

                smsLog.decisionStatus = 'no';
                smsLog.decisionProcessedAt = new Date();
                await smsLog.save();

                const eloquaService = new EloquaService(instance.installId, instance.SiteId);
                await eloquaService.initialize();

                await DecisionController.syncSingleDecisionResult(
                    instance,
                    eloquaService,
                    { contactId: smsLog.contactId, emailAddress: smsLog.emailAddress },
                    'no'
                );

                return { decision: 'no', reason: 'expired', matches: false };
            }

            const matches = DecisionController.evaluateReply(
                reply.message,
                instance.text_type,
                instance.keyword
            );

            logger.info('Reply evaluation result', {
                smsLogId: smsLog._id,
                matches,
                textType: instance.text_type,
                keyword: instance.keyword,
                message: reply.message?.substring(0, 50)
            });

            smsLog.hasResponse = true;
            smsLog.responseMessage = reply.message;
            smsLog.responseReceivedAt = new Date();
            smsLog.responseMessageId = reply.responseId || reply.messageId;
            smsLog.linkedReplyId = reply._id;
            smsLog.decisionStatus = matches ? 'yes' : 'no';
            smsLog.decisionProcessedAt = new Date();
            await smsLog.save();

            reply.smsLogId = smsLog._id;
            reply.processed = true;
            reply.processedAt = new Date();
            await reply.save();

            const decision = matches ? 'yes' : 'no';
            const eloquaService = new EloquaService(instance.installId, instance.SiteId);
            await eloquaService.initialize();
            
            await DecisionController.syncSingleDecisionResult(
                instance,
                eloquaService,
                { contactId: smsLog.contactId, emailAddress: smsLog.emailAddress },
                decision
            );

            const consumer = await Consumer.findOne({ installId: instance.installId });
            if (consumer && consumer.actions?.receivesms?.custom_object_id) {
                try {
                    await DecisionController.updateCustomObject(
                        eloquaService,
                        instance,
                        consumer,
                        smsLog,
                        reply.message
                    );
                } catch (cdoError) {
                    logger.error('Error updating custom object', {
                        error: cdoError.message,
                        smsLogId: smsLog._id
                    });
                }
            }

            logger.info('Reply processed successfully', {
                replyId: reply._id,
                smsLogId: smsLog._id,
                decision,
                matches
            });

            return { decision, matches, smsLog };

        } catch (error) {
            logger.error('Error processing reply for decision', {
                replyId: reply._id,
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Evaluate if reply matches criteria
     */
    static evaluateReply(replyMessage, textType, keyword) {
        if (!replyMessage) return false;

        const cleanMessage = replyMessage.toLowerCase().trim();

        if (textType === 'Anything') {
            return true;
        }

        if (textType === 'Keyword' && keyword) {
            const keywords = keyword.toLowerCase().split(',').map(k => k.trim());
            return keywords.some(kw => cleanMessage.includes(kw));
        }

        return false;
    }

    /**
     * Update custom object with reply data
     */
    static async updateCustomObject(eloquaService, instance, consumer, smsLog, replyMessage) {
        try {
            const cdoConfig = consumer.actions?.receivesms;
            
            if (!cdoConfig || !cdoConfig.custom_object_id) {
                logger.debug('No custom object configured for receivesms', {
                    installId: consumer.installId
                });
                return;
            }

            logger.info('Updating custom object with reply', {
                customObjectId: cdoConfig.custom_object_id,
                contactId: smsLog.contactId
            });

            const cdoData = {
                fieldValues: []
            };

            if (cdoConfig.mobile_field) {
                cdoData.fieldValues.push({
                    id: cdoConfig.mobile_field,
                    value: smsLog.mobileNumber
                });
            }

            if (cdoConfig.email_field) {
                cdoData.fieldValues.push({
                    id: cdoConfig.email_field,
                    value: smsLog.emailAddress
                });
            }

            if (cdoConfig.response_field && replyMessage) {
                cdoData.fieldValues.push({
                    id: cdoConfig.response_field,
                    value: replyMessage.substring(0, 250)
                });
            }

            if (cdoConfig.title_field && smsLog.campaignTitle) {
                cdoData.fieldValues.push({
                    id: cdoConfig.title_field,
                    value: smsLog.campaignTitle
                });
            }

            if (cdoConfig.vn_field && smsLog.senderId) {
                cdoData.fieldValues.push({
                    id: cdoConfig.vn_field,
                    value: smsLog.senderId
                });
            }

            if (cdoData.fieldValues.length > 0) {
                await eloquaService.createCustomObjectRecord(
                    cdoConfig.custom_object_id,
                    cdoData
                );

                logger.info('Custom object updated successfully', {
                    customObjectId: cdoConfig.custom_object_id,
                    contactId: smsLog.contactId,
                    fieldCount: cdoData.fieldValues.length
                });
            } else {
                logger.warn('No field mappings configured for custom object', {
                    customObjectId: cdoConfig.custom_object_id
                });
            }

        } catch (error) {
            logger.error('Error updating custom object', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Get custom objects (AJAX)
     */
    static getCustomObjects = asyncHandler(async (req, res) => {
        const { installId, siteId } = req.params;
        const { search } = req.query;

        logger.debug('Getting custom objects', { installId, siteId, search });

        const eloquaService = new EloquaService(installId, siteId);
        await eloquaService.initialize();

        const customObjects = await eloquaService.getCustomObjects(search, 100);
        
        res.json(customObjects);
    });

    /**
     * Get custom object fields (AJAX)
     */
    static getCustomObjectFields = asyncHandler(async (req, res) => {
        const { installId, siteId, customObjectId } = req.params;

        logger.debug('Getting custom object fields', { 
            installId, 
            siteId, 
            customObjectId 
        });

        const eloquaService = new EloquaService(installId, siteId);
        await eloquaService.initialize();

        const customObject = await eloquaService.getCustomObject(customObjectId);
        
        res.json(customObject);
    });

    /**
     * Get decision report
     * GET /eloqua/decision/report/:instanceId
     */
    static getReport = asyncHandler(async (req, res) => {
        const { instanceId } = req.params;

        logger.info('Loading decision report', { instanceId });

        try {
            const logs = await SmsLog.find({ decisionInstanceId: instanceId })
                .sort({ decisionProcessedAt: -1, sentAt: -1 })
                .limit(100)
                .select('contactId emailAddress mobileNumber message responseMessage decisionStatus decisionProcessedAt sentAt hasResponse');

            const stats = {
                yes: 0,
                no: 0,
                pending: 0,
                total: logs.length
            };

            logs.forEach(log => {
                if (log.decisionStatus === 'yes') stats.yes++;
                else if (log.decisionStatus === 'no') stats.no++;
                else if (log.decisionStatus === 'pending') stats.pending++;
            });

            res.json({
                success: true,
                logs,
                stats
            });

        } catch (error) {
            logger.error('Error loading decision report', {
                instanceId,
                error: error.message
            });

            res.status(500).json({
                success: false,
                error: error.message,
                logs: [],
                stats: { yes: 0, no: 0, pending: 0, total: 0 }
            });
        }
    });
}

module.exports = DecisionController;