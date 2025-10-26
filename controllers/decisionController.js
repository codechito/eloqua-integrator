const DecisionInstance = require('../models/DecisionInstance');
const Consumer = require('../models/Consumer');
const SmsLog = require('../models/SmsLog');
const SmsReply = require('../models/SmsReply');
const { EloquaService } = require('../services');
const { logger, generateId, hoursBetween } = require('../utils');
const { asyncHandler } = require('../middleware');
const moment = require('moment');

class DecisionController {
    /**
     * Create decision instance
     * GET /eloqua/decision/create
     */
    static create = asyncHandler(async (req, res) => {
        const { installId, siteId, assetId } = req.query;
        const instanceId = generateId();

        logger.info('Creating decision instance', { installId, instanceId });

        const instance = new DecisionInstance({
            instanceId,
            installId,
            SiteId: siteId,
            assetId,
            evaluation_period: 24,
            text_type: 'Anything'
        });

        await instance.save();

        logger.info('Decision instance created', { instanceId });

        res.json({
            success: true,
            instanceId
        });
    });

    /**
     * Get configure page
     * GET /eloqua/decision/configure
     */
    static configure = asyncHandler(async (req, res) => {
        const { installId, siteId, instanceId } = req.query;

        logger.info('Loading decision configuration page', { installId, instanceId });

        const consumer = await Consumer.findOne({ installId });
        if (!consumer) {
            return res.status(404).send('Consumer not found');
        }

        let instance = await DecisionInstance.findOne({ instanceId });
        
        if (!instance) {
            instance = {
                instanceId,
                installId,
                SiteId: siteId,
                evaluation_period: 24,
                text_type: 'Anything'
            };
        }

        const eloquaService = new EloquaService(installId, siteId);
        const custom_objects = await eloquaService.getCustomObjects('', 100);

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
        const { instanceId } = req.query;
        const { instance: instanceData } = req.body;

        logger.info('Saving decision configuration', { instanceId });

        let instance = await DecisionInstance.findOne({ instanceId });
        
        if (!instance) {
            instance = new DecisionInstance({ 
                instanceId, 
                ...instanceData 
            });
        } else {
            Object.assign(instance, instanceData);
        }

        await instance.save();

        logger.info('Decision configuration saved', { instanceId });

        res.json({
            success: true,
            message: 'Configuration saved successfully'
        });
    });

    /**
     * Notify (Evaluate decision)
     * POST /eloqua/decision/notify
     */
    static notify = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;
        const executionData = req.body;

        logger.info('Decision notify received', { 
            instanceId, 
            recordCount: executionData.records?.length || 0 
        });

        const instance = await DecisionInstance.findOne({ instanceId });
        if (!instance) {
            return res.status(404).json({ error: 'Instance not found' });
        }

        const consumer = await Consumer.findOne({ installId: instance.installId });
        if (!consumer) {
            return res.status(404).json({ error: 'Consumer not found' });
        }

        // Evaluate decision for each contact
        const results = await DecisionController.evaluateDecision(
            instance, 
            consumer, 
            executionData
        );

        logger.info('Decision notify completed', { 
            instanceId,
            yesCount: results.filter(r => r.decision === 'YES').length,
            noCount: results.filter(r => r.decision === 'NO').length
        });

        res.json({
            success: true,
            results
        });
    });

    /**
     * Evaluate decision
     */
    static async evaluateDecision(instance, consumer, executionData) {
        const eloquaService = new EloquaService(
            instance.installId,
            instance.SiteId
        );

        const results = [];
        const evaluationCutoff = moment()
            .subtract(instance.evaluation_period, 'hours')
            .toDate();

        const records = executionData.records || [];

        for (const record of records) {
            try {
                const mobileNumber = record.mobileNumber || record.Mobile || '';
                const emailAddress = record.emailAddress || '';

                if (!mobileNumber && !emailAddress) {
                    results.push({
                        contactId: record.contactId,
                        decision: 'NO',
                        reason: 'No mobile number or email provided'
                    });
                    continue;
                }

                // Find sent SMS within evaluation period
                const query = {
                    installId: instance.installId,
                    createdAt: { $gte: evaluationCutoff }
                };

                if (mobileNumber) {
                    query.mobileNumber = mobileNumber;
                } else if (emailAddress) {
                    query.emailAddress = emailAddress;
                }

                const sentSms = await SmsLog.find(query)
                    .sort({ createdAt: -1 })
                    .limit(10);

                if (sentSms.length === 0) {
                    await instance.recordEvaluation(false);
                    
                    results.push({
                        contactId: record.contactId,
                        decision: 'NO',
                        reason: 'No SMS found in evaluation period'
                    });
                    continue;
                }

                // Check for replies
                const smsIds = sentSms.map(sms => sms._id);
                const replies = await SmsReply.find({
                    smsLogId: { $in: smsIds },
                    receivedAt: { $gte: evaluationCutoff }
                }).sort({ receivedAt: -1 });

                let hasValidReply = false;
                let replyMessage = '';
                let matchedKeyword = false;

                if (replies.length > 0) {
                    if (instance.text_type === 'Keyword' && instance.keyword) {
                        // Check if any reply contains the keyword
                        const keyword = instance.keyword.toLowerCase().trim();
                        
                        for (const reply of replies) {
                            const message = reply.message.toLowerCase().trim();
                            if (message.includes(keyword) || message === keyword) {
                                hasValidReply = true;
                                replyMessage = reply.message;
                                matchedKeyword = true;
                                break;
                            }
                        }
                    } else {
                        // Any reply counts
                        hasValidReply = true;
                        replyMessage = replies[0].message;
                    }
                }

                // Update custom object if configured and has valid reply
                if (hasValidReply && instance.custom_object_id) {
                    await DecisionController.updateCustomObject(
                        eloquaService,
                        instance,
                        record,
                        replyMessage,
                        mobileNumber
                    );
                }

                // Record evaluation
                await instance.recordEvaluation(hasValidReply);

                const decision = hasValidReply ? 'YES' : 'NO';
                
                results.push({
                    contactId: record.contactId,
                    decision,
                    hasReply: hasValidReply,
                    replyCount: replies.length,
                    replyMessage: hasValidReply ? replyMessage : '',
                    matchedKeyword,
                    evaluatedSmsCount: sentSms.length
                });

                logger.debug('Decision evaluated', {
                    contactId: record.contactId,
                    decision,
                    repliesFound: replies.length
                });

            } catch (error) {
                logger.error('Error evaluating decision for contact', {
                    contactId: record.contactId,
                    error: error.message
                });

                results.push({
                    contactId: record.contactId,
                    decision: 'NO',
                    error: error.message
                });
            }
        }

        return results;
    }

    /**
     * Update custom object with reply data
     */
    static async updateCustomObject(eloquaService, instance, record, replyMessage, mobileNumber) {
        try {
            const cdoData = {
                fieldValues: []
            };

            if (instance.mobile_field) {
                cdoData.fieldValues.push({
                    id: instance.mobile_field,
                    value: mobileNumber
                });
            }

            if (instance.email_field) {
                cdoData.fieldValues.push({
                    id: instance.email_field,
                    value: record.emailAddress || ''
                });
            }

            if (instance.response_field) {
                cdoData.fieldValues.push({
                    id: instance.response_field,
                    value: replyMessage
                });
            }

            if (instance.title_field) {
                cdoData.fieldValues.push({
                    id: instance.title_field,
                    value: 'SMS Reply Received'
                });
            }

            await eloquaService.createCustomObjectRecord(
                instance.custom_object_id, 
                cdoData
            );

            logger.debug('Custom object updated with reply', {
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
     * POST /eloqua/decision/copy
     */
    static copy = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;
        const newInstanceId = generateId();

        logger.info('Copying decision instance', { instanceId, newInstanceId });

        const instance = await DecisionInstance.findOne({ instanceId });
        if (!instance) {
            return res.status(404).json({ error: 'Instance not found' });
        }

        const newInstance = new DecisionInstance({
            ...instance.toObject(),
            _id: undefined,
            instanceId: newInstanceId,
            totalEvaluations: 0,
            totalRepliesFound: 0,
            lastExecutedAt: undefined,
            createdAt: undefined,
            updatedAt: undefined
        });

        await newInstance.save();

        logger.info('Decision instance copied', { newInstanceId });

        res.json({
            success: true,
            instanceId: newInstanceId
        });
    });

    /**
     * Delete instance
     * POST /eloqua/decision/delete
     */
    static delete = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;

        logger.info('Deleting decision instance', { instanceId });

        await DecisionInstance.findOneAndUpdate(
            { instanceId },
            { isActive: false }
        );

        logger.info('Decision instance deleted', { instanceId });

        res.json({
            success: true,
            message: 'Instance deleted successfully'
        });
    });
}

module.exports = DecisionController;