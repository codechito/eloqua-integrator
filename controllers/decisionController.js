const DecisionInstance = require('../models/DecisionInstance');
const Consumer = require('../models/Consumer');
const SmsLog = require('../models/SmsLog');
const Reply = require('../models/SmsReply');
const { EloquaService } = require('../services');
const { logger, generateId } = require('../utils');
const { asyncHandler } = require('../middleware');

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
        const { installId, siteId, instanceId } = req.query;

        logger.info('Loading decision configuration page', { installId, instanceId });

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

        // Get custom objects
        let custom_objects = { elements: [] };
        try {
            const eloquaService = new EloquaService(installId, siteId);
            custom_objects = await eloquaService.getCustomObjects('', 100);
        } catch (error) {
            logger.warn('Could not fetch custom objects', { error: error.message });
        }

        res.render('decision-config', {
            consumer: consumer.toObject(),
            instance,
            custom_objects
        });
    });

    /**
     * Save configuration and update Eloqua instance
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

        // Check if configuration is complete
        const isConfigured = DecisionController.validateConfiguration(instance);
        instance.requiresConfiguration = !isConfigured;

        await instance.save();

        logger.info('Decision configuration saved', { 
            instanceId,
            requiresConfiguration: instance.requiresConfiguration
        });

        // Update Eloqua instance with recordDefinition
        try {
            await DecisionController.updateEloquaInstance(instance);
            
            logger.info('Eloqua decision instance updated successfully', { instanceId });

            res.json({
                success: true,
                message: 'Configuration saved successfully',
                requiresConfiguration: instance.requiresConfiguration
            });

        } catch (error) {
            logger.error('Failed to update Eloqua decision instance', {
                instanceId,
                error: error.message
            });

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
        if (!instance.evaluation_period || instance.evaluation_period < 1) {
            return false;
        }

        if (!instance.text_type) {
            return false;
        }

        // If keyword type is selected, keyword is required
        if (instance.text_type === 'Keyword' && (!instance.keyword || !instance.keyword.trim())) {
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
     * Update Eloqua decision instance with recordDefinition
     */
    static async updateEloquaInstance(instance) {
        try {
            const eloquaService = new EloquaService(instance.installId, instance.SiteId);

            // Build recordDefinition based on configuration
            const recordDefinition = await DecisionController.buildRecordDefinition(instance);

            // Prepare update payload
            const updatePayload = {
                recordDefinition: recordDefinition,
                requiresConfiguration: instance.requiresConfiguration
            };

            logger.info('Updating Eloqua decision instance', {
                instanceId: instance.instanceId,
                recordDefinition,
                requiresConfiguration: instance.requiresConfiguration
            });

            // Call Eloqua API to update instance
            await eloquaService.updateDecisionInstance(instance.instanceId, updatePayload);

            logger.info('Eloqua decision instance updated', {
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
     * Build recordDefinition object for Eloqua
     */
    static async buildRecordDefinition(instance) {
        const recordDefinition = {};

        // Always include contact basic fields
        recordDefinition.ContactID = 'ContactID';
        recordDefinition.EmailAddress = 'EmailAddress';

        // Add custom object fields if configured
        if (instance.custom_object_id) {
            const eloquaService = new EloquaService(instance.installId, instance.SiteId);
            
            try {
                // Get custom object details to get field names
                const customObject = await eloquaService.getCustomObject(instance.custom_object_id);
                
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

                if (instance.response_field) {
                    const field = customObject.fields.find(f => f.internalName === instance.response_field);
                    recordDefinition[field?.name || 'Response'] = instance.response_field;
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
                if (instance.response_field) recordDefinition.Response = instance.response_field;
                if (instance.vn_field) recordDefinition.VirtualNumber = instance.vn_field;
            }
        }

        logger.debug('Built recordDefinition for decision', {
            instanceId: instance.instanceId,
            recordDefinition
        });

        return recordDefinition;
    }

    /**
     * Notify (Execute decision) - Check for SMS replies
     * POST /eloqua/decision/notify
     */
    static notify = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;
        const executionData = req.body;

        logger.info('Decision notify received', { 
            instanceId, 
            recordCount: executionData.items?.length || 0 
        });

        const instance = await DecisionInstance.findOne({ instanceId });
        if (!instance) {
            return res.status(404).json({ error: 'Instance not found' });
        }

        const results = await DecisionController.checkForReplies(
            instance,
            executionData
        );

        logger.info('Decision notify completed', { 
            instanceId, 
            foundReplies: results.filter(r => r.hasReply).length,
            noReplies: results.filter(r => !r.hasReply).length
        });

        res.json({
            success: true,
            results
        });
    });

    /**
     * Check for SMS replies for each contact
     */
    static async checkForReplies(instance, executionData) {
        const results = [];
        const records = executionData.items || [];

        const cutoffTime = new Date(Date.now() - (instance.evaluation_period * 60 * 60 * 1000));

        for (const record of records) {
            try {
                const mobileNumber = DecisionController.getFieldValue(record, 'mobilePhone');
                
                if (!mobileNumber) {
                    results.push({
                        contactId: record.contactId,
                        hasReply: false,
                        reason: 'No mobile number'
                    });
                    continue;
                }

                // Find original SMS sent to this contact
                const originalSms = await SmsLog.findOne({
                    installId: instance.installId,
                    mobileNumber: mobileNumber,
                    createdAt: { $gte: cutoffTime }
                }).sort({ createdAt: -1 });

                if (!originalSms) {
                    results.push({
                        contactId: record.contactId,
                        hasReply: false,
                        reason: 'No SMS sent in evaluation period'
                    });
                    continue;
                }

                // Check for replies
                let replyQuery = {
                    smsId: originalSms._id,
                    from_mobile: mobileNumber,
                    createdAt: { $gte: cutoffTime }
                };

                // If keyword matching is enabled
                if (instance.text_type === 'Keyword' && instance.keyword) {
                    replyQuery.message = { 
                        $regex: new RegExp(instance.keyword, 'i') 
                    };
                }

                const reply = await Reply.findOne(replyQuery).sort({ createdAt: -1 });

                if (reply) {
                    // Update custom object if configured
                    if (instance.custom_object_id) {
                        const eloquaService = new EloquaService(instance.installId, instance.SiteId);
                        await DecisionController.updateCustomObject(
                            eloquaService,
                            instance,
                            record,
                            reply
                        );
                    }

                    results.push({
                        contactId: record.contactId,
                        hasReply: true,
                        replyMessage: reply.message,
                        replyTime: reply.createdAt
                    });
                } else {
                    results.push({
                        contactId: record.contactId,
                        hasReply: false,
                        reason: instance.text_type === 'Keyword' 
                            ? 'No matching keyword reply found'
                            : 'No reply found'
                    });
                }

            } catch (error) {
                logger.error('Error checking for reply', {
                    instanceId: instance.instanceId,
                    contactId: record.contactId,
                    error: error.message
                });

                results.push({
                    contactId: record.contactId,
                    hasReply: false,
                    error: error.message
                });
            }
        }

        return results;
    }

    /**
     * Update custom object with reply data
     */
    static async updateCustomObject(eloquaService, instance, record, reply) {
        try {
            const cdoData = {
                fieldValues: []
            };

            if (instance.mobile_field) {
                cdoData.fieldValues.push({
                    id: instance.mobile_field,
                    value: reply.from_mobile
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
                    value: reply.message
                });
            }

            if (instance.title_field) {
                cdoData.fieldValues.push({
                    id: instance.title_field,
                    value: 'SMS Reply Received'
                });
            }

            if (instance.vn_field && reply.to_virtual_number) {
                cdoData.fieldValues.push({
                    id: instance.vn_field,
                    value: reply.to_virtual_number
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
            logger.error('Error updating custom object with reply', {
                error: error.message,
                customObjectId: instance.custom_object_id
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
            createdAt: undefined,
            updatedAt: undefined,
            requiresConfiguration: true
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

    /**
     * Get custom objects (AJAX) with pagination and search
     * GET /eloqua/decision/ajax/customobjects/:installId/:siteId/customObject
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
     * GET /eloqua/decision/ajax/customobject/:installId/:siteId/:customObjectId
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

module.exports = DecisionController;