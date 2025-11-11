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

    // controllers/decisionController.js - ADD/UPDATE these methods

    /**
     * Process notify asynchronously - UPDATED VERSION
     */
    static async processNotifyAsync(instanceId, installId, assetId, executionId, executionData) {
        try {
            logger.info('Starting async decision notify processing', {
                instanceId,
                installId,
                assetId,
                executionId,
                recordCount: executionData.items?.length || 0
            });

            const instance = await DecisionInstance.findOne({ 
                instanceId, 
                installId,
                isActive: true 
            });
            
            if (!instance) {
                logger.error('Decision instance not found', { instanceId });
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
                keyword: instance.keyword
            });

            // Process each contact in the execution
            const results = {
                yes: [],
                no: [],
                errors: []
            };

            for (const item of executionData.items || []) {
                try {
                    const contactId = item.ContactID || item.Id;
                    const emailAddress = item.EmailAddress || item.C_EmailAddress;

                    logger.debug('Evaluating decision for contact', {
                        contactId,
                        emailAddress
                    });

                    // Find the most recent SMS sent to this contact
                    // Look for SMS sent within the evaluation period
                    const evaluationHours = instance.evaluation_period === -1 
                        ? 24 * 365 // 1 year for "forever"
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

                    // Assign this SMS to the decision instance
                    smsLog.decisionInstanceId = instanceId;
                    smsLog.decisionStatus = smsLog.hasResponse ? 'yes' : 'pending';
                    smsLog.decisionDeadline = new Date(
                        smsLog.sentAt.getTime() + (evaluationHours * 60 * 60 * 1000)
                    );
                    await smsLog.save();

                    // Check if already has a response
                    if (smsLog.hasResponse) {
                        // Check if response matches criteria
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
                        // No response yet - will be checked by webhook
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

            // Sync results to Eloqua
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
     * Sync bulk decision results to Eloqua - NEW METHOD
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

            const instanceIdNoDashes = instance.instanceId.replace(/-/g, '');

            // Sync YES contacts
            if (results.yes.length > 0) {
                await DecisionController.syncDecisionBatch(
                    eloquaService,
                    instance,
                    instanceIdNoDashes,
                    results.yes,
                    'yes'
                );
            }

            // Sync NO contacts
            if (results.no.length > 0) {
                await DecisionController.syncDecisionBatch(
                    eloquaService,
                    instance,
                    instanceIdNoDashes,
                    results.no,
                    'no'
                );
            }

            logger.info('Bulk decision sync completed', {
                instanceId: instance.instanceId
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
     * Sync a batch of decision results - NEW METHOD
     */
    static async syncDecisionBatch(eloquaService, instance, instanceIdNoDashes, contacts, decision) {
        try {
            logger.info('Syncing decision batch', {
                instanceId: instance.instanceId,
                decision,
                count: contacts.length
            });

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

            const importDef = await eloquaService.createBulkImport('contacts', importDefinition);

            const contactData = contacts.map(contact => ({
                ContactID: contact.contactId,
                EmailAddress: contact.emailAddress
            }));

            await eloquaService.uploadBulkImportData(importDef.uri, contactData);
            const sync = await eloquaService.syncBulkImport(importDef.uri);

            logger.info('Decision batch sync started', {
                syncUri: sync.uri,
                decision,
                count: contacts.length
            });

            // Don't wait for completion - Eloqua will process it

        } catch (error) {
            logger.error('Error syncing decision batch', {
                decision,
                count: contacts.length,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Process SMS reply and evaluate decision
     * Called by webhook when reply is received
     * 
     * @param {SmsReply} reply - The reply object from webhook
     * @param {SmsLog} smsLog - The original SMS log (optional, will search if not provided)
     */
    static async processReply(reply, smsLog = null) {
        try {
            logger.info('Processing reply for decision', {
                replyId: reply._id,
                fromNumber: reply.fromNumber,
                message: reply.message?.substring(0, 50),
                hasSmsLog: !!smsLog
            });

            // If smsLog not provided, try to find it
            if (!smsLog) {
                // Try by message ID first
                if (reply.messageId) {
                    smsLog = await SmsLog.findOne({
                        messageId: reply.messageId,
                        decisionInstanceId: { $ne: null },
                        decisionStatus: 'pending'
                    });
                }

                // If not found, try by mobile number
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

            // Get decision instance
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

            // Check if within evaluation period
            const isWithinPeriod = new Date() <= smsLog.decisionDeadline;

            if (!isWithinPeriod) {
                logger.info('Reply received after deadline', {
                    smsLogId: smsLog._id,
                    deadline: smsLog.decisionDeadline,
                    receivedAt: new Date()
                });

                // Mark as expired/no
                smsLog.decisionStatus = 'no';
                smsLog.decisionProcessedAt = new Date();
                await smsLog.save();

                await DecisionController.syncSingleDecisionResult(
                    instance,
                    smsLog,
                    'no'
                );

                return { decision: 'no', reason: 'expired', matches: false };
            }

            // Evaluate if reply matches criteria
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

            // Update SMS log with response
            smsLog.hasResponse = true;
            smsLog.responseMessage = reply.message;
            smsLog.responseReceivedAt = new Date();
            smsLog.responseMessageId = reply.responseId || reply.messageId;
            smsLog.linkedReplyId = reply._id;
            smsLog.decisionStatus = matches ? 'yes' : 'no';
            smsLog.decisionProcessedAt = new Date();
            await smsLog.save();

            // Update reply with SMS log reference
            reply.smsLogId = smsLog._id;
            reply.processed = true;
            reply.processedAt = new Date();
            await reply.save();

            // Sync result to Eloqua
            const decision = matches ? 'yes' : 'no';
            await DecisionController.syncSingleDecisionResult(
                instance,
                smsLog,
                decision
            );

            // Update custom object if configured
            if (instance.custom_object_id) {
                try {
                    const consumer = await Consumer.findOne({ installId: instance.installId });
                    if (consumer) {
                        const eloquaService = new EloquaService(instance.installId, instance.SiteId);
                        await eloquaService.initialize();
                        
                        await DecisionController.updateCustomObject(
                            eloquaService,
                            instance,
                            consumer,
                            smsLog,
                            reply.message
                        );
                    }
                } catch (cdoError) {
                    logger.error('Error updating custom object', {
                        error: cdoError.message,
                        smsLogId: smsLog._id
                    });
                    // Don't fail the whole process
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
     * Sync single decision result (for real-time reply processing)
     */
    static async syncSingleDecisionResult(instance, smsLog, decision) {
        try {
            logger.info('Syncing single decision result', {
                instanceId: instance.instanceId,
                contactId: smsLog.contactId,
                decision
            });

            const consumer = await Consumer.findOne({ installId: instance.installId });
            if (!consumer) {
                throw new Error('Consumer not found');
            }

            const eloquaService = new EloquaService(instance.installId, instance.SiteId);
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

            const importDef = await eloquaService.createBulkImport('contacts', importDefinition);

            const contactData = [{
                ContactID: smsLog.contactId,
                EmailAddress: smsLog.emailAddress
            }];

            await eloquaService.uploadBulkImportData(importDef.uri, contactData);
            const sync = await eloquaService.syncBulkImport(importDef.uri);

            logger.info('Single decision sync completed', {
                syncUri: sync.uri,
                decision,
                contactId: smsLog.contactId
            });

        } catch (error) {
            logger.error('Error syncing single decision result', {
                instanceId: instance.instanceId,
                contactId: smsLog.contactId,
                error: error.message,
                stack: error.stack
            });
            throw error;
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

        // If "Anything" - any response is a match
        if (textType === 'Anything') {
            return true;
        }

        // If "Keyword" - check for specific keywords
        if (textType === 'Keyword' && keyword) {
            const keywords = keyword.toLowerCase().split(',').map(k => k.trim());
            return keywords.some(kw => {
                // Check if message contains keyword (case-insensitive)
                return cleanMessage.includes(kw);
            });
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
            if (!instance.custom_object_id) {
                return;
            }

            logger.info('Updating custom object with reply', {
                customObjectId: instance.custom_object_id,
                contactId: smsLog.contactId
            });

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

            if (instance.response_field && replyMessage) {
                cdoData.fieldValues.push({
                    id: instance.response_field,
                    value: replyMessage.substring(0, 250) // Limit length
                });
            }

            if (instance.title_field && smsLog.campaignTitle) {
                cdoData.fieldValues.push({
                    id: instance.title_field,
                    value: smsLog.campaignTitle
                });
            }

            if (cdoData.fieldValues.length > 0) {
                await eloquaService.createCustomObjectRecord(
                    instance.custom_object_id,
                    cdoData
                );

                logger.info('Custom object updated successfully', {
                    customObjectId: instance.custom_object_id,
                    contactId: smsLog.contactId,
                    fieldCount: cdoData.fieldValues.length
                });
            }

        } catch (error) {
            logger.error('Error updating custom object', {
                customObjectId: instance.custom_object_id,
                error: error.message
            });
            throw error;
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