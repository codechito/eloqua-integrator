const { Consumer, ActionInstance, SmsJob, SmsLog } = require('../models');
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
        const { installId, siteId, assetId, assetName, assetType } = req.query;
        const instanceId = generateId();

        logger.info('Creating action instance', { 
            installId, 
            instanceId,
            assetType 
        });

        const instance = new ActionInstance({
            instanceId,
            installId,
            SiteId: siteId,
            assetId,
            assetName,
            entity_type: assetType, // Campaign or Program
            message: '',
            recipient_field: 'MobilePhone',
            country_field: 'Country',
            country_setting: 'cc', // cc = contact country
            message_expiry: 'NO',
            message_validity: 1,
            send_mode: 'all',
            requiresConfiguration: true
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
        const { installId, siteId, instanceId, CustomObjectId, AssetType } = req.query;

        logger.info('Loading action configuration page', { 
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

        if (CustomObjectId) {
            instance.program_coid = CustomObjectId;
        }

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
            await eloquaService.initialize();
            custom_objects = await eloquaService.getCustomObjects('', 100);
        } catch (error) {
            logger.warn('Could not fetch custom objects', { error: error.message });
        }

        // Get contact fields using Bulk API (has proper internalName)
        let merge_fields = [];
        try {
            const eloquaService = new EloquaService(installId, siteId);
            await eloquaService.initialize();
            
            const contactFieldsResponse = await eloquaService.getContactFields(1000);
            merge_fields = contactFieldsResponse.items || [];

            // **CRITICAL: Validate that fields have internalName**
            merge_fields = merge_fields.filter(field => {
                if (!field.internalName) {
                    logger.warn('Contact field missing internalName', { 
                        fieldId: field.id, 
                        fieldName: field.name 
                    });
                    return false;
                }
                return true;
            });

            logger.info('Contact fields loaded and validated', {
                count: merge_fields.length,
                sampleField: merge_fields[0] ? {
                    id: merge_fields[0].id,
                    name: merge_fields[0].name,
                    internalName: merge_fields[0].internalName
                } : null
            });

        } catch (error) {
            logger.error('Failed to fetch contact fields', { 
                error: error.message,
                stack: error.stack
            });
            
            // Fallback fields
            merge_fields = [
                { id: 'EmailAddress', name: 'Email Address', internalName: 'EmailAddress', dataType: 'string' },
                { id: 'FirstName', name: 'First Name', internalName: 'FirstName', dataType: 'string' },
                { id: 'LastName', name: 'Last Name', internalName: 'LastName', dataType: 'string' },
                { id: 'MobilePhone', name: 'Mobile Phone', internalName: 'MobilePhone', dataType: 'string' },
                { id: 'Country', name: 'Country', internalName: 'Country', dataType: 'string' }
            ];
        }

        // If Program, get CDO fields
        let fields = merge_fields;
        
        if (instance.program_coid) {
            try {
                const eloquaService = new EloquaService(installId, siteId);
                await eloquaService.initialize();
                const programCDO = await eloquaService.getCustomObject(instance.program_coid);
                
                if (programCDO.fields) {
                    fields = programCDO.fields.filter(field => {
                        if (!field.internalName) {
                            logger.warn('CDO field missing internalName', { 
                                fieldId: field.id, 
                                fieldName: field.name 
                            });
                            return false;
                        }
                        return true;
                    });

                    logger.info('Program CDO fields loaded', {
                        program_coid: instance.program_coid,
                        fieldCount: fields.length,
                        sampleField: fields[0]
                    });
                }

            } catch (error) {
                logger.warn('Could not fetch program CDO fields', { 
                    error: error.message,
                    program_coid: instance.program_coid
                });
            }
        }

        // **CRITICAL LOG: Check what we're sending to frontend**
        logger.info('Fields being sent to frontend', {
            fieldCount: fields.length,
            firstField: fields[0] ? {
                id: fields[0].id,
                name: fields[0].name,
                internalName: fields[0].internalName,
                hasInternalName: !!fields[0].internalName
            } : null,
            secondField: fields[1] ? {
                id: fields[1].id,
                name: fields[1].name,
                internalName: fields[1].internalName
            } : null
        });

        res.render('action-config', {
            consumer: consumer.toObject(),
            instance,
            custom_objects,
            countries,
            sender_ids,
            merge_fields: fields
        });
    });

    /**
     * Save configuration and update Eloqua instance
     * POST /eloqua/action/configure
     */
    static saveConfiguration = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;
        const { instance: instanceData } = req.body;

        logger.info('Saving action configuration', { 
            instanceId,
            receivedData: {
                recipient_field: instanceData.recipient_field,
                country_field: instanceData.country_field,
                message: instanceData.message?.substring(0, 50) + '...'
            }
        });

        let instance = await ActionInstance.findOne({ instanceId });
        
        if (!instance) {
            instance = new ActionInstance({ 
                instanceId, 
                ...instanceData 
            });
        } else {
            Object.assign(instance, instanceData);
        }

        // Mark configuration date
        instance.configureAt = new Date();

        // Check if configuration is complete
        const isConfigured = ActionController.validateConfiguration(instance);
        instance.requiresConfiguration = !isConfigured;

        await instance.save();

        // **ADD DEBUG LOG - Check what was actually saved**
        logger.info('Instance saved to database', {
            instanceId: instance.instanceId,
            recipient_field: instance.recipient_field,
            country_field: instance.country_field,
            message: instance.message?.substring(0, 50)
        });

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
        if (!instance.message || !instance.message.trim()) {
            return false;
        }

        if (!instance.recipient_field) {
            return false;
        }

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
            await eloquaService.initialize();

            logger.info('Eloqua service initialized, building recordDefinition', {
                instanceId: instance.instanceId
            });

            const recordDefinition = await ActionController.buildRecordDefinition(instance, eloquaService);

            const updatePayload = {
                recordDefinition: recordDefinition,
                requiresConfiguration: instance.requiresConfiguration
            };

            logger.info('Updating Eloqua instance with payload', {
                instanceId: instance.instanceId,
                recordDefinition,
                requiresConfiguration: instance.requiresConfiguration
            });

            await eloquaService.updateActionInstance(instance.instanceId, updatePayload);

            logger.info('Eloqua instance updated successfully', {
                instanceId: instance.instanceId
            });

        } catch (error) {
            logger.error('Error updating Eloqua instance', {
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
    static async buildRecordDefinition(instance, eloquaService = null) {
        const recordDefinition = {};

        logger.info('Building recordDefinition - START', {
            instanceId: instance.instanceId,
            hasProgramCDO: !!instance.program_coid,
            recipientField: instance.recipient_field,
            countryField: instance.country_field,
            hasMessage: !!instance.message
        });

        // If using program CDO, add placeholder ContactID and EmailAddress
        if (instance.program_coid) {
            recordDefinition.ContactID = "{{CustomObject.Contact.Id}}";
            recordDefinition.EmailAddress = "{{CustomObject.Contact.EmailAddress}}";
        }

        // Handle dynamic sender ID (caller_id with ## prefix)
        if (instance.caller_id && instance.caller_id.toString().indexOf("##") !== -1) {
            const fieldName = instance.caller_id.split("##")[1];
            if (fieldName) {
                // Remove C_ prefix if exists
                const cleanFieldName = fieldName.replace(/^C_/, '');
                recordDefinition[cleanFieldName] = `{{Contact.Field(C_${cleanFieldName})}}`;
            }
        }

        // Handle recipient field (mobile number)
        if (instance.recipient_field) {
            const recipientParts = instance.recipient_field.split("__");
            let recipientFieldId = null;
            let recipientFieldName = null;
            
            if (recipientParts.length > 1) {
                recipientFieldId = recipientParts[0];
                recipientFieldName = recipientParts[1];
            } else {
                recipientFieldName = recipientParts[0];
            }
            
            // Remove C_ prefix if it exists in the field name
            if (recipientFieldName) {
                recipientFieldName = recipientFieldName.replace(/^C_/, '');
            }
            
            // Skip if invalid
            if (!recipientFieldName || recipientFieldName === 'undefined') {
                logger.warn('Recipient field has invalid name', { 
                    recipient_field: instance.recipient_field 
                });
                recipientFieldName = 'MobilePhone';
            }
            
            if (instance.program_coid && recipientFieldId && !isNaN(recipientFieldId)) {
                // Program with numeric CDO field ID
                recordDefinition[recipientFieldName] = `{{CustomObject[${instance.program_coid}].Field[${recipientFieldId}]}}`;
                logger.debug('Added recipient as CDO field', {
                    key: recipientFieldName,
                    value: recordDefinition[recipientFieldName]
                });
            } else if (instance.program_coid) {
                // Program with contact field
                recordDefinition[recipientFieldName] = `{{CustomObject[${instance.program_coid}].Contact.Field(C_${recipientFieldName})}}`;
                logger.debug('Added recipient as program contact field', {
                    key: recipientFieldName,
                    value: recordDefinition[recipientFieldName]
                });
            } else {
                // Regular campaign - contact field
                recordDefinition[recipientFieldName] = `{{Contact.Field(C_${recipientFieldName})}}`;
                logger.debug('Added recipient as contact field', {
                    key: recipientFieldName,
                    value: recordDefinition[recipientFieldName]
                });
            }
        }

        // Handle country field
        if (instance.country_field) {
            const countryParts = instance.country_field.split("__");
            let countryFieldId = null;
            let countryFieldName = null;
            
            if (countryParts.length > 1) {
                countryFieldId = countryParts[0];
                countryFieldName = countryParts[1];
            } else {
                countryFieldName = countryParts[0];
            }
            
            // Remove C_ prefix if it exists
            if (countryFieldName) {
                countryFieldName = countryFieldName.replace(/^C_/, '');
            }
            
            // Skip if invalid
            if (!countryFieldName || countryFieldName === 'undefined') {
                logger.warn('Country field has invalid name', { 
                    country_field: instance.country_field 
                });
                countryFieldName = 'Country';
            }
            
            if (instance.program_coid) {
                if (instance.country_setting === 'cc' || countryFieldName === 'Country') {
                    // Contact country field
                    recordDefinition[countryFieldName] = `{{CustomObject[${instance.program_coid}].Contact.Field(C_${countryFieldName})}}`;
                    logger.debug('Added country as program contact field', {
                        key: countryFieldName,
                        value: recordDefinition[countryFieldName]
                    });
                } else if (countryFieldId && !isNaN(countryFieldId)) {
                    // CDO field with numeric ID
                    recordDefinition[countryFieldName] = `{{CustomObject[${instance.program_coid}].Field[${countryFieldId}]}}`;
                    logger.debug('Added country as CDO field', {
                        key: countryFieldName,
                        value: recordDefinition[countryFieldName]
                    });
                } else {
                    // CDO field without numeric ID
                    recordDefinition[countryFieldName] = `{{CustomObject[${instance.program_coid}].Contact.Field(C_${countryFieldName})}}`;
                    logger.debug('Added country as program contact field fallback', {
                        key: countryFieldName,
                        value: recordDefinition[countryFieldName]
                    });
                }
            } else {
                // Regular campaign - contact field
                recordDefinition[countryFieldName] = `{{Contact.Field(C_${countryFieldName})}}`;
                logger.debug('Added country as contact field', {
                    key: countryFieldName,
                    value: recordDefinition[countryFieldName]
                });
            }
        }

        // Add Id field if using program CDO
        if (instance.program_coid) {
            recordDefinition["Id"] = "{{CustomObject.Id}}";
        }

        // Extract merge fields from message [FieldName]
        const templatedFields = instance.message ? instance.message.match(/\[([^\]]+)\]/g) : null;
        if (templatedFields) {
            templatedFields.forEach(function(field) {
                const fieldName = field.replace(/[\[\]]/g, '');
                
                // Skip special fields
                if (fieldName.indexOf("tracked-link") !== -1 || fieldName.indexOf("unsub-reply-link") !== -1) {
                    return;
                }

                // Remove C_ prefix if exists
                let cleanFieldName = fieldName.replace(/^C_/, '');
                
                // Skip if invalid
                if (!cleanFieldName || cleanFieldName === 'undefined') {
                    return;
                }
                
                if (!recordDefinition[cleanFieldName]) {
                    if (instance.program_coid) {
                        recordDefinition[cleanFieldName] = `{{CustomObject[${instance.program_coid}].Contact.Field(C_${cleanFieldName})}}`;
                    } else {
                        recordDefinition[cleanFieldName] = `{{Contact.Field(C_${cleanFieldName})}}`;
                    }
                    logger.debug('Added merge field from message', {
                        key: cleanFieldName,
                        value: recordDefinition[cleanFieldName]
                    });
                }
            });
        }

        // Extract merge fields from tracked link URL [FieldName]
        const trackedLinkFields = instance.tracked_link ? instance.tracked_link.match(/\[([^\]]+)\]/g) : null;
        if (trackedLinkFields) {
            trackedLinkFields.forEach(function(field) {
                const fieldName = field.replace(/[\[\]]/g, '');
                
                // Remove C_ prefix if exists
                let cleanFieldName = fieldName.replace(/^C_/, '');
                
                // Skip if invalid
                if (!cleanFieldName || cleanFieldName === 'undefined') {
                    return;
                }
                
                if (!recordDefinition[cleanFieldName]) {
                    if (instance.program_coid) {
                        recordDefinition[cleanFieldName] = `{{CustomObject[${instance.program_coid}].Contact.Field(C_${cleanFieldName})}}`;
                    } else {
                        recordDefinition[cleanFieldName] = `{{Contact.Field(C_${cleanFieldName})}}`;
                    }
                    logger.debug('Added merge field from tracked link', {
                        key: cleanFieldName,
                        value: recordDefinition[cleanFieldName]
                    });
                }
            });
        }

        logger.info('RecordDefinition built - COMPLETE', {
            instanceId: instance.instanceId,
            recordDefinition,
            fieldCount: Object.keys(recordDefinition).length,
            keys: Object.keys(recordDefinition)
        });

        return recordDefinition;
    }

    /**
 * Notify (Execute action) - Queue SMS jobs
 * POST /eloqua/action/notify
 */
static notify = asyncHandler(async (req, res) => {
    const instanceId = req.query.instanceId || req.params.instanceId;
    const installId = req.query.installId || req.params.installId;
    const assetId = req.query.AssetId || req.params.assetId;
    const executionId = req.query.ExecutionId || req.params.executionId;
    const siteId = req.query.siteId || req.params.SiteId;
    
    const executionData = req.body;

    logger.info('Action notify received', { 
        instanceId, 
        installId,
        assetId,
        executionId,
        recordCount: executionData.items?.length || 0,
        hasMore: executionData.hasMore
    });

    // Log sample record to see actual structure
    if (executionData.items && executionData.items.length > 0) {
        logger.debug('Sample record from Eloqua', {
            instanceId,
            sampleRecord: executionData.items[0],
            recordKeys: Object.keys(executionData.items[0])
        });
    }

    // Process asynchronously
    ActionController.processNotifyAsync(
        instanceId, 
        installId, 
        siteId,
        assetId,
        executionId,
        executionData
    ).catch(error => {
        logger.error('Async notify processing failed', {
            instanceId,
            error: error.message,
            stack: error.stack
        });
    });

    // Return response after 10 second delay (like old code)
    setTimeout(() => {
        res.status(200).json({
            message: "SMS jobs are being processed asynchronously"
        });
    }, 10000);
});

/**
 * Process notify asynchronously
 */
static async processNotifyAsync(instanceId, installId, siteId, assetId, executionId, executionData) {
    try {
        logger.info('Starting async notify processing', {
            instanceId,
            installId,
            recordCount: executionData.items?.length || 0
        });

        const instance = await ActionInstance.findOne({ instanceId });
        if (!instance) {
            throw new Error(`Instance not found: ${instanceId}`);
        }

        const consumer = await Consumer.findOne({ installId })
            .select('+transmitsms_api_key +transmitsms_api_secret');
            
        if (!consumer) {
            throw new Error(`Consumer not found: ${installId}`);
        }

        if (!consumer.transmitsms_api_key || !consumer.transmitsms_api_secret) {
            throw new Error('TransmitSMS API not configured');
        }

        // Update instance (like old code)
        instance.asset_id = assetId || instance.assetId;
        instance.entry_date = new Date();
        await instance.save();

        // Parse field names (like old code)
        let recipient_field = instance.recipient_field;
        let country_field = instance.country_field;

        if (instance.program_coid) {
            // If program CDO, parse the field names
            if (instance.recipient_field.split('__').length > 1) {
                recipient_field = instance.recipient_field.split('__')[1];
            } else {
                recipient_field = instance.recipient_field;
            }

            if (instance.country_setting === 'cc') {
                country_field = instance.country_field;
            } else {
                if (instance.country_field.split('__').length > 1) {
                    country_field = instance.country_field.split('__')[1];
                } else {
                    country_field = instance.country_field;
                }
            }
        }

        // Remove C_ prefix for field lookup (like old code does with field.replace("C_", ""))
        recipient_field = recipient_field.replace(/^C_/, '');
        country_field = country_field.replace(/^C_/, '');

        logger.debug('Parsed field names', {
            recipient_field,
            country_field,
            hasProgramCoid: !!instance.program_coid
        });

        // Process items (enrich with message and tracked_link_url)
        executionData.items.forEach(item => {
            item.message = instance.message;
            item.tracked_link_url = instance.tracked_link;
            
            // Set default country if not present
            if (!item.Country) {
                item.Country = consumer.default_country;
            }
            
            item.recipient_field = recipient_field;
            item.country_field = country_field;

            // Replace merge fields in message [FieldName] format
            const templated_fields = item.message.match(/[^[\]]+(?=])/g);
            if (templated_fields) {
                templated_fields.forEach(field => {
                    // Skip special fields
                    if (field.indexOf("tracked-link") === -1 && field.indexOf("unsub-reply-link") === -1) {
                        const nfield = "\\[" + field + "\\]";
                        const msgrgex = new RegExp(nfield, "g");
                        
                        // Remove C_ prefix and get value from item
                        const cleanFieldName = field.replace("C_", "");
                        const fieldValue = item[cleanFieldName] || '';
                        
                        item.message = item.message.replace(msgrgex, fieldValue);
                        
                        logger.debug('Replaced merge field in message', {
                            field,
                            cleanFieldName,
                            value: fieldValue ? fieldValue.substring(0, 20) : '(empty)'
                        });
                    }
                });
            }

            // Replace merge fields in tracked link URL
            if (item.tracked_link_url) {
                const link_templated_fields = item.tracked_link_url.match(/[^[\]]+(?=])/g);
                if (link_templated_fields) {
                    link_templated_fields.forEach(field => {
                        const nfield = "\\[" + field + "\\]";
                        const msgrgex = new RegExp(nfield, "g");
                        
                        const cleanFieldName = field.replace("C_", "");
                        const fieldValue = item[cleanFieldName] || '';
                        
                        item.tracked_link_url = item.tracked_link_url.replace(msgrgex, fieldValue);
                    });
                }
            }
        });

        logger.info('Items enriched with message data', {
            itemCount: executionData.items.length,
            sampleMessage: executionData.items[0]?.message?.substring(0, 50)
        });

        // Queue SMS jobs
        const results = await ActionController.queueSmsJobs(
            instance, 
            consumer, 
            executionData
        );

        const successCount = results.filter(r => r.success).length;
        const failCount = results.filter(r => !r.success).length;

        logger.info('Async notify processing completed', { 
            instanceId,
            executionId,
            totalRecords: results.length,
            successCount,
            failCount
        });

        return {
            success: true,
            successCount,
            failCount
        };

    } catch (error) {
        logger.error('Async notify processing error', {
            instanceId,
            installId,
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
}

/**
 * Queue SMS jobs for background processing
 * Items are already enriched with message and merge field data
 */
static async queueSmsJobs(instance, consumer, executionData) {
    const results = [];
    const items = executionData.items || [];
    const baseUrl = process.env.APP_BASE_URL || 'https://eloqua-integrator.onrender.com';

    logger.info('Queueing SMS jobs', {
        instanceId: instance.instanceId,
        itemCount: items.length
    });

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        
        try {
            // Get mobile number (already parsed field name stored in item)
            const mobileNumber = item[item.recipient_field] || item.MobilePhone;

            if (!mobileNumber) {
                logger.warn('Item has no mobile number', {
                    contactId: item.ContactID || item.Id,
                    recipient_field: item.recipient_field,
                    availableFields: Object.keys(item)
                });
                
                results.push({
                    contactId: item.ContactID || item.Id,
                    success: false,
                    error: 'Mobile number not found'
                });
                continue;
            }

            // Get country
            const country = item[item.country_field] || item.Country || consumer.default_country || 'Australia';

            // Format phone number
            const formattedNumber = formatPhoneNumber(mobileNumber, country);

            logger.debug('Processing item for SMS', {
                index: i + 1,
                total: items.length,
                contactId: item.ContactID || item.Id,
                mobileNumber: mobileNumber,
                formattedNumber: formattedNumber,
                messagePreview: item.message?.substring(0, 50) + '...'
            });

            // Message is already processed and merged
            const message = item.message;
            const trackedLinkUrl = item.tracked_link_url;

            // Determine sender ID
            let senderId = instance.caller_id;
            if (senderId && senderId.startsWith('##')) {
                const senderFieldName = senderId.replace('##', '').replace(/^C_/, '');
                senderId = item[senderFieldName] || instance.caller_id;
            }

            // Build callback URLs
            const callbackParams = new URLSearchParams({
                installId: instance.installId,
                instanceId: instance.instanceId,
                contactId: item.ContactID || item.Id,
                emailAddress: item.EmailAddress || '',
                campaignId: instance.assetId || ''
            }).toString();

            // Build SMS options
            const smsOptions = {
                from: senderId || undefined
            };

            if (instance.message_expiry === 'YES' && instance.message_validity) {
                smsOptions.validity = parseInt(instance.message_validity) * 60;
            }

            // Add tracked link if message contains [tracked-link] placeholder
            if (message.includes('[tracked-link]') && trackedLinkUrl) {
                smsOptions.tracked_link_url = trackedLinkUrl;
            }

            // Add callback URLs (replace http with https like old code)
            if (consumer.dlr_callback) {
                const dlrUrl = consumer.dlr_callback.replace('http:', 'https:');
                smsOptions.dlr_callback = `${dlrUrl}?${callbackParams}`;
            }

            if (consumer.reply_callback) {
                const replyUrl = consumer.reply_callback.replace('http:', 'https:');
                smsOptions.reply_callback = `${replyUrl}?${callbackParams}`;
            }

            if (consumer.link_hits_callback) {
                const linkUrl = consumer.link_hits_callback.replace('http:', 'https:');
                smsOptions.link_hits_callback = `${linkUrl}?${callbackParams}`;
            }

            // Prepare custom object data if configured
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
                recordData: item
            } : null;

            // Create SMS job
            const jobId = generateId();
            const smsJob = new SmsJob({
                jobId,
                installId: instance.installId,
                instanceId: instance.instanceId,
                contactId: item.ContactID || item.Id,
                emailAddress: item.EmailAddress || '',
                mobileNumber: formattedNumber,
                message,
                senderId: senderId,
                campaignId: instance.assetId,
                campaignTitle: instance.assetName,
                assetName: instance.assetName,
                smsOptions,
                customObjectData,
                status: 'pending',
                scheduledAt: new Date()
            });

            await smsJob.save();

            logger.info('SMS job created', {
                jobId,
                contactId: item.ContactID || item.Id,
                to: formattedNumber
            });

            results.push({
                contactId: item.ContactID || item.Id,
                success: true,
                jobId: jobId
            });

        } catch (error) {
            logger.error('Error creating SMS job', {
                instanceId: instance.instanceId,
                contactId: item.ContactID || item.Id,
                error: error.message,
                stack: error.stack
            });

            results.push({
                contactId: item.ContactID || item.Id,
                success: false,
                error: error.message
            });
        }
    }

    logger.info('SMS job queueing completed', {
        instanceId: instance.instanceId,
        total: results.length,
        success: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length
    });

    return results;
}

    /**
     * Process a single SMS job (called by worker)
     */
    static async processSmsJob(job) {
        try {
            await job.markAsProcessing();

            logger.info('Processing SMS job', {
                jobId: job.jobId,
                contactId: job.contactId,
                to: job.mobileNumber
            });

            const consumer = await Consumer.findOne({ installId: job.installId })
                .select('+transmitsms_api_key +transmitsms_api_secret');

            if (!consumer || !consumer.transmitsms_api_key) {
                throw new Error('Consumer credentials not found');
            }

            const smsService = new TransmitSmsService(
                consumer.transmitsms_api_key,
                consumer.transmitsms_api_secret
            );

            const smsResponse = await smsService.sendSms(
                job.mobileNumber,
                job.message,
                job.smsOptions
            );

            await job.markAsSent(smsResponse.message_id, smsResponse);

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

            job.smsLogId = smsLog._id;
            await job.save();

            if (job.customObjectData && job.customObjectData.customObjectId) {
                const instance = await ActionInstance.findOne({ instanceId: job.instanceId });
                if (instance) {
                    const eloquaService = new EloquaService(job.installId, instance.SiteId);
                    await eloquaService.initialize();
                    await ActionController.updateCustomObjectForJob(
                        eloquaService,
                        job,
                        smsLog
                    );
                }
            }

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

            await job.markAsFailed(error.message, error.code);

            const instance = await ActionInstance.findOne({ instanceId: job.instanceId });
            if (instance) {
                await instance.incrementFailed();
            }

            if (job.canRetry()) {
                await job.resetForRetry();
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
     * Retrieve instance configuration
     * GET /eloqua/action/retrieve
     */
    static retrieve = asyncHandler(async (req, res) => {
        const { instanceId, installId, SiteId } = req.query;

        logger.info('Retrieving action instance', { 
            instanceId, 
            installId, 
            SiteId 
        });

        const instance = await ActionInstance.findOne({
            instanceId,
            installId,
            SiteId,
            serviceType: 'action'
        });

        if (!instance) {
            return res.status(404).json({
                error: 'Instance not found'
            });
        }

        res.json({
            success: true,
            instance
        });
    });

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
            requiresConfiguration: true
        });

        await newInstance.save();

        logger.info('Action instance copied', { newInstanceId });

        res.json({
            success: true,
            instanceId: newInstanceId
        });
    });

    /**
     * Delete/Remove instance
     * POST /eloqua/action/delete or /eloqua/action/remove
     */
    static delete = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;

        logger.info('Deleting action instance', { instanceId });

        const instance = await ActionInstance.findOne({ instanceId });

        if (!instance) {
            return res.status(404).json({
                error: 'Instance not found'
            });
        }

        instance.Status = 'removed';
        instance.RemoveAt = new Date();
        instance.isActive = false;
        await instance.save();

        logger.info('Action instance marked as removed', { instanceId });

        res.json({
            success: true,
            message: 'Instance removed successfully'
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
            hasMessage: !!message
        });

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
                description: 'TransmitSMS API credentials not configured' 
            });
        }

        try {
            const smsService = new TransmitSmsService(
                consumer.transmitsms_api_key,
                consumer.transmitsms_api_secret
            );

            const formattedNumber = formatPhoneNumber(phone, country);
            
            let finalMessage = message.trim();
            finalMessage = finalMessage.replace(/\n\n+/g, '\n\n');

            const baseUrl = process.env.APP_BASE_URL || 'https://eloqua-integrator.onrender.com';
            
            const callbackParams = new URLSearchParams({
                installId: installId,
                test: 'true',
                phone: formattedNumber
            }).toString();

            const smsOptions = {};
            
            if (caller_id) {
                smsOptions.from = caller_id;
            }

            if (finalMessage.includes('[tracked-link]') && tracked_link_url) {
                smsOptions.tracked_link_url = tracked_link_url;
            }

            if (consumer.dlr_callback) {
                smsOptions.dlr_callback = `${baseUrl}/webhooks/dlr?${callbackParams}`;
            }

            if (consumer.reply_callback) {
                smsOptions.reply_callback = `${baseUrl}/webhooks/reply?${callbackParams}`;
            }

            if (consumer.link_hits_callback) {
                smsOptions.link_hits_callback = `${baseUrl}/webhooks/linkhit?${callbackParams}`;
            }

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
                response
            });

        } catch (error) {
            logger.error('Error sending test SMS', {
                error: error.message,
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
     * Get custom objects (AJAX)
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

        try {
            const eloquaService = new EloquaService(installId, siteId);
            await eloquaService.initialize();
            
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

            res.json({
                elements: [],
                total: 0,
                error: error.message
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

        try {
            const eloquaService = new EloquaService(installId, siteId);
            await eloquaService.initialize();
            
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

            res.json({
                id: customObjectId,
                fields: [],
                error: error.message
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

        try {
            const eloquaService = new EloquaService(installId, siteId);
            await eloquaService.initialize();
            
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

            res.json({
                items: [],
                total: 0,
                error: error.message
            });
        }
    });

    /**
     * Get SMS Worker Status
     * GET /eloqua/action/worker/status
     */
    static getWorkerStatus = asyncHandler(async (req, res) => {
        const { installId } = req.query;

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

    /**
     * Get worker health
     * GET /eloqua/action/worker/health
     */
    static getWorkerHealth = asyncHandler(async (req, res) => {
        const pendingCount = await SmsJob.countDocuments({ status: 'pending' });
        const processingCount = await SmsJob.countDocuments({ status: 'processing' });
        const stuckCount = await SmsJob.countDocuments({
            status: 'processing',
            processingStartedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) }
        });

        const workerStats = global.smsWorker ? await global.smsWorker.getStats() : null;

        res.json({
            success: true,
            queue: {
                pending: pendingCount,
                processing: processingCount,
                stuck: stuckCount
            },
            worker: workerStats || { status: 'not available' }
        });
    });

    /**
     * Helper: Parse field name from "fieldId__fieldName" or "fieldName" format
     */
    static parseFieldName(fieldValue) {
        if (!fieldValue) return null;
        
        const parts = fieldValue.split('__');
        return parts.length > 1 ? parts[1] : parts[0];
    }
}

module.exports = ActionController;