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
                message: instanceData.message?.substring(0, 50) + '...',
                tracked_link: instanceData.tracked_link, // ADD THIS
                caller_id: instanceData.caller_id,
                custom_object_id: instanceData.custom_object_id,
                hasTrackedLink: !!instanceData.tracked_link,
                messageHasTrackedLinkPlaceholder: instanceData.message?.includes('[tracked-link]')
            }
        });

        let instance = await ActionInstance.findOne({ instanceId });
        
        if (!instance) {
            logger.info('Creating new action instance', { instanceId });
            instance = new ActionInstance({ 
                instanceId, 
                ...instanceData 
            });
        } else {
            logger.info('Updating existing action instance', { 
                instanceId,
                existingFields: Object.keys(instance.toObject())
            });
            
            // Update all fields from instanceData
            Object.assign(instance, instanceData);
        }

        // Mark configuration date
        instance.configureAt = new Date();

        // Check if configuration is complete
        const isConfigured = ActionController.validateConfiguration(instance);
        instance.requiresConfiguration = !isConfigured;

        // **CRITICAL: Log what's about to be saved**
        logger.debug('Instance data before save', {
            instanceId: instance.instanceId,
            message: instance.message?.substring(0, 50) + '...',
            tracked_link: instance.tracked_link,
            hasTrackedLink: !!instance.tracked_link,
            recipient_field: instance.recipient_field,
            country_field: instance.country_field,
            caller_id: instance.caller_id,
            custom_object_id: instance.custom_object_id,
            messageHasPlaceholder: instance.message?.includes('[tracked-link]')
        });

        await instance.save();

        // **VERIFY what was actually saved by reloading from database**
        const savedInstance = await ActionInstance.findOne({ instanceId });
        
        logger.info('Instance saved to database (verified)', {
            instanceId: savedInstance.instanceId,
            recipient_field: savedInstance.recipient_field,
            country_field: savedInstance.country_field,
            message: savedInstance.message?.substring(0, 50) + '...',
            tracked_link: savedInstance.tracked_link,
            hasTrackedLink: !!savedInstance.tracked_link,
            caller_id: savedInstance.caller_id,
            custom_object_id: savedInstance.custom_object_id,
            messageHasPlaceholder: savedInstance.message?.includes('[tracked-link]'),
            fieldsInDB: Object.keys(savedInstance.toObject())
        });

        // **ALERT: If message has [tracked-link] but no tracked_link URL configured**
        if (savedInstance.message?.includes('[tracked-link]') && !savedInstance.tracked_link) {
            logger.warn('Message contains [tracked-link] placeholder but no tracked_link URL configured!', {
                instanceId: savedInstance.instanceId,
                messagePreview: savedInstance.message.substring(0, 100)
            });
        }

        logger.info('Action configuration saved', { 
            instanceId,
            requiresConfiguration: instance.requiresConfiguration,
            isConfigured
        });

        // Update Eloqua instance with recordDefinition
        try {
            await ActionController.updateEloquaInstance(savedInstance);
            
            logger.info('Eloqua instance updated successfully', { instanceId });

            res.json({
                success: true,
                message: 'Configuration saved successfully',
                requiresConfiguration: savedInstance.requiresConfiguration,
                debug: {
                    hasTrackedLink: !!savedInstance.tracked_link,
                    messageHasPlaceholder: savedInstance.message?.includes('[tracked-link]')
                }
            });

        } catch (error) {
            logger.error('Failed to update Eloqua instance', {
                instanceId,
                error: error.message,
                stack: error.stack
            });

            res.json({
                success: true,
                message: 'Configuration saved locally, but failed to update Eloqua',
                warning: error.message,
                requiresConfiguration: savedInstance.requiresConfiguration,
                debug: {
                    hasTrackedLink: !!savedInstance.tracked_link,
                    messageHasPlaceholder: savedInstance.message?.includes('[tracked-link]')
                }
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
     * Create bulk import to set action status to complete
     * This is called AFTER SMS is sent to tell Eloqua the contact is done
     */
    static async setActionStatusComplete(installId, siteId, instanceId, executionId, contacts) {
        try {
            const eloquaService = new EloquaService(installId, siteId);
            await eloquaService.initialize();

            // Remove dashes from instanceId for bulk API
            const instanceIdNoDashes = instanceId.replace(/-/g, '');

            // Create bulk import definition with sync action
            const importDef = {
                name: "BurstSMS Action Response Bulk Import",
                updateRule: "always",
                fields: {
                    EmailAddress: "{{Contact.Field(C_EmailAddress)}}"
                },
                syncActions: [
                    {
                        destination: `{{ActionInstance(${instanceIdNoDashes}).Execution[${executionId}]}}`,
                        action: "setStatus",
                        status: "complete"
                    }
                ],
                identifierFieldName: "EmailAddress"
            };

            logger.info('Creating bulk import for action status', {
                instanceId,
                executionId,
                contactCount: contacts.length
            });

            // Create import
            const importResponse = await eloquaService.createBulkImport('contacts', importDef);
            const importUri = importResponse.uri;

            logger.info('Bulk import created', {
                importUri,
                instanceId
            });

            // Upload contact data
            const importData = contacts.map(contact => ({
                EmailAddress: contact.emailAddress
            }));

            await eloquaService.uploadBulkImportData(importUri, importData);

            logger.info('Import data uploaded', {
                importUri,
                recordCount: importData.length
            });

            // Sync the import
            const syncResponse = await eloquaService.syncBulkImport(importUri);
            const syncUri = syncResponse.uri;

            logger.info('Bulk import synced', {
                syncUri,
                status: syncResponse.status
            });

            // Optional: Poll sync status
            // const syncStatus = await eloquaService.checkSyncStatus(syncUri);

            return {
                success: true,
                importUri,
                syncUri
            };

        } catch (error) {
            logger.error('Error setting action status', {
                instanceId,
                executionId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Update Eloqua instance with recordDefinition (fields only!)
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

            // Build recordDefinition - just the fields mapping (not full template!)
            const recordDefinition = await ActionController.buildRecordDefinition(instance, eloquaService);

            // Prepare update payload
            const updatePayload = {
                recordDefinition: recordDefinition,  // Just the fields!
                requiresConfiguration: instance.requiresConfiguration
            };

            logger.info('Updating Eloqua instance with recordDefinition', {
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
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Build recordDefinition object for Eloqua
     * Based on the old working code pattern
     */
    static async buildRecordDefinition(instance, eloquaService = null) {
        const recordDefinition = {};

        logger.debug('Building recordDefinition', {
            instanceId: instance.instanceId,
            hasProgramCDO: !!instance.program_coid,
            recipientField: instance.recipient_field,
            countryField: instance.country_field,
            message: instance.message
        });

        // ALWAYS include ContactID and EmailAddress (required!)
        if (instance.program_coid) {
            recordDefinition.ContactID = "{{CustomObject.Contact.Id}}";
            recordDefinition.EmailAddress = "{{CustomObject.Contact.Field(C_EmailAddress)}}";
        } else {
            recordDefinition.ContactID = "{{Contact.Id}}";
            recordDefinition.EmailAddress = "{{Contact.Field(C_EmailAddress)}}";
        }

        // Handle dynamic sender ID (caller_id with ## prefix)
        if (instance.caller_id && instance.caller_id.toString().indexOf("##") !== -1) {
            const fieldName = instance.caller_id.split("##")[1];
            if (!recordDefinition[fieldName]) {
                if (instance.program_coid) {
                    recordDefinition[fieldName] = `{{CustomObject[${instance.program_coid}].Contact.Field(C_${fieldName})}}`;
                } else {
                    recordDefinition[fieldName] = `{{Contact.Field(C_${fieldName})}}`;
                }
            }
        }

        // Handle recipient field (mobile number)
        if (instance.recipient_field) {
            if (instance.program_coid) {
                // Using program CDO
                const fields = instance.recipient_field.split("__");
                if (fields.length > 1) {
                    const fieldId = fields[0];
                    const fieldName = fields[1];
                    recordDefinition[fieldName] = `{{CustomObject[${instance.program_coid}].Field[${fieldId}]}}`;
                } else {
                    recordDefinition[instance.recipient_field] = `{{CustomObject[${instance.program_coid}].Contact.Field(C_${instance.recipient_field})}}`;
                }
            } else {
                // Regular contact field - parse fieldId__fieldName format
                const fields = instance.recipient_field.split("__");
                if (fields.length > 1) {
                    const fieldName = fields[1]; // Get the actual field name
                    recordDefinition[fieldName] = `{{Contact.Field(${fieldName})}}`;
                } else {
                    recordDefinition[instance.recipient_field] = `{{Contact.Field(C_${instance.recipient_field})}}`;
                }
            }
        }

        // Handle country field
        if (instance.country_field) {
            if (instance.program_coid) {
                // Using program CDO
                if (instance.country_setting === 'cc' || instance.country_field === 'Country') {
                    recordDefinition[instance.country_field] = `{{CustomObject[${instance.program_coid}].Contact.Field(C_${instance.country_field})}}`;
                } else {
                    const fields = instance.country_field.split("__");
                    if (fields.length > 1) {
                        const fieldId = fields[0];
                        const fieldName = fields[1];
                        recordDefinition[fieldName] = `{{CustomObject[${instance.program_coid}].Field[${fieldId}]}}`;
                    } else {
                        recordDefinition[instance.country_field] = `{{CustomObject[${instance.program_coid}].Contact.Field(C_${instance.country_field})}}`;
                    }
                }
            } else {
                // Regular contact field - parse fieldId__fieldName format
                const fields = instance.country_field.split("__");
                if (fields.length > 1) {
                    const fieldName = fields[1]; // Get the actual field name
                    recordDefinition[fieldName] = `{{Contact.Field(${fieldName})}}`;
                } else {
                    recordDefinition[instance.country_field] = `{{Contact.Field(C_${instance.country_field})}}`;
                }
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

                const cleanFieldName = fieldName.replace("C_", "");
                
                if (!recordDefinition[cleanFieldName]) {
                    if (instance.program_coid) {
                        recordDefinition[cleanFieldName] = `{{CustomObject[${instance.program_coid}].Contact.Field(${fieldName})}}`;
                    } else {
                        recordDefinition[cleanFieldName] = `{{Contact.Field(${fieldName})}}`;
                    }
                }
            });
        }

        // Extract merge fields from tracked link URL [FieldName]
        const trackedLinkFields = instance.tracked_link ? instance.tracked_link.match(/\[([^\]]+)\]/g) : null;
        if (trackedLinkFields) {
            trackedLinkFields.forEach(function(field) {
                const fieldName = field.replace(/[\[\]]/g, '');
                const cleanFieldName = fieldName.replace("C_", "");
                
                if (!recordDefinition[cleanFieldName]) {
                    if (instance.program_coid) {
                        recordDefinition[cleanFieldName] = `{{CustomObject[${instance.program_coid}].Contact.Field(${fieldName})}}`;
                    } else {
                        recordDefinition[cleanFieldName] = `{{Contact.Field(${fieldName})}}`;
                    }
                }
            });
        }

        logger.info('RecordDefinition built', {
            instanceId: instance.instanceId,
            recordDefinition,
            fieldCount: Object.keys(recordDefinition).length
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

        // Return 204 immediately (async processing as per docs)
        res.status(204).send();
    });

    /**
     * Enrich items with processed message and tracked link
     */
    static enrichItems(items, instance, consumer) {
        logger.debug('Enriching items', {
            recipient_field: instance.recipient_field,
            country_field: instance.country_field,
            hasProgramCoid: !!instance.program_coid,
            hasTrackedLink: !!instance.tracked_link,
            trackedLinkValue: instance.tracked_link,
            messageHasTrackedLink: instance.message?.includes('[tracked-link]')
        });

        return items.map(item => {
            // Process message - replace merge fields
            let processedMessage = instance.message;
            const mergeFields = instance.message ? instance.message.match(/\[([^\]]+)\]/g) : null;

            if (mergeFields) {
                for (const field of mergeFields) {
                    const fieldName = field.replace(/[\[\]]/g, '');

                    // Skip special fields
                    if (fieldName === 'tracked-link' || fieldName === 'unsub-reply-link') {
                        continue;
                    }

                    // Item has fields like: C_FirstName, C_MobilePhone, etc.
                    const fieldValue = item[fieldName] || item[fieldName.replace('C_', '')] || '';

                    logger.debug('Replaced merge field in message', {
                        field: fieldName,
                        value: fieldValue
                    });

                    processedMessage = processedMessage.replace(field, fieldValue);
                }
            }

            // Process tracked link URL if exists
            let processedTrackedLink = null;
            if (instance.tracked_link) {
                processedTrackedLink = instance.tracked_link;
                
                logger.debug('Processing tracked link', {
                    originalUrl: instance.tracked_link,
                    hasMergeFields: /\[([^\]]+)\]/.test(instance.tracked_link)
                });

                const linkMergeFields = instance.tracked_link.match(/\[([^\]]+)\]/g);

                if (linkMergeFields) {
                    for (const field of linkMergeFields) {
                        const fieldName = field.replace(/[\[\]]/g, '');
                        const fieldValue = item[fieldName] || item[fieldName.replace('C_', '')] || '';
                        processedTrackedLink = processedTrackedLink.replace(field, fieldValue);
                        
                        logger.debug('Replaced merge field in tracked link', {
                            field: fieldName,
                            value: fieldValue
                        });
                    }
                }

                logger.debug('Tracked link processed', {
                    contactId: item.ContactID,
                    processedUrl: processedTrackedLink
                });
            } else {
                logger.warn('Message has [tracked-link] but instance.tracked_link is not configured', {
                    contactId: item.ContactID,
                    messagePreview: processedMessage.substring(0, 100)
                });
            }

            return {
                ...item,
                message: processedMessage,
                tracked_link_url: processedTrackedLink
            };
        });
    }


    /**
     * Process notify asynchronously (creates SMS jobs)
     */
    static async processNotifyAsync(instanceId, installId, siteId, assetId, executionId, executionData) {
        try {
            logger.info('Starting async notify processing', {
                instanceId,
                installId,
                recordCount: executionData.items?.length || 0
            });

            // Get instance configuration
            const instance = await ActionInstance.findOne({
                instanceId,
                installId,
                isActive: true
            });

            if (!instance) {
                logger.error('Instance not found or inactive', { instanceId, installId });
                return;
            }

            // Get consumer configuration
            const consumer = await Consumer.findOne({ installId })
                .select('+transmitsms_api_key +transmitsms_api_secret');

            if (!consumer) {
                logger.error('Consumer not found', { installId });
                return;
            }

            // Validate TransmitSMS credentials
            if (!consumer.transmitsms_api_key || !consumer.transmitsms_api_secret) {
                logger.error('TransmitSMS credentials not configured', { installId });
                return;
            }

            // Enrich items with processed message and tracked links
            const enrichedItems = ActionController.enrichItems(
                executionData.items || [],
                instance,
                consumer
            );

            logger.info('Items enriched with message data', {
                itemCount: enrichedItems.length,
                sampleMessage: enrichedItems[0]?.message
            });

            // Queue SMS jobs (returns {success, failed, errors} object, NOT array)
            const queueResults = await ActionController.queueSmsJobs(
                instance,
                consumer,
                enrichedItems,
                executionId
            );

            // Update instance statistics
            instance.totalSent = (instance.totalSent || 0) + queueResults.success;
            instance.totalFailed = (instance.totalFailed || 0) + queueResults.failed;
            instance.lastExecutedAt = new Date();
            await instance.save();

            logger.info('Async notify processing completed', {
                instanceId,
                executionId,
                totalRecords: enrichedItems.length,
                successCount: queueResults.success,
                failCount: queueResults.failed,
                errorCount: queueResults.errors?.length || 0
            });

            // Log any errors
            if (queueResults.errors && queueResults.errors.length > 0) {
                logger.warn('Some jobs failed to queue', {
                    instanceId,
                    executionId,
                    errorCount: queueResults.errors.length,
                    sampleErrors: queueResults.errors.slice(0, 5) // Log first 5 errors
                });
            }

            // Return summary (for logging purposes)
            return {
                success: true,
                totalRecords: enrichedItems.length,
                successCount: queueResults.success,
                failCount: queueResults.failed
            };

        } catch (error) {
            logger.error('Async notify processing error', {
                instanceId,
                installId,
                error: error.message,
                stack: error.stack
            });
            
            // Don't throw - we already returned 204 to Eloqua
            // Just log the error
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Queue SMS jobs from enriched items
     */
    static async queueSmsJobs(instance, consumer, enrichedItems, executionId) {
        logger.info('Queueing SMS jobs', {
            instanceId: instance.instanceId,
            itemCount: enrichedItems.length
        });

        // DEBUG: Log instance field configuration
        logger.debug('Instance field configuration', {
            recipient_field: instance.recipient_field,
            country_field: instance.country_field,
            program_coid: instance.program_coid
        });

        // DEBUG: Log what we received
        if (enrichedItems && enrichedItems.length > 0) {
            logger.debug('First item structure', {
                fields: Object.keys(enrichedItems[0]),
                sampleValues: {
                    ContactID: enrichedItems[0].ContactID,
                    EmailAddress: enrichedItems[0].EmailAddress,
                    C_MobilePhone: enrichedItems[0].C_MobilePhone,
                    C_Country: enrichedItems[0].C_Country,
                    C_FirstName: enrichedItems[0].C_FirstName
                }
            });
        }

        const results = {
            success: 0,
            failed: 0,
            errors: []
        };

        // Check if we have items to process
        if (!enrichedItems || enrichedItems.length === 0) {
            logger.warn('No items to process', { instanceId: instance.instanceId });
            return results;
        }

        // Parse field names to get the actual field names from Eloqua
        // Format can be "FieldId__C_FieldName" or just "C_FieldName" or "FieldName"
        const parseFieldName = (fieldConfig) => {
            if (!fieldConfig) return null;
            
            // Split by __ to handle "FieldId__C_FieldName" format
            const parts = fieldConfig.split('__');
            
            // Return the last part (the actual field name)
            return parts[parts.length - 1];
        };

        const recipientFieldName = parseFieldName(instance.recipient_field);
        const countryFieldName = parseFieldName(instance.country_field);

        logger.debug('Parsed field names for extraction', {
            recipient_field: instance.recipient_field,
            recipientFieldName,
            country_field: instance.country_field,
            countryFieldName,
            firstItemHasRecipientField: enrichedItems[0]?.[recipientFieldName] !== undefined,
            firstItemRecipientValue: enrichedItems[0]?.[recipientFieldName]
        });

        for (let i = 0; i < enrichedItems.length; i++) {
            const item = enrichedItems[i];
            
            try {
                logger.debug('Processing item for SMS', {
                    index: i + 1,
                    total: enrichedItems.length,
                    contactId: item.ContactID,
                    email: item.EmailAddress,
                    recipientFieldName,
                    recipientValue: item[recipientFieldName],
                    availableFields: Object.keys(item)
                });

                // Extract mobile number using parsed field name
                const mobileNumber = item[recipientFieldName];
                
                if (!mobileNumber) {
                    logger.warn('Item has no mobile number', {
                        contactId: item.ContactID,
                        recipientFieldName,
                        recipientValue: item[recipientFieldName],
                        availableFields: Object.keys(item)
                    });
                    results.failed++;
                    results.errors.push({
                        contactId: item.ContactID,
                        error: 'No mobile number',
                        field: recipientFieldName
                    });
                    continue;
                }

                // Extract country using parsed field name (fallback to default)
                const country = item[countryFieldName] || consumer.default_country || 'Australia';

                logger.debug('Extracted contact data', {
                    contactId: item.ContactID,
                    mobileNumber,
                    country,
                    countryFieldName,
                    countryValue: item[countryFieldName]
                });

                // Format mobile number (remove spaces, ensure + prefix)
                const formattedMobile = ActionController.formatMobileNumber(mobileNumber, country);

                logger.debug('Formatted mobile number', {
                    original: mobileNumber,
                    formatted: formattedMobile,
                    country
                });

                // Determine sender ID (might be dynamic from contact field)
                let senderId = instance.caller_id || 'BurstSMS';
                if (instance.caller_id && instance.caller_id.startsWith('##')) {
                    const senderFieldName = parseFieldName(instance.caller_id.replace('##', ''));
                    senderId = item[senderFieldName] || instance.caller_id;
                    
                    logger.debug('Dynamic sender ID resolved', {
                        original: instance.caller_id,
                        fieldName: senderFieldName,
                        resolved: senderId
                    });
                }

                // Build SMS options
                const smsOptions = {
                    country: country,
                    trackedLinkUrl: item.tracked_link_url || null,
                    messageExpiry: instance.message_expiry === 'YES',
                    messageValidity: instance.message_validity ? instance.message_validity * 60 : null
                };

                logger.debug('SMS options built', {
                    contactId: item.ContactID,
                    hasTrackedLink: !!smsOptions.trackedLinkUrl,
                    trackedLinkUrl: smsOptions.trackedLinkUrl,
                    messageHasPlaceholder: item.message?.includes('[tracked-link]')
                });

                // Create SMS job
                const smsJob = new SmsJob({
                    jobId: `${instance.instanceId}_${item.ContactID}_${Date.now()}_${i}`,
                    installId: instance.installId,
                    instanceId: instance.instanceId,
                    executionId: executionId,
                    
                    // Contact details
                    contactId: item.ContactID,
                    emailAddress: item.EmailAddress,
                    mobileNumber: formattedMobile,
                    
                    // Message details (already processed with merge fields)
                    message: item.message,
                    senderId: senderId,
                    
                    // Campaign details
                    campaignId: instance.assetId,
                    campaignTitle: instance.assetName || 'Unknown Campaign',
                    assetName: instance.assetName,
                    
                    // SMS options
                    smsOptions: smsOptions,
                    
                    // Custom object data for logging (if configured)
                    customObjectData: instance.custom_object_id ? {
                        customObjectId: instance.custom_object_id,
                        fields: {
                            [instance.mobile_field]: formattedMobile,
                            [instance.email_field]: item.EmailAddress,
                            [instance.outgoing_field]: item.message,
                            [instance.notification_field]: 'Pending',
                            [instance.vn_field]: senderId,
                            [instance.title_field]: instance.assetName
                        }
                    } : null,
                    
                    status: 'pending',
                    scheduledAt: new Date()
                });

                await smsJob.save();

                logger.debug('SMS job created', {
                    jobId: smsJob.jobId,
                    contactId: item.ContactID,
                    mobile: formattedMobile
                });

                results.success++;

            } catch (error) {
                logger.error('Error creating SMS job', {
                    instanceId: instance.instanceId,
                    contactId: item.ContactID,
                    error: error.message,
                    stack: error.stack
                });
                
                results.failed++;
                results.errors.push({
                    contactId: item.ContactID,
                    error: error.message
                });
            }
        }

        logger.info('SMS job queueing completed', {
            instanceId: instance.instanceId,
            total: enrichedItems.length,
            success: results.success,
            failed: results.failed
        });

        return results;
    }

    /**
     * Get country calling code from country name
     */
    static getCountryCode(country) {
        const countryCodes = {
            'Australia': '+61',
            'United States': '+1',
            'United Kingdom': '+44',
            'New Zealand': '+64',
            'Singapore': '+65',
            'Philippines': '+63',
            'India': '+91',
            'Malaysia': '+60',
            // Add more as needed
        };

        return countryCodes[country] || '+61'; // Default to Australia
    }

    /**
     * Format mobile number with country code
     */
    static formatMobileNumber(mobileNumber, country) {
        if (!mobileNumber) return null;

        // Remove all spaces and special characters
        let cleaned = mobileNumber.replace(/[\s\-\(\)]/g, '');

        // If it already starts with +, return as is
        if (cleaned.startsWith('+')) {
            return cleaned;
        }

        // Get country code from country name
        const countryCode = ActionController.getCountryCode(country);

        // If number starts with 0, remove it and add country code
        if (cleaned.startsWith('0')) {
            cleaned = cleaned.substring(1);
        }

        // If number doesn't start with country code digits, add it
        if (!cleaned.startsWith(countryCode.replace('+', ''))) {
            return `${countryCode}${cleaned}`;
        }

        return `+${cleaned}`;
    }

    /**
     * Process a single SMS job (called by worker)
     */
    static async processSmsJob(job) {
        try {
            await job.markAsProcessing();

            logger.debug('Processing SMS job details', {
                jobId: job.jobId,
                message: job.message?.substring(0, 50),
                messageHasTrackedLink: job.message?.includes('[tracked-link]'),
                smsOptions: job.smsOptions,
                trackedLinkUrl: job.smsOptions?.trackedLinkUrl
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

            // Build SMS options from job data
            const smsOptions = {
                from: job.senderId,
                country: job.smsOptions?.country,
                trackedLinkUrl: job.smsOptions?.trackedLinkUrl,
                messageExpiry: job.smsOptions?.messageExpiry,
                messageValidity: job.smsOptions?.messageValidity,
                dlrCallback: job.smsOptions?.dlrCallback,
                replyCallback: job.smsOptions?.replyCallback,
                linkHitsCallback: job.smsOptions?.linkHitsCallback
            };

            logger.debug('Sending SMS with options', {
                jobId: job.jobId,
                to: job.mobileNumber,
                from: smsOptions.from,
                messageLength: job.message?.length,
                hasTrackedLink: !!smsOptions.trackedLinkUrl,
                trackedLinkUrl: smsOptions.trackedLinkUrl,
                messageHasPlaceholder: job.message?.includes('[tracked-link]')
            });

            const smsResponse = await smsService.sendSms(
                job.mobileNumber,
                job.message,
                smsOptions
            );

            await job.markAsSent(smsResponse.message_id, smsResponse);

            // Create SMS log entry
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
                executionId: job.executionId,
                // Store tracked link info if it was requested
                trackedLinkRequested: smsResponse.tracked_link_requested || false,
                trackedLinkOriginalUrl: smsResponse.tracked_link_original_url || null
            });

            await smsLog.save();

            job.smsLogId = smsLog._id;
            await job.save();

            // Update custom object if configured
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

            logger.info('SMS sent successfully', {
                jobId: job.jobId,
                messageId: smsResponse.message_id,
                to: job.mobileNumber,
                hasTrackedLink: smsResponse.tracked_link_requested
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
            hasMessage: !!message,
            hasTrackedLink: !!tracked_link_url,
            messageHasPlaceholder: message?.includes('[tracked-link]')
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

            // Only add tracked_link_url if both placeholder exists AND URL is provided
            if (finalMessage.includes('[tracked-link]')) {
                if (tracked_link_url && tracked_link_url.trim()) {
                    smsOptions.trackedLinkUrl = tracked_link_url.trim();
                    logger.debug('Test SMS with tracked link', {
                        trackedLinkUrl: smsOptions.trackedLinkUrl
                    });
                } else {
                    // Remove the placeholder if no URL provided
                    logger.warn('Message has [tracked-link] but no URL provided, removing placeholder');
                    finalMessage = finalMessage.replace(/\[tracked-link\]/g, '[No URL provided]');
                }
            }

            if (consumer.dlr_callback) {
                smsOptions.dlrCallback = `${baseUrl}/webhook/dlr?${callbackParams}`;
            }

            if (consumer.reply_callback) {
                smsOptions.replyCallback = `${baseUrl}/webhook/reply?${callbackParams}`;
            }

            if (consumer.link_hits_callback && smsOptions.trackedLinkUrl) {
                smsOptions.linkHitsCallback = `${baseUrl}/webhook/linkhit?${callbackParams}`;
            }

            logger.debug('Sending test SMS', {
                to: formattedNumber,
                from: smsOptions.from,
                messageLength: finalMessage.length,
                hasTrackedLink: !!smsOptions.trackedLinkUrl
            });

            const response = await smsService.sendSms(
                formattedNumber,
                finalMessage,
                smsOptions
            );

            logger.info('Test SMS sent successfully', { 
                to: formattedNumber,
                messageId: response.message_id,
                cost: response.cost
            });

            res.json({
                success: true,
                message: 'Test SMS sent successfully',
                messageId: response.message_id,
                to: formattedNumber,
                from: response.from || smsOptions.from,
                messageLength: finalMessage.length,
                cost: response.cost,
                hasTrackedLink: !!response.tracked_link_requested
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