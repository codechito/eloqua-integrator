const FeederInstance = require('../models/FeederInstance');
const Consumer = require('../models/Consumer');
const LinkHit = require('../models/LinkHit');
const SmsLog = require('../models/SmsLog');
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
            batchSize: 50
        });

        await instance.save();

        logger.info('Feeder instance created', { instanceId });

        res.json({
            success: true,
            instanceId
        });
    });

    /**
     * Get configure page
     * GET /eloqua/feeder/configure
     */
    static configure = asyncHandler(async (req, res) => {
        const { installId, siteId, instanceId } = req.query;

        logger.info('Loading feeder configuration page', { installId, instanceId });

        const consumer = await Consumer.findOne({ installId });
        if (!consumer) {
            return res.status(404).send('Consumer not found');
        }

        let instance = await FeederInstance.findOne({ instanceId });
        
        if (!instance) {
            instance = {
                instanceId,
                installId,
                SiteId: siteId,
                batchSize: 50
            };
        }

        res.render('feeder-config', {
            consumer: consumer.toObject(),
            instance
        });
    });

    /**
     * Save configuration
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

        await instance.save();

        logger.info('Feeder configuration saved', { instanceId });

        res.json({
            success: true,
            message: 'Configuration saved successfully'
        });
    });

    /**
     * Notify (Get link hits)
     * POST /eloqua/feeder/notify
     */
    static notify = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;
        const { count = 50 } = req.body;

        logger.info('Feeder notify received', { instanceId, requestedCount: count });

        const instance = await FeederInstance.findOne({ instanceId });
        if (!instance) {
            return res.status(404).json({ error: 'Instance not found' });
        }

        const consumer = await Consumer.findOne({ installId: instance.installId });
        if (!consumer) {
            return res.status(404).json({ error: 'Consumer not found' });
        }

        // Get unprocessed link hits
        const batchSize = Math.min(count, instance.batchSize || 50);
        
        const linkHits = await LinkHit.find({
            installId: instance.installId,
            processed: false
        })
        .limit(batchSize)
        .populate('smsLogId')
        .sort({ clickedAt: 1 });

        const records = [];
        const eloquaService = new EloquaService(
            instance.installId,
            instance.SiteId
        );

        for (const hit of linkHits) {
            try {
                const smsLog = hit.smsLogId;

                if (smsLog) {
                    // Update custom object if configured
                    if (consumer.actions.tracked_link.custom_object_id) {
                        await FeederController.updateCustomObject(
                            eloquaService,
                            consumer,
                            smsLog,
                            hit
                        );
                    }

                    records.push({
                        emailAddress: smsLog.emailAddress,
                        mobileNumber: hit.mobileNumber,
                        shortUrl: hit.shortUrl,
                        originalUrl: hit.originalUrl,
                        clickedAt: hit.clickedAt,
                        linkHitId: hit._id.toString(),
                        deviceType: hit.deviceType,
                        browser: hit.browser,
                        ipAddress: hit.ipAddress
                    });
                }

                // Mark as processed
                await hit.markAsProcessed();

                logger.debug('Link hit processed', {
                    linkHitId: hit._id,
                    mobileNumber: hit.mobileNumber
                });

            } catch (error) {
                logger.error('Error processing link hit', {
                    linkHitId: hit._id,
                    error: error.message
                });
            }
        }

        // Update stats
        await instance.recordProcessing(records.length);

        logger.info('Feeder notify completed', { 
            instanceId,
            recordsReturned: records.length 
        });

        res.json({
            success: true,
            count: records.length,
            records
        });
    });

    /**
     * Update custom object with link hit data
     */
    static async updateCustomObject(eloquaService, consumer, smsLog, linkHit) {
        try {
            const config = consumer.actions.tracked_link;
            
            const cdoData = {
                fieldValues: []
            };

            if (config.mobile_field) {
                cdoData.fieldValues.push({
                    id: config.mobile_field,
                    value: linkHit.mobileNumber
                });
            }

            if (config.email_field) {
                cdoData.fieldValues.push({
                    id: config.email_field,
                    value: smsLog.emailAddress
                });
            }

            if (config.url_field) {
                cdoData.fieldValues.push({
                    id: config.url_field,
                    value: linkHit.shortUrl
                });
            }

            if (config.originalurl_field) {
                cdoData.fieldValues.push({
                    id: config.originalurl_field,
                    value: linkHit.originalUrl
                });
            }

            if (config.title_field) {
                cdoData.fieldValues.push({
                    id: config.title_field,
                    value: smsLog.campaignTitle || 'SMS Link Hit'
                });
            }

            if (config.vn_field && smsLog.senderId) {
                cdoData.fieldValues.push({
                    id: config.vn_field,
                    value: smsLog.senderId
                });
            }

            if (config.link_hits) {
                // Count total hits for this SMS
                const hitCount = await LinkHit.countDocuments({
                    smsLogId: smsLog._id
                });
                
                cdoData.fieldValues.push({
                    id: config.link_hits,
                    value: hitCount.toString()
                });
            }

            await eloquaService.createCustomObjectRecord(
                config.custom_object_id, 
                cdoData
            );

            logger.debug('Custom object updated with link hit', {
                customObjectId: config.custom_object_id,
                linkHitId: linkHit._id
            });

        } catch (error) {
            logger.error('Error updating custom object', {
                error: error.message,
                linkHitId: linkHit._id
            });
        }
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
            totalLinkHitsProcessed: 0,
            lastExecutedAt: undefined,
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