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
        } else {
            logger.info('Existing instance found', { 
                instanceId,
                evaluation_period: instance.evaluation_period,
                evaluation_period_type: typeof instance.evaluation_period,
                text_type: instance.text_type,
                keyword: instance.keyword,
                requiresConfiguration: instance.requiresConfiguration
            });
            
            // Convert Mongoose document to plain object
            instance = instance.toObject();
            
            logger.info('Instance converted to object', {
                instanceId,
                evaluation_period: instance.evaluation_period,
                evaluation_period_type: typeof instance.evaluation_period
            });
        }

        if (CustomObjectId) {
            instance.program_coid = CustomObjectId;
        }

        if (instance.evaluation_period !== undefined && instance.evaluation_period !== null) {
            instance.evaluation_period = Number(instance.evaluation_period);
            
            logger.info('Evaluation period ensured as number', {
                value: instance.evaluation_period,
                type: typeof instance.evaluation_period
            });
        }


        logger.info('Rendering decision config view', {
            instanceId: instance.instanceId,
            evaluation_period: instance.evaluation_period,
            evaluation_period_human: DecisionController.formatEvaluationPeriod(instance.evaluation_period),
            text_type: instance.text_type,
            keyword: instance.keyword,
            hasCdoConfig: !!(consumer.actions?.receivesms?.custom_object_id)
        });

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

        logger.info('Saving decision configuration - RAW DATA', { 
            instanceId,
            installId,
            siteId,
            rawBody: JSON.stringify(req.body),
            instanceDataKeys: Object.keys(instanceData || {}),
            receivedData: {
                evaluation_period_raw: instanceData?.evaluation_period,
                evaluation_period_type: typeof instanceData?.evaluation_period,
                evaluation_period_stringified: JSON.stringify(instanceData?.evaluation_period),
                text_type: instanceData?.text_type,
                keyword: instanceData?.keyword
            }
        });

        // ============================================
        // VALIDATION
        // ============================================
        
        // Validate evaluation_period (can be string or number)
        if (instanceData.evaluation_period === undefined || 
            instanceData.evaluation_period === null || 
            instanceData.evaluation_period === '') {
            return res.status(400).json({
                success: false,
                message: 'Evaluation period is required'
            });
        }

        // Convert to number and validate
        const evaluationPeriod = Number(instanceData.evaluation_period);

            logger.info('Evaluation period conversion', {
                original: instanceData.evaluation_period,
                originalType: typeof instanceData.evaluation_period,
                converted: evaluationPeriod,
                convertedType: typeof evaluationPeriod,
                isNaN: isNaN(evaluationPeriod)
            });
        
        if (isNaN(evaluationPeriod)) {
            return res.status(400).json({
                success: false,
                message: 'Evaluation period must be a valid number'
            });
        }

        // Validate text_type
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

        //instance.evaluation_period = parseInt(instanceData.evaluation_period);
        instance.evaluation_period = evaluationPeriod;
        instance.text_type = String(instanceData.text_type);
        instance.keyword = instanceData.keyword ? String(instanceData.keyword).trim() : null;
        
        instance.configureAt = new Date();
        instance.requiresConfiguration = false;

        await instance.save();

        logger.info('Decision configuration saved', { 
            instanceId,
            evaluation_period: instance.evaluation_period,
            evaluation_period_human: DecisionController.formatEvaluationPeriod(instance.evaluation_period),
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
     * FIXED: 
     * - Logs to CDO even when NO RESPONSE (timeout)
     * - All timeouts = NO decision (synced to Eloqua)
     * - Supports 5-minute to 7-day evaluation periods
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

            // Initialize Eloqua service for CDO updates
            let eloquaService = null;
            const hasCdoConfig = !!(consumer.actions?.receivesms?.custom_object_id);
            
            if (hasCdoConfig) {
                try {
                    eloquaService = new EloquaService(consumer.installId, instance.SiteId);
                    await eloquaService.initialize();
                    
                    logger.info('Eloqua service initialized for CDO logging', {
                        customObjectId: consumer.actions.receivesms.custom_object_id
                    });
                } catch (error) {
                    logger.error('Failed to initialize Eloqua service for CDO', {
                        error: error.message
                    });
                }
            }

            // Evaluation period calculation
            const evaluationHours = instance.evaluation_period === -1 
                ? 24 * 365
                : instance.evaluation_period;

            const evaluationMinutes = (evaluationHours * 60).toFixed(2);
            const evaluationHuman = DecisionController.formatEvaluationPeriod(instance.evaluation_period);

            logger.info('Processing decision for SMS responses', {
                instanceId,
                executionId,
                evaluationPeriod: instance.evaluation_period,
                evaluationHours,
                evaluationMinutes: `${evaluationMinutes} minutes`,
                evaluationHuman,
                textType: instance.text_type,
                keyword: instance.keyword,
                itemsToProcess: executionData.items.length,
                hasCdoConfig
            });

            const results = {
                yes: [],
                no: [],
                pending: []
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

                    const cutoffDate = new Date(Date.now() - evaluationHours * 60 * 60 * 1000);

                    logger.debug('Evaluation period calculated', {
                        contactId,
                        evaluationHours,
                        evaluationMinutes,
                        cutoffDate: cutoffDate.toISOString(),
                        now: new Date().toISOString()
                    });

                    // Find the most recent SMS sent to this contact
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
                            cutoffDate,
                            evaluationPeriod: instance.evaluation_period
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

                    // Calculate evaluation deadline
                    const evaluationDeadline = new Date(
                        smsLog.sentAt.getTime() + (evaluationHours * 60 * 60 * 1000)
                    );

                    const now = new Date();
                    const remainingMs = evaluationDeadline - now;
                    const remainingMinutes = Math.max(0, remainingMs / (60 * 1000));
                    const remainingHours = Math.max(0, remainingMs / (60 * 60 * 1000));

                    logger.debug('Evaluation deadline calculated', {
                        contactId,
                        sentAt: smsLog.sentAt.toISOString(),
                        deadline: evaluationDeadline.toISOString(),
                        now: now.toISOString(),
                        hasExpired: now > evaluationDeadline,
                        remainingMinutes: remainingMinutes.toFixed(2),
                        remainingHours: remainingHours.toFixed(2)
                    });

                    // Link SMS to this decision instance
                    smsLog.decisionInstanceId = instanceId;
                    smsLog.decisionDeadline = evaluationDeadline;

                    let shouldLogToCdo = false;
                    let decisionResult = null;
                    let cdoResponseMessage = null;

                    // ============================================
                    // EVALUATION LOGIC - ONLY 2 OUTCOMES: YES or NO
                    // ============================================
                    
                    if (now > evaluationDeadline) {
                        // ============================================
                        // PERIOD EXPIRED
                        // ============================================
                        const hoursOverdue = ((now - evaluationDeadline) / (60 * 60 * 1000)).toFixed(2);
                        const minutesOverdue = ((now - evaluationDeadline) / (60 * 1000)).toFixed(2);
                        
                        if (smsLog.hasResponse) {
                            // Has response - check if it matches
                            const matches = DecisionController.evaluateReply(
                                smsLog.responseMessage,
                                instance.text_type,
                                instance.keyword
                            );

                            if (matches) {
                                // ✅ YES - Responded + Matched
                                smsLog.decisionStatus = 'yes';
                                decisionResult = 'yes';
                                cdoResponseMessage = smsLog.responseMessage;
                                
                                results.yes.push({
                                    contactId,
                                    emailAddress,
                                    messageId: smsLog.messageId,
                                    responseMessage: smsLog.responseMessage
                                });

                                logger.info('✅ YES - Contact responded and matched', {
                                    contactId,
                                    messageId: smsLog.messageId,
                                    responseMessage: smsLog.responseMessage?.substring(0, 50),
                                    minutesOverdue
                                });
                            } else {
                                // ❌ NO - Responded but didn't match
                                smsLog.decisionStatus = 'no';
                                decisionResult = 'no';
                                cdoResponseMessage = smsLog.responseMessage;
                                
                                results.no.push({
                                    contactId,
                                    emailAddress,
                                    messageId: smsLog.messageId,
                                    reason: 'response_no_match',
                                    responseMessage: smsLog.responseMessage
                                });

                                logger.info('❌ NO - Contact responded but no match', {
                                    contactId,
                                    messageId: smsLog.messageId,
                                    responseMessage: smsLog.responseMessage?.substring(0, 50),
                                    minutesOverdue
                                });
                            }
                            
                            shouldLogToCdo = true; // Has response, log it
                            
                        } else {
                            // ❌ NO - Timeout with no response
                            smsLog.decisionStatus = 'no';
                            decisionResult = 'no';
                            cdoResponseMessage = 'NO RESPONSE'; // ← Log this to CDO
                            
                            results.no.push({
                                contactId,
                                emailAddress,
                                messageId: smsLog.messageId,
                                reason: 'no_response_timeout'
                            });

                            logger.info('❌ NO - Evaluation period expired, no response (TIMEOUT)', {
                                contactId,
                                messageId: smsLog.messageId,
                                deadline: evaluationDeadline,
                                hoursOverdue,
                                minutesOverdue,
                                evaluationPeriod: evaluationHuman
                            });
                            
                            // ✅ CRITICAL: Log timeout to CDO too!
                            shouldLogToCdo = true;
                        }

                        smsLog.decisionProcessedAt = new Date();
                        
                    } else {
                        // ============================================
                        // PERIOD STILL ACTIVE
                        // ============================================
                        if (smsLog.hasResponse) {
                            // Already has response - evaluate immediately
                            const matches = DecisionController.evaluateReply(
                                smsLog.responseMessage,
                                instance.text_type,
                                instance.keyword
                            );

                            if (matches) {
                                // ✅ YES - Responded + Matched
                                smsLog.decisionStatus = 'yes';
                                decisionResult = 'yes';
                                cdoResponseMessage = smsLog.responseMessage;
                                
                                results.yes.push({
                                    contactId,
                                    emailAddress,
                                    messageId: smsLog.messageId,
                                    responseMessage: smsLog.responseMessage
                                });

                                logger.info('✅ YES - Contact already responded (matches)', {
                                    contactId,
                                    messageId: smsLog.messageId,
                                    responseMessage: smsLog.responseMessage?.substring(0, 50),
                                    remainingMinutes: remainingMinutes.toFixed(2)
                                });
                            } else {
                                // ❌ NO - Responded but didn't match
                                smsLog.decisionStatus = 'no';
                                decisionResult = 'no';
                                cdoResponseMessage = smsLog.responseMessage;
                                
                                results.no.push({
                                    contactId,
                                    emailAddress,
                                    messageId: smsLog.messageId,
                                    reason: 'response_no_match',
                                    responseMessage: smsLog.responseMessage
                                });

                                logger.info('❌ NO - Contact already responded (no match)', {
                                    contactId,
                                    messageId: smsLog.messageId,
                                    responseMessage: smsLog.responseMessage?.substring(0, 50),
                                    remainingMinutes: remainingMinutes.toFixed(2)
                                });
                            }

                            smsLog.decisionProcessedAt = new Date();
                            shouldLogToCdo = true;
                            
                        } else {
                            // ⏳ PENDING - No response yet, still within period
                            smsLog.decisionStatus = 'pending';
                            
                            results.pending.push({
                                contactId,
                                emailAddress,
                                messageId: smsLog.messageId,
                                deadline: evaluationDeadline
                            });

                            logger.info('⏳ PENDING - Waiting for response', {
                                contactId,
                                messageId: smsLog.messageId,
                                deadline: evaluationDeadline,
                                remainingMinutes: remainingMinutes.toFixed(2),
                                remainingHours: remainingHours.toFixed(2),
                                evaluationPeriod: evaluationHuman
                            });
                            
                            // Don't log to CDO yet - waiting for response or timeout
                        }
                    }

                    await smsLog.save();

                    // ============================================
                    // LOG TO CDO FOR ALL DECISIONS (YES and NO)
                    // ============================================
                    if (shouldLogToCdo && eloquaService) {
                        try {
                            await DecisionController.updateCustomObject(
                                eloquaService,
                                instance,
                                consumer,
                                smsLog,
                                cdoResponseMessage // ← Can be actual response or "NO RESPONSE"
                            );

                            logger.info('✅ CDO updated for decision', {
                                contactId,
                                decision: decisionResult,
                                responseMessage: cdoResponseMessage?.substring(0, 50),
                                isTimeout: cdoResponseMessage === 'NO RESPONSE'
                            });
                        } catch (cdoError) {
                            logger.error('❌ Failed to update CDO for decision', {
                                contactId,
                                decision: decisionResult,
                                error: cdoError.message
                            });
                        }
                    }

                } catch (error) {
                    logger.error('Error processing contact decision', {
                        contactId: item.ContactID,
                        error: error.message,
                        stack: error.stack
                    });
                }
            }

            logger.info('✅ Decision evaluation completed', {
                instanceId,
                executionId,
                evaluationPeriod: evaluationHuman,
                yesCount: results.yes.length,
                noCount: results.no.length,
                pendingCount: results.pending.length,
                note: 'Timeout = NO decision'
            });

            // ============================================
            // SYNC TO ELOQUA - Only YES and NO (not PENDING)
            // PENDING will be synced later by cleanup worker
            // ============================================
            const syncResults = {
                yes: results.yes,
                no: results.no
            };

            if (syncResults.yes.length > 0 || syncResults.no.length > 0) {
                await DecisionController.syncBulkDecisionResults(
                    consumer,
                    instance,
                    executionId,
                    syncResults
                );

                logger.info('✅ Decision results synced to Eloqua', {
                    instanceId,
                    executionId,
                    evaluationPeriod: evaluationHuman,
                    yesSynced: syncResults.yes.length,
                    noSynced: syncResults.no.length,
                    pendingNotSynced: results.pending.length,
                    note: 'Including timeouts as NO'
                });
            } else {
                logger.info('⏳ No immediate decisions to sync (all pending)', {
                    instanceId,
                    executionId,
                    evaluationPeriod: evaluationHuman,
                    pendingCount: results.pending.length
                });
            }

            // Log info about pending contacts
            if (results.pending.length > 0) {
                logger.info('⏳ Contacts waiting for evaluation period', {
                    instanceId,
                    evaluationPeriod: evaluationHuman,
                    pendingCount: results.pending.length,
                    note: 'Will be evaluated by cleanup worker when deadline passes → NO if no response'
                });
            }

        } catch (error) {
            logger.error('❌ Error in decision notify async processing', {
                instanceId,
                executionId,
                error: error.message,
                stack: error.stack
            });
        }
    }

    /**
     * Helper: Format evaluation period for human-readable display
     */
    static formatEvaluationPeriod(hours) {
        if (hours === -1) return 'Anytime';
        
        if (hours < 1) {
            const minutes = Math.round(hours * 60);
            return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
        }
        
        if (hours < 24) {
            const hoursRounded = hours % 1 === 0 ? hours : hours.toFixed(1);
            return `${hoursRounded} hour${hours !== 1 ? 's' : ''}`;
        }
        
        const days = Math.round(hours / 24);
        return `${days} day${days !== 1 ? 's' : ''}`;
    }

    /**
     * Sync bulk decision results to Eloqua using Bulk API with executionId
     * CRITICAL FIX: Must include executionId in syncActions destination
     */
    static async syncBulkDecisionResults(consumer, instance, executionId, results) {
        try {
            logger.info('Syncing bulk decision results', {
                instanceId: instance.instanceId,
                executionId,
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
                    executionId,
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
                    executionId,
                    results.no,
                    'no'
                );
            }

            logger.info('Bulk decision sync completed', {
                instanceId: instance.instanceId,
                executionId
            });

        } catch (error) {
            logger.error('Error syncing bulk decision results', {
                instanceId: instance.instanceId,
                executionId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Sync a batch of decision results using Bulk API
     * CRITICAL: Must include executionId in syncActions destination
     */
    static async syncDecisionBatch(eloquaService, instance, instanceIdNoDashes, executionId, contacts, decision) {
        try {
            logger.info('Syncing decision batch', {
                instanceId: instance.instanceId,
                executionId,
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
                        // CRITICAL FIX: Include execution ID in the destination
                        destination: `{{DecisionInstance(${instanceIdNoDashes}).Execution[${executionId}]}}`,
                        action: "setStatus",
                        status: decision
                    }
                ]
            };

            logger.debug('Creating bulk import with syncActions', {
                instanceId: instance.instanceId,
                executionId,
                destination: importDefinition.syncActions[0].destination,
                decision
            });

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
                count: contacts.length,
                executionId
            });

            // ============================================
            // ✅ CRITICAL: WAIT FOR SYNC TO COMPLETE
            // ============================================
            logger.info('⏳ Waiting for sync to complete...', {
                syncUri: sync.uri,
                decision,
                count: contacts.length
            });

            await ActionController.waitForSyncCompletion(eloquaService, sync.uri);

            logger.info('✅ Decision batch sync completed successfully', {
                syncUri: sync.uri,
                decision,
                count: contacts.length,
                executionId
            });

        } catch (error) {
            logger.error('Error syncing decision batch', {
                decision,
                count: contacts.length,
                executionId,
                error: error.message,
                responseData: error.response?.data
            });
            throw error;
        }
    }

    /**
     * Process SMS reply and evaluate decision
     * For real-time replies, we mark the status but can't sync without executionId
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

            // NOTE: We cannot sync to Eloqua here because we don't have executionId
            // The contact will get the correct decision on the next decision step evaluation
            logger.info('Decision marked (will sync on next evaluation)', {
                contactId: smsLog.contactId,
                decision,
                note: 'Real-time reply - no executionId available for sync'
            });

            const consumer = await Consumer.findOne({ installId: instance.installId });
            if (consumer && consumer.actions?.receivesms?.custom_object_id) {
                try {
                    const eloquaService = new EloquaService(instance.installId, instance.SiteId);
                    await eloquaService.initialize();
                    
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
     * FIXED: Now uses field IDs from CDO structure
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

            // Fetch CDO structure to get field IDs
            const cdoFieldMap = await eloquaService.getCustomObjectFieldMap(cdoConfig.custom_object_id);

            const fieldMap = new Map();

            const addField = (fieldName, value) => {
                if (!fieldName || fieldName.trim() === '') {
                    return;
                }
                
                const field = cdoFieldMap[fieldName.trim()];
                
                if (!field || !field.id) {
                    logger.warn('Field not found in CDO structure for reply', {
                        fieldName: fieldName.trim()
                    });
                    return;
                }
                
                const fieldId = field.id;
                
                if (!fieldMap.has(fieldId)) {
                    fieldMap.set(fieldId, value || '');
                    logger.debug('Added CDO field for reply', {
                        fieldName: fieldName.trim(),
                        fieldId: fieldId,
                        valueLength: (value || '').length
                    });
                }
            };

            addField(cdoConfig.mobile_field, smsLog.mobileNumber);
            addField(cdoConfig.email_field, smsLog.emailAddress);
            addField(cdoConfig.response_field, replyMessage ? replyMessage.substring(0, 250) : '');
            addField(cdoConfig.title_field, smsLog.campaignTitle);
            addField(cdoConfig.vn_field, smsLog.senderId);

            if (fieldMap.size === 0) {
                logger.warn('No valid fields to insert for reply', {
                    customObjectId: cdoConfig.custom_object_id
                });
                return;
            }

            const cdoData = {
                type: "CustomObjectData",
                contactId: smsLog.contactId,
                fieldValues: Array.from(fieldMap.entries()).map(([id, value]) => ({
                    id: id,
                    value: value
                }))
            };

            logger.info('CDO data prepared for reply with field IDs', {
                customObjectId: cdoConfig.custom_object_id,
                fieldCount: cdoData.fieldValues.length,
                fields: cdoData.fieldValues.map(f => ({ 
                    id: f.id, 
                    valuePreview: (f.value || '').substring(0, 30) 
                }))
            });

            await eloquaService.createCustomObjectRecord(
                cdoConfig.custom_object_id,
                cdoData
            );

            logger.info('Custom object updated successfully with reply', {
                customObjectId: cdoConfig.custom_object_id,
                contactId: smsLog.contactId,
                fieldCount: cdoData.fieldValues.length
            });

        } catch (error) {
            logger.error('Error updating custom object with reply', {
                error: error.message,
                stack: error.stack,
                customObjectId: consumer.actions?.receivesms?.custom_object_id,
                responseData: error.response?.data
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
     * Get decision report page
     * GET /eloqua/decision/report/:instanceId
     */
    static getReportPage = asyncHandler(async (req, res) => {
        const { instanceId } = req.params;
        const { installId, siteId } = req.query;

        logger.info('Loading decision report page', { instanceId, installId, siteId });

        const instance = await DecisionInstance.findOne({ instanceId });
        if (!instance) {
            return res.status(404).send('Instance not found');
        }

        res.render('decision-report', {
            instanceId,
            installId: installId || instance.installId,
            siteId: siteId || instance.SiteId
        });
    });

    /**
     * Get decision report data (JSON) - WITH PAGINATION
     * GET /eloqua/decision/report/:instanceId/data
     */
    static getReport = asyncHandler(async (req, res) => {
        const { instanceId } = req.params;
        const { page = 1, limit = 100, status = 'all' } = req.query;

        logger.info('Loading decision report data', { instanceId, page, limit, status });

        try {
            const instance = await DecisionInstance.findOne({ instanceId });
            if (!instance) {
                return res.status(404).json({
                    success: false,
                    error: 'Instance not found'
                });
            }

            // Build query
            const query = { decisionInstanceId: instanceId };
            if (status !== 'all') {
                query.decisionStatus = status;
            }

            // Get total count
            const total = await SmsLog.countDocuments(query);

            // Get paginated logs
            const logs = await SmsLog.find(query)
                .sort({ decisionProcessedAt: -1, sentAt: -1 })
                .limit(parseInt(limit))
                .skip((parseInt(page) - 1) * parseInt(limit))
                .select('contactId emailAddress mobileNumber message responseMessage decisionStatus decisionProcessedAt sentAt hasResponse messageId decisionDeadline');

            // Get statistics
            const stats = await SmsLog.aggregate([
                { $match: { decisionInstanceId: instanceId } },
                {
                    $group: {
                        _id: '$decisionStatus',
                        count: { $sum: 1 }
                    }
                }
            ]);

            const statsMap = {
                yes: 0,
                no: 0,
                pending: 0,
                total: 0
            };

            stats.forEach(stat => {
                if (stat._id) {
                    statsMap[stat._id] = stat.count;
                    statsMap.total += stat.count;
                }
            });

            logger.info('Decision report data loaded', {
                instanceId,
                logsCount: logs.length,
                stats: statsMap
            });

            res.json({
                success: true,
                instance: {
                    instanceId: instance.instanceId,
                    evaluation_period: instance.evaluation_period,
                    text_type: instance.text_type,
                    keyword: instance.keyword
                },
                logs,
                stats: statsMap,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / parseInt(limit))
                }
            });

        } catch (error) {
            logger.error('Error loading decision report', {
                instanceId,
                error: error.message,
                stack: error.stack
            });

            res.status(500).json({
                success: false,
                error: error.message,
                logs: [],
                stats: { yes: 0, no: 0, pending: 0, total: 0 }
            });
        }
    });

    /**
     * Download decision report as CSV
     * GET /eloqua/decision/report/:instanceId/csv
     */
    static downloadReportCSV = asyncHandler(async (req, res) => {
        const { instanceId } = req.params;
        const { status = 'all' } = req.query;

        logger.info('Downloading decision report CSV', { instanceId, status });

        try {
            const instance = await DecisionInstance.findOne({ instanceId });
            if (!instance) {
                return res.status(404).send('Instance not found');
            }

            // Build query
            const query = { decisionInstanceId: instanceId };
            if (status !== 'all') {
                query.decisionStatus = status;
            }

            // Get all logs (no pagination for CSV)
            const logs = await SmsLog.find(query)
                .sort({ decisionProcessedAt: -1, sentAt: -1 })
                .limit(10000) // Max 10k records
                .select('contactId emailAddress mobileNumber message responseMessage decisionStatus decisionProcessedAt sentAt hasResponse messageId decisionDeadline');

            // Build CSV content
            const csvRows = [];
            
            // Header
            csvRows.push([
                'Contact ID',
                'Email Address',
                'Mobile Number',
                'Original Message',
                'Response Message',
                'Decision Status',
                'Has Response',
                'Message ID',
                'Sent At',
                'Decision Processed At',
                'Decision Deadline'
            ].join(','));

            // Data rows
            logs.forEach(log => {
                csvRows.push([
                    log.contactId || '',
                    log.emailAddress || '',
                    log.mobileNumber || '',
                    `"${(log.message || '').replace(/"/g, '""')}"`,
                    `"${(log.responseMessage || '').replace(/"/g, '""')}"`,
                    log.decisionStatus || '',
                    log.hasResponse ? 'Yes' : 'No',
                    log.messageId || '',
                    log.sentAt ? log.sentAt.toISOString() : '',
                    log.decisionProcessedAt ? log.decisionProcessedAt.toISOString() : '',
                    log.decisionDeadline ? log.decisionDeadline.toISOString() : ''
                ].join(','));
            });

            const csv = csvRows.join('\n');

            // Set headers for file download
            const filename = `sms-decision-report-${instanceId}-${Date.now()}.csv`;
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.send(csv);

            logger.info('Decision report CSV downloaded', {
                instanceId,
                recordCount: logs.length
            });

        } catch (error) {
            logger.error('Error downloading decision report CSV', {
                instanceId,
                error: error.message
            });

            res.status(500).send('Error generating CSV report');
        }
    });
}

module.exports = DecisionController;