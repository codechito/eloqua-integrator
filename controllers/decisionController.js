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
            assetName,
            entity_type: assetType,
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

        // Set session data
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

        // Get custom objects - Pass installId and siteId correctly
        let custom_objects = { elements: [] };
        try {
            // Create EloquaService with installId and siteId
            const eloquaService = new EloquaService(installId, siteId);
            await eloquaService.initialize();
            
            custom_objects = await eloquaService.getCustomObjects('', 100);
            
            logger.debug('Custom objects fetched', { 
                count: custom_objects.elements?.length || 0 
            });
        } catch (error) {
            logger.warn('Could not fetch custom objects', { 
                error: error.message,
                installId,
                siteId
            });
        }

        res.render('decision-config', {
            consumer: consumer.toObject(),
            instance,
            custom_objects
        });
    });

    /**
     * Save configuration
     * POST /eloqua/decision/configure
     */
    static saveConfiguration = asyncHandler(async (req, res) => {
        const { instanceId, installId } = req.query;
        const { instance: instanceData } = req.body;

        logger.info('Saving decision configuration', { 
            instanceId,
            installId,
            evaluation_period: instanceData.evaluation_period,
            text_type: instanceData.text_type,
            keyword: instanceData.keyword
        });

        let instance = await DecisionInstance.findOne({ instanceId });
        
        if (!instance) {
            instance = new DecisionInstance({ 
                instanceId, 
                installId: installId || instanceData.installId,
                SiteId: instanceData.SiteId
            });
        }

        // Update fields
        instance.evaluation_period = instanceData.evaluation_period;
        instance.text_type = instanceData.text_type;
        instance.keyword = instanceData.keyword;
        instance.custom_object_id = instanceData.custom_object_id;
        instance.mobile_field = instanceData.mobile_field;
        instance.email_field = instanceData.email_field;
        instance.title_field = instanceData.title_field;
        instance.response_field = instanceData.response_field;
        instance.message = "--";
        instance.configureAt = new Date();
        instance.requiresConfiguration = false;

        await instance.save();

        logger.info('Decision configuration saved', { instanceId });

        res.json({
            success: true,
            message: 'Configuration saved successfully',
            requiresConfiguration: false
        });
    });

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
        const assetId = req.query.AssetId || req.params.assetId;
        const executionId = req.query.ExecutionId || req.params.executionId;
        
        const executionData = req.body;

        logger.info('Decision notify received', { 
            instanceId, 
            installId,
            assetId,
            executionId,
            recordCount: executionData.items?.length || 0
        });

        // Process asynchronously
        DecisionController.processNotifyAsync(
            instanceId, 
            installId,
            assetId,
            executionId,
            executionData
        ).catch(error => {
            logger.error('Async decision notify failed', {
                instanceId,
                error: error.message
            });
        });

        res.status(204).send();
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
     * Process notify asynchronously (helper method)
     */
    static async processNotifyAsync(instanceId, installId, assetId, executionId, executionData) {
        try {
            logger.info('Starting async decision notify processing', {
                instanceId,
                installId,
                assetId,
                recordCount: executionData.items?.length || 0
            });

            const instance = await DecisionInstance.findOne({ instanceId, installId });
            if (!instance) {
                logger.error('Decision instance not found', { instanceId });
                return;
            }

            // Update instance with asset info
            instance.assetId = assetId;
            instance.entry_date = new Date();
            instance.Status = 'delivered';
            await instance.save();

            // Extract contact IDs
            const contactIds = executionData.items.map(item => item.ContactID || item.Id);

            // Find SMS logs for these contacts
            const smsLogs = await SmsLog.find({
                installId,
                campaignId: assetId,
                contactId: { $in: contactIds },
                decisionInstanceId: null
            });

            logger.info('Found SMS logs to track', {
                instanceId,
                smsLogCount: smsLogs.length,
                contactIds: contactIds.length
            });

            // Assign decision instance to these SMS logs
            if (smsLogs.length > 0) {
                await SmsLog.updateMany(
                    { _id: { $in: smsLogs.map(log => log._id) } },
                    {
                        $set: {
                            decisionInstanceId: instanceId,
                            decisionStatus: 'pending',
                            decisionDeadline: new Date(Date.now() + (instance.evaluation_period * 60 * 60 * 1000))
                        }
                    }
                );

                logger.info('SMS logs assigned to decision instance', {
                    instanceId,
                    count: smsLogs.length
                });
            }

        } catch (error) {
            logger.error('Error in decision notify async processing', {
                instanceId,
                error: error.message,
                stack: error.stack
            });
        }
    }

    /**
     * Process SMS reply and evaluate decision
     * Called by webhook when reply is received
     */
    static async processReply(reply) {
        try {
            logger.info('Processing reply for decision', {
                replyId: reply._id,
                fromMobile: reply.fromMobile,
                message: reply.message
            });

            // Find SMS logs waiting for replies
            const smsLogs = await SmsLog.find({
                mobileNumber: reply.fromMobile,
                decisionInstanceId: { $ne: null },
                decisionStatus: 'pending'
            }).sort({ sentAt: -1 });

            if (smsLogs.length === 0) {
                logger.debug('No pending SMS logs found for reply', {
                    mobile: reply.fromMobile
                });
                return;
            }

            // Process each SMS log
            for (const smsLog of smsLogs) {
                const instance = await DecisionInstance.findOne({
                    instanceId: smsLog.decisionInstanceId
                });

                if (!instance) {
                    logger.warn('Decision instance not found', {
                        instanceId: smsLog.decisionInstanceId
                    });
                    continue;
                }

                // Check if within evaluation period
                const isWithinPeriod = DecisionController.isWithinEvaluationPeriod(
                    smsLog.sentAt,
                    instance.evaluation_period
                );

                if (!isWithinPeriod) {
                    logger.info('Reply outside evaluation period', {
                        smsLogId: smsLog._id,
                        sentAt: smsLog.sentAt,
                        evaluationPeriod: instance.evaluation_period
                    });

                    await DecisionController.syncDecisionResult(
                        instance,
                        smsLog,
                        'no',
                        null
                    );
                    continue;
                }

                // Evaluate if reply matches criteria
                const matches = DecisionController.evaluateReply(
                    reply.message,
                    instance.text_type,
                    instance.keyword
                );

                if (matches) {
                    logger.info('Reply matches decision criteria', {
                        replyId: reply._id,
                        instanceId: instance.instanceId,
                        textType: instance.text_type,
                        keyword: instance.keyword
                    });

                    await DecisionController.syncDecisionResult(
                        instance,
                        smsLog,
                        'yes',
                        reply.message
                    );

                    reply.smsLogId = smsLog._id;
                    reply.processed = true;
                    reply.processedAt = new Date();
                    await reply.save();

                    break;
                }
            }

        } catch (error) {
            logger.error('Error processing reply for decision', {
                replyId: reply._id,
                error: error.message,
                stack: error.stack
            });
        }
    }

    /**
     * Check if reply is within evaluation period
     */
    static isWithinEvaluationPeriod(sentAt, evaluationPeriodHours) {
        if (evaluationPeriodHours === -1) {
            return true;
        }

        const now = new Date();
        const sentTime = new Date(sentAt);
        const periodEnd = new Date(sentTime.getTime() + (evaluationPeriodHours * 60 * 60 * 1000));

        return now.getTime() < periodEnd.getTime();
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
     * Sync decision result to Eloqua
     */
    static async syncDecisionResult(instance, smsLog, decision, replyMessage) {
        try {
            logger.info('Syncing decision result to Eloqua', {
                instanceId: instance.instanceId,
                contactId: smsLog.contactId,
                decision
            });

            const consumer = await Consumer.findOne({ installId: instance.installId });
            if (!consumer) {
                throw new Error('Consumer not found');
            }

            // Create EloquaService with installId and siteId
            const eloquaService = new EloquaService(instance.installId, consumer.SiteId);
            await eloquaService.initialize();

            const instanceIdNoDashes = instance.instanceId.replace(/-/g, '');

            const importDefinition = {
                name: `SMS_Decision_${instanceIdNoDashes}_${decision}_${Date.now()}`,
                fields: {
                    ContactID: '{{Contact.Id}}',
                    EmailAddress: '{{Contact.Field(C_EmailAddress)}}'
                },
                identifierFieldName: 'EmailAddress',
                isSyncTriggeredOnImport: false,
                dataRetentionDuration: 'P7D',
                syncActions: [
                    {
                        destination: `{{DecisionInstance(${instanceIdNoDashes})}}`,
                        action: "setDecision",
                        value: decision
                    }
                ]
            };

            const importDef = await eloquaService.createContactImport(importDefinition);

            const contactData = [{
                ContactID: smsLog.contactId,
                EmailAddress: smsLog.emailAddress
            }];

            await eloquaService.uploadImportData(importDef.uri, contactData);
            const sync = await eloquaService.syncImport(importDef.uri);

            logger.info('Decision sync started', {
                syncUri: sync.uri,
                decision
            });

            smsLog.decisionStatus = decision;
            smsLog.decisionProcessedAt = new Date();
            await smsLog.save();

            if (instance.custom_object_id) {
                await DecisionController.updateCustomObject(
                    eloquaService,
                    instance,
                    consumer,
                    smsLog,
                    replyMessage
                );
            }

        } catch (error) {
            logger.error('Error syncing decision result', {
                instanceId: instance.instanceId,
                contactId: smsLog.contactId,
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Update custom object with reply data
     */
    static async updateCustomObject(eloquaService, instance, consumer, smsLog, replyMessage) {
        try {
            const actionConfig = consumer.actions?.receivesms;
            if (!actionConfig || !actionConfig.custom_object_id) {
                return;
            }

            const customObjectData = {
                [actionConfig.mobile_field]: smsLog.mobileNumber,
                [actionConfig.email_field]: smsLog.emailAddress,
                [actionConfig.response_field]: replyMessage || '',
                [actionConfig.title_field]: smsLog.campaignTitle,
                [actionConfig.vn_field]: smsLog.senderId
            };

            await eloquaService.createCustomObjectRecord(
                actionConfig.custom_object_id,
                customObjectData
            );

            logger.info('Custom object updated with reply', {
                customObjectId: actionConfig.custom_object_id,
                contactId: smsLog.contactId
            });

        } catch (error) {
            logger.error('Error updating custom object', {
                error: error.message
            });
        }
    }

    /**
     * Get custom objects (AJAX)
     * GET /eloqua/decision/ajax/customobjects/:installId/:siteId/customObject
     */
    static getCustomObjects = asyncHandler(async (req, res) => {
        const { installId, siteId } = req.params;
        const { search } = req.query;

        logger.debug('Getting custom objects', { installId, siteId, search });

        // Create EloquaService with installId and siteId
        const eloquaService = new EloquaService(installId, siteId);
        await eloquaService.initialize();

        const customObjects = await eloquaService.getCustomObjects(search, 100);
        
        res.json(customObjects);
    });

    /**
     * Get custom object fields (AJAX)
     * GET /eloqua/decision/ajax/customobject/:installId/:siteId/:customObjectId
     */
    static getCustomObjectFields = asyncHandler(async (req, res) => {
        const { installId, siteId, customObjectId } = req.params;

        logger.debug('Getting custom object fields', { 
            installId, 
            siteId, 
            customObjectId 
        });

        // Create EloquaService with installId and siteId
        const eloquaService = new EloquaService(installId, siteId);
        await eloquaService.initialize();

        const customObject = await eloquaService.getCustomObject(customObjectId);
        
        res.json(customObject);
    });
}

module.exports = DecisionController;