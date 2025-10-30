const FeederInstance = require('../models/FeederInstance');
const Consumer = require('../models/Consumer');
const SmsLog = require('../models/SmsLog');
const LinkHit = require('../models/LinkHit');
const { EloquaService } = require('../services');
const { logger, generateId } = require('../utils');
const { asyncHandler } = require('../middleware');

class FeederController {

    /**
     * Create feeder instance
     * GET /eloqua/feeder/create
     */
    static create = asyncHandler(async (req, res) => {
        const { installId, siteId, assetId } = req.query;
        const instanceId = generateId();

        logger.info('Creating feeder instance', { installId, instanceId });

        const instance = new FeederInstance({
            instanceId,
            installId,
            SiteId: siteId,
            assetId,
            requiresConfiguration: false // Feeder doesn't require configuration by default
        });

        await instance.save();

        logger.info('Feeder instance created', { instanceId });

        res.json({
            success: true,
            instanceId
        });
    });

    /**
     * Get feeder configure page
     * GET /eloqua/feeder/configure
     */
    static configure = asyncHandler(async (req, res) => {
        const { installId, siteId, instanceId } = req.query;

        logger.info('Loading feeder configuration page', { installId, instanceId });

        const consumer = await Consumer.findOne({ installId });
        if (!consumer) {
            return res.status(404).send('Consumer not found');
        }

        req.session.installId = installId;
        req.session.siteId = siteId;

        let instance = await FeederInstance.findOne({ instanceId });
        
        if (!instance) {
            instance = {
                instanceId,
                installId,
                SiteId: siteId,
                requiresConfiguration: false
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

        res.render('feeder-config', {
            consumer: consumer.toObject(),
            instance,
            custom_objects
        });
    });

    /**
     * Save configuration and update Eloqua instance
     * POST /eloqua/feeder/configure
     */
    static saveConfiguration = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;
        const { instance: instanceData } = req.body;

        logger.info('Saving feeder configuration', { instanceId });

        let instance = await FeederInstance.findOne({ instanceId });
        
        if (!instance) {
            instance = new FeederInstance({ 
                instanceId, 
                ...instanceData 
            });
        } else {
            Object.assign(instance, instanceData);
        }

        // Validate configuration
        const isConfigured = FeederController.validateConfiguration(instance);
        instance.requiresConfiguration = !isConfigured;

        await instance.save();

        logger.info('Feeder configuration saved', { 
            instanceId,
            requiresConfiguration: instance.requiresConfiguration
        });

        // Update Eloqua instance with recordDefinition
        try {
            await FeederController.updateEloquaInstance(instance);
            
            logger.info('Eloqua feeder instance updated successfully', { instanceId });

            res.json({
                success: true,
                message: 'Configuration saved successfully',
                requiresConfiguration: instance.requiresConfiguration
            });

        } catch (error) {
            logger.error('Failed to update Eloqua feeder instance', {
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
        // Feeder service can work with or without custom object mapping
        // If custom object is configured, check required mappings
        if (instance.custom_object_id) {
            if (!instance.email_field || !instance.mobile_field) {
                return false;
            }
        }

        return true;
    }

    /**
     * Update Eloqua feeder instance with recordDefinition
     */
    static async updateEloquaInstance(instance) {
        try {
            const eloquaService = new EloquaService(instance.installId, instance.SiteId);

            // Build recordDefinition based on configuration
            const recordDefinition = await FeederController.buildRecordDefinition(instance);

            // Prepare update payload
            const updatePayload = {
                recordDefinition: recordDefinition,
                requiresConfiguration: instance.requiresConfiguration
            };

            logger.info('Updating Eloqua feeder instance', {
                instanceId: instance.instanceId,
                recordDefinition,
                requiresConfiguration: instance.requiresConfiguration
            });

            // Call Eloqua API to update instance
            await eloquaService.updateFeederInstance(instance.instanceId, updatePayload);

            logger.info('Eloqua feeder instance updated', {
                instanceId: instance.instanceId
            });

        } catch (error) {
            logger.error('Error updating Eloqua feeder instance', {
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
        recordDefinition.MobileNumber = 'MobileNumber';

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

                if (instance.url_field) {
                    const field = customObject.fields.find(f => f.internalName === instance.url_field);
                    recordDefinition[field?.name || 'URL'] = instance.url_field;
                }

                if (instance.originalurl_field) {
                    const field = customObject.fields.find(f => f.internalName === instance.originalurl_field);
                    recordDefinition[field?.name || 'OriginalURL'] = instance.originalurl_field;
                }

                if (instance.link_hits_field) {
                    const field = customObject.fields.find(f => f.internalName === instance.link_hits_field);
                    recordDefinition[field?.name || 'LinkHits'] = instance.link_hits_field;
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
                if (instance.url_field) recordDefinition.URL = instance.url_field;
                if (instance.originalurl_field) recordDefinition.OriginalURL = instance.originalurl_field;
                if (instance.link_hits_field) recordDefinition.LinkHits = instance.link_hits_field;
                if (instance.vn_field) recordDefinition.VirtualNumber = instance.vn_field;
            }
        }

        logger.debug('Built recordDefinition for feeder', {
            instanceId: instance.instanceId,
            recordDefinition
        });

        return recordDefinition;
    }

    /**
     * Notify (Execute feeder) - Provide link hit data
     * POST /eloqua/feeder/notify
     */
    static notify = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;
        const executionData = req.body;

        logger.info('Feeder notify received', { 
            instanceId, 
            recordCount: executionData.items?.length || 0 
        });

        const instance = await FeederInstance.findOne({ instanceId });
        if (!instance) {
            return res.status(404).json({ error: 'Instance not found' });
        }

        const results = await FeederController.getLinkHitData(
            instance,
            executionData
        );

        logger.info('Feeder notify completed', { 
            instanceId, 
            recordsWithHits: results.filter(r => r.linkHits > 0).length,
            totalHits: results.reduce((sum, r) => sum + (r.linkHits || 0), 0)
        });

        res.json({
            success: true,
            results
        });
    });

    /**
     * Get link hit data for each contact
     */
    static async getLinkHitData(instance, executionData) {
        const results = [];
        const records = executionData.items || [];

        for (const record of records) {
            try {
                const mobileNumber = FeederController.getFieldValue(record, 'mobilePhone');
                const emailAddress = record.emailAddress;
                
                if (!mobileNumber && !emailAddress) {
                    results.push({
                        contactId: record.contactId,
                        linkHits: 0,
                        reason: 'No mobile number or email address'
                    });
                    continue;
                }

                // Find SMS logs for this contact
                const smsQuery = {
                    installId: instance.installId
                };

                if (mobileNumber) {
                    smsQuery.mobileNumber = mobileNumber;
                } else if (emailAddress) {
                    smsQuery.emailAddress = emailAddress;
                }

                const smsLogs = await SmsLog.find(smsQuery)
                    .sort({ createdAt: -1 })
                    .limit(100); // Last 100 SMS

                if (smsLogs.length === 0) {
                    results.push({
                        contactId: record.contactId,
                        linkHits: 0,
                        reason: 'No SMS sent to this contact'
                    });
                    continue;
                }

                // Get all link hits for these SMS
                const smsIds = smsLogs.map(sms => sms._id);
                
                const linkHits = await LinkHit.find({
                    smsId: { $in: smsIds }
                }).sort({ createdAt: -1 });

                if (linkHits.length > 0) {
                    // Get the most recent link hit
                    const latestHit = linkHits[0];

                    // Update custom object if configured
                    if (instance.custom_object_id) {
                        const eloquaService = new EloquaService(instance.installId, instance.SiteId);
                        await FeederController.updateCustomObject(
                            eloquaService,
                            instance,
                            record,
                            latestHit,
                            linkHits.length
                        );
                    }

                    results.push({
                        contactId: record.contactId,
                        emailAddress: emailAddress,
                        mobileNumber: mobileNumber,
                        linkHits: linkHits.length,
                        latestHitUrl: latestHit.tracked_url,
                        originalUrl: latestHit.original_url,
                        latestHitTime: latestHit.click_timestamp,
                        allHits: linkHits.map(hit => ({
                            url: hit.tracked_url,
                            originalUrl: hit.original_url,
                            timestamp: hit.click_timestamp,
                            userAgent: hit.user_agent
                        }))
                    });
                } else {
                    results.push({
                        contactId: record.contactId,
                        emailAddress: emailAddress,
                        mobileNumber: mobileNumber,
                        linkHits: 0,
                        reason: 'No link hits found'
                    });
                }

            } catch (error) {
                logger.error('Error getting link hit data', {
                    instanceId: instance.instanceId,
                    contactId: record.contactId,
                    error: error.message
                });

                results.push({
                    contactId: record.contactId,
                    linkHits: 0,
                    error: error.message
                });
            }
        }

        return results;
    }

    /**
     * Update custom object with link hit data
     */
    static async updateCustomObject(eloquaService, instance, record, latestHit, totalHits) {
        try {
            const cdoData = {
                fieldValues: []
            };

            if (instance.mobile_field) {
                cdoData.fieldValues.push({
                    id: instance.mobile_field,
                    value: latestHit.mobile || record.mobilePhone || ''
                });
            }

            if (instance.email_field) {
                cdoData.fieldValues.push({
                    id: instance.email_field,
                    value: record.emailAddress || ''
                });
            }

            if (instance.title_field) {
                cdoData.fieldValues.push({
                    id: instance.title_field,
                    value: 'SMS Link Hit'
                });
            }

            if (instance.url_field) {
                cdoData.fieldValues.push({
                    id: instance.url_field,
                    value: latestHit.tracked_url
                });
            }

            if (instance.originalurl_field) {
                cdoData.fieldValues.push({
                    id: instance.originalurl_field,
                    value: latestHit.original_url || ''
                });
            }

            if (instance.link_hits_field) {
                cdoData.fieldValues.push({
                    id: instance.link_hits_field,
                    value: totalHits.toString()
                });
            }

            if (instance.vn_field) {
                // Get the original SMS to find virtual number
                const sms = await SmsLog.findById(latestHit.smsId);
                if (sms && sms.senderId) {
                    cdoData.fieldValues.push({
                        id: instance.vn_field,
                        value: sms.senderId
                    });
                }
            }

            await eloquaService.createCustomObjectRecord(
                instance.custom_object_id, 
                cdoData
            );

            logger.debug('Custom object updated with link hit', {
                customObjectId: instance.custom_object_id,
                contactId: record.contactId
            });

        } catch (error) {
            logger.error('Error updating custom object with link hit', {
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
            createdAt: undefined,
            updatedAt: undefined,
            requiresConfiguration: instance.custom_object_id ? true : false
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

    /**
     * Get custom objects (AJAX) with pagination and search
     * GET /eloqua/feeder/ajax/customobjects/:installId/:siteId/customObject
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
     * GET /eloqua/feeder/ajax/customobject/:installId/:siteId/:customObjectId
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
     * Get link hit statistics
     * GET /eloqua/feeder/stats
     */
    static getStats = asyncHandler(async (req, res) => {
        const { installId, instanceId } = req.query;

        logger.info('Getting feeder statistics', { installId, instanceId });

        // Get total link hits
        const totalHits = await LinkHit.countDocuments({ installId });

        // Get unique contacts who clicked
        const uniqueClickers = await LinkHit.distinct('mobile', { installId });

        // Get recent hits
        const recentHits = await LinkHit.find({ installId })
            .sort({ createdAt: -1 })
            .limit(20)
            .populate('smsId', 'campaignTitle message');

        // Get top clicked URLs
        const topUrls = await LinkHit.aggregate([
            { $match: { installId } },
            {
                $group: {
                    _id: '$original_url',
                    clicks: { $sum: 1 },
                    uniqueClickers: { $addToSet: '$mobile' }
                }
            },
            { $sort: { clicks: -1 } },
            { $limit: 10 }
        ]);

        res.json({
            success: true,
            stats: {
                totalHits,
                uniqueClickers: uniqueClickers.length,
                recentHits,
                topUrls: topUrls.map(url => ({
                    url: url._id,
                    clicks: url.clicks,
                    uniqueClickers: url.uniqueClickers.length
                }))
            }
        });
    });
}

module.exports = FeederController;