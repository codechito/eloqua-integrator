const FeederInstance = require('../models/FeederInstance');
const Consumer = require('../models/Consumer');
const SmsLog = require('../models/SmsLog');
const SmsReply = require('../models/SmsReply');
const LinkHit = require('../models/LinkHit');
const { EloquaService } = require('../services');
const TransmitSmsService = require('../services/transmitsmsService');
const { logger, generateId } = require('../utils');
const { asyncHandler } = require('../middleware');

class FeederController {

    /**
     * Create feeder instance
     * GET /eloqua/feeder/create
     *
     * Eloqua passes ?type=incoming_sms when creating an Incoming SMS feeder.
     * The Link Hits feeder omits the type param (default behaviour).
     */
    static create = asyncHandler(async (req, res) => {
        const { installId, siteId, assetId, type } = req.query;
        const instanceId = generateId();
        const feederType = type === 'incoming_sms' ? 'incoming_sms' : 'link_hits';

        logger.info('Creating feeder instance', { installId, instanceId, feederType });

        const instance = new FeederInstance({
            instanceId,
            installId,
            SiteId: siteId,
            assetId,
            feederType,
            requiresConfiguration: feederType === 'incoming_sms' // Incoming SMS must be configured
        });

        await instance.save();

        logger.info('Feeder instance created', { instanceId, feederType });

        res.json({ success: true, instanceId });
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
            instance = { instanceId, installId, SiteId: siteId, feederType: 'link_hits', requiresConfiguration: false };
        }

        if (instance.feederType === 'incoming_sms') {
            return FeederController.configureIncomingSms(req, res, consumer, instance);
        }

        // --- Link Hits feeder (existing behaviour) ---
        let custom_objects = { elements: [] };
        try {
            const eloquaService = new EloquaService(installId, siteId);
            custom_objects = await eloquaService.getCustomObjects('', 100);
        } catch (error) {
            logger.warn('Could not fetch custom objects', { error: error.message });
        }

        res.render('feeder-config', { consumer: consumer.toObject(), instance, custom_objects });
    });

    /**
     * Render Incoming SMS feeder configure page
     */
    static async configureIncomingSms(req, res, consumer, instance) {
        let sender_ids = { 'Virtual Number': [], 'Business Name': [], 'Mobile Number': [] };

        try {
            const transmitService = new TransmitSmsService(
                consumer.transmitsms_api_key,
                consumer.transmitsms_api_secret
            );
            sender_ids = await transmitService.getSenderIds();
        } catch (error) {
            logger.warn('Could not fetch sender IDs for incoming SMS feeder', { error: error.message });
        }

        res.render('feeder-incoming-sms', {
            consumer: consumer.toObject(),
            instance,
            sender_ids
        });
    }

    /**
     * Save configuration
     * POST /eloqua/feeder/configure
     */
    static saveConfiguration = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;
        const { instance: instanceData } = req.body;

        logger.info('Saving feeder configuration', { instanceId, feederType: instanceData.feederType });

        let instance = await FeederInstance.findOne({ instanceId });

        if (!instance) {
            instance = new FeederInstance({ instanceId, ...instanceData });
        } else {
            Object.assign(instance, instanceData);
        }

        const isConfigured = FeederController.validateConfiguration(instance);
        instance.requiresConfiguration = !isConfigured;

        await instance.save();

        logger.info('Feeder configuration saved', { instanceId, requiresConfiguration: instance.requiresConfiguration });

        // Configure virtual number forwarding in TransmitSMS for Incoming SMS feeder
        if (instance.feederType === 'incoming_sms' && instance.sender_id) {
            try {
                const consumer = await Consumer.findOne({ installId: instance.installId });
                if (consumer) {
                    const transmitService = new TransmitSmsService(
                        consumer.transmitsms_api_key,
                        consumer.transmitsms_api_secret
                    );

                    const baseUrl = process.env.APP_BASE_URL || 'https://eloqua-integrator.onrender.com';
                    const forwardUrl = `${baseUrl}/webhooks/reply?installId=${instance.installId}`;

                    await transmitService.configureNumberForwarding(instance.sender_id, forwardUrl);

                    logger.info('Virtual number forwarding configured for Incoming SMS feeder', {
                        instanceId,
                        sender_id: instance.sender_id,
                        forwardUrl
                    });
                }
            } catch (fwdError) {
                logger.error('Failed to configure number forwarding', {
                    instanceId,
                    sender_id: instance.sender_id,
                    error: fwdError.message
                });
                // Still return success — config is saved, forwarding can be retried
                return res.json({
                    success: true,
                    warning: `Configuration saved but failed to configure number forwarding: ${fwdError.message}`,
                    requiresConfiguration: instance.requiresConfiguration
                });
            }
        }

        // Update Eloqua instance record
        try {
            await FeederController.updateEloquaInstance(instance);
        } catch (error) {
            logger.error('Failed to update Eloqua feeder instance', { instanceId, error: error.message });
            return res.json({
                success: true,
                warning: 'Configuration saved locally but failed to update Eloqua',
                requiresConfiguration: instance.requiresConfiguration
            });
        }

        res.json({
            success: true,
            message: 'Configuration saved successfully',
            requiresConfiguration: instance.requiresConfiguration
        });
    });

    /**
     * Validate configuration
     */
    static validateConfiguration(instance) {
        if (instance.feederType === 'incoming_sms') {
            return !!instance.sender_id;
        }
        // Link hits — custom object mapping is optional
        if (instance.custom_object_id) {
            return !!(instance.email_field && instance.mobile_field);
        }
        return true;
    }

    /**
     * Update Eloqua feeder instance
     */
    static async updateEloquaInstance(instance) {
        const eloquaService = new EloquaService(instance.installId, instance.SiteId);
        const recordDefinition = await FeederController.buildRecordDefinition(instance);
        await eloquaService.updateFeederInstance(instance.instanceId, {
            recordDefinition,
            requiresConfiguration: instance.requiresConfiguration
        });
    }

    /**
     * Build recordDefinition for Eloqua
     */
    static async buildRecordDefinition(instance) {
        const recordDefinition = {
            ContactID:    'ContactID',
            EmailAddress: 'EmailAddress',
            MobileNumber: 'MobileNumber'
        };

        if (instance.feederType === 'incoming_sms') {
            recordDefinition.InboundMessage  = 'InboundMessage';
            recordDefinition.VirtualNumber   = 'VirtualNumber';
            recordDefinition.ReceivedAt      = 'ReceivedAt';
            return recordDefinition;
        }

        // Link hits — existing field mapping logic
        if (instance.custom_object_id) {
            const eloquaService = new EloquaService(instance.installId, instance.SiteId);
            try {
                const customObject = await eloquaService.getCustomObject(instance.custom_object_id);
                const lookup = {};
                customObject.fields.forEach(f => { lookup[f.internalName] = f.name; });

                if (instance.mobile_field)       recordDefinition[lookup[instance.mobile_field]       || 'Mobile']      = instance.mobile_field;
                if (instance.email_field)        recordDefinition[lookup[instance.email_field]        || 'Email']       = instance.email_field;
                if (instance.title_field)        recordDefinition[lookup[instance.title_field]        || 'Title']       = instance.title_field;
                if (instance.url_field)          recordDefinition[lookup[instance.url_field]          || 'URL']         = instance.url_field;
                if (instance.originalurl_field)  recordDefinition[lookup[instance.originalurl_field]  || 'OriginalURL']  = instance.originalurl_field;
                if (instance.link_hits_field)    recordDefinition[lookup[instance.link_hits_field]    || 'LinkHits']    = instance.link_hits_field;
                if (instance.vn_field)           recordDefinition[lookup[instance.vn_field]           || 'VirtualNumber'] = instance.vn_field;
            } catch (error) {
                logger.warn('Could not fetch custom object for recordDefinition', { error: error.message });
                if (instance.mobile_field)      recordDefinition.Mobile      = instance.mobile_field;
                if (instance.email_field)       recordDefinition.Email       = instance.email_field;
                if (instance.title_field)       recordDefinition.Title       = instance.title_field;
                if (instance.url_field)         recordDefinition.URL         = instance.url_field;
                if (instance.originalurl_field) recordDefinition.OriginalURL = instance.originalurl_field;
                if (instance.link_hits_field)   recordDefinition.LinkHits    = instance.link_hits_field;
                if (instance.vn_field)          recordDefinition.VirtualNumber = instance.vn_field;
            }
        }

        return recordDefinition;
    }

    /**
     * Notify — Eloqua calls this with a contact batch to check who qualifies
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

        if (instance.feederType === 'incoming_sms') {
            const results = await FeederController.getIncomingSmsData(instance, executionData);
            return res.json({ success: true, results });
        }

        // Link hits (existing behaviour)
        const results = await FeederController.getLinkHitData(instance, executionData);
        res.json({ success: true, results });
    });

    /**
     * Check which contacts have texted the configured virtual number
     */
    static async getIncomingSmsData(instance, executionData) {
        const results = [];
        const records = executionData.items || [];

        for (const record of records) {
            try {
                const mobileNumber = FeederController.getFieldValue(record, 'mobilePhone');
                const emailAddress = record.emailAddress;

                if (!mobileNumber && !emailAddress) {
                    results.push({ contactId: record.contactId, qualifies: false, reason: 'No mobile number' });
                    continue;
                }

                // Build query — match virtual number + contact's mobile
                const normalised = mobileNumber ? mobileNumber.replace(/[^\d+]/g, '') : null;
                const query = {
                    installId: instance.installId,
                    toNumber:  instance.sender_id,
                    isOptOut:  false
                };

                if (normalised) {
                    query.$or = [
                        { fromNumber: mobileNumber },
                        { fromNumber: normalised },
                        { fromNumber: { $regex: new RegExp(normalised.replace('+', '\\+'), 'i') } }
                    ];
                }

                let replies = await SmsReply.find(query).sort({ receivedAt: -1 }).limit(20);

                // Apply keyword filter
                if (replies.length > 0 && instance.text_type === 'Keyword' && instance.keyword) {
                    const keywords = instance.keyword.toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
                    replies = replies.filter(r =>
                        keywords.some(kw => r.message && r.message.toLowerCase().includes(kw))
                    );
                }

                if (replies.length === 0) {
                    results.push({ contactId: record.contactId, qualifies: false, reason: 'No matching inbound SMS' });
                    continue;
                }

                const latest = replies[0];
                results.push({
                    contactId:      record.contactId,
                    emailAddress,
                    mobileNumber,
                    qualifies:      true,
                    inboundMessage: latest.message,
                    virtualNumber:  instance.sender_id,
                    receivedAt:     latest.receivedAt,
                    replyCount:     replies.length
                });

            } catch (error) {
                logger.error('Error checking inbound SMS for contact', {
                    contactId: record.contactId,
                    error: error.message
                });
                results.push({ contactId: record.contactId, qualifies: false, error: error.message });
            }
        }

        logger.info('Incoming SMS feeder notify completed', {
            instanceId: instance.instanceId,
            total:      records.length,
            qualifying: results.filter(r => r.qualifies).length
        });

        return results;
    }

    /**
     * Incoming SMS feeder activity stats
     * GET /eloqua/feeder/inbound/stats/:instanceId
     */
    static getInboundStats = asyncHandler(async (req, res) => {
        const { instanceId } = req.params;
        const { installId } = req.query;

        const instance = await FeederInstance.findOne({ instanceId });
        if (!instance || !instance.sender_id) {
            return res.json({ success: true, stats: { total: 0, today: 0, optouts: 0 } });
        }

        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        const [total, today, optouts] = await Promise.all([
            SmsReply.countDocuments({ installId: instance.installId, toNumber: instance.sender_id }),
            SmsReply.countDocuments({ installId: instance.installId, toNumber: instance.sender_id, receivedAt: { $gte: startOfToday } }),
            SmsReply.countDocuments({ installId: instance.installId, toNumber: instance.sender_id, isOptOut: true })
        ]);

        res.json({ success: true, stats: { total, today, optouts } });
    });

    // -------------------------------------------------------------------------
    // Link Hits feeder — existing methods below, unchanged
    // -------------------------------------------------------------------------

    static async getLinkHitData(instance, executionData) {
        const results = [];
        const records = executionData.items || [];

        for (const record of records) {
            try {
                const mobileNumber = FeederController.getFieldValue(record, 'mobilePhone');
                const emailAddress = record.emailAddress;

                if (!mobileNumber && !emailAddress) {
                    results.push({ contactId: record.contactId, linkHits: 0, reason: 'No mobile number or email address' });
                    continue;
                }

                const smsQuery = { installId: instance.installId };
                if (mobileNumber) {
                    smsQuery.mobileNumber = mobileNumber;
                } else if (emailAddress) {
                    smsQuery.emailAddress = emailAddress;
                }

                const smsLogs = await SmsLog.find(smsQuery).sort({ createdAt: -1 }).limit(100);

                if (smsLogs.length === 0) {
                    results.push({ contactId: record.contactId, linkHits: 0, reason: 'No SMS sent to this contact' });
                    continue;
                }

                const smsIds = smsLogs.map(sms => sms._id);
                const linkHits = await LinkHit.find({ smsId: { $in: smsIds } }).sort({ createdAt: -1 });

                if (linkHits.length > 0) {
                    const latestHit = linkHits[0];

                    if (instance.custom_object_id) {
                        const eloquaService = new EloquaService(instance.installId, instance.SiteId);
                        await FeederController.updateCustomObject(eloquaService, instance, record, latestHit, linkHits.length);
                    }

                    results.push({
                        contactId:      record.contactId,
                        emailAddress,
                        mobileNumber,
                        linkHits:       linkHits.length,
                        latestHitUrl:   latestHit.tracked_url,
                        originalUrl:    latestHit.original_url,
                        latestHitTime:  latestHit.click_timestamp,
                        allHits: linkHits.map(hit => ({
                            url:         hit.tracked_url,
                            originalUrl: hit.original_url,
                            timestamp:   hit.click_timestamp,
                            userAgent:   hit.user_agent
                        }))
                    });
                } else {
                    results.push({ contactId: record.contactId, emailAddress, mobileNumber, linkHits: 0, reason: 'No link hits found' });
                }
            } catch (error) {
                logger.error('Error getting link hit data', { contactId: record.contactId, error: error.message });
                results.push({ contactId: record.contactId, linkHits: 0, error: error.message });
            }
        }

        return results;
    }

    static async updateCustomObject(eloquaService, instance, record, latestHit, totalHits) {
        try {
            const cdoData = { fieldValues: [] };

            if (instance.mobile_field)      cdoData.fieldValues.push({ id: instance.mobile_field,      value: latestHit.mobile || record.mobilePhone || '' });
            if (instance.email_field)       cdoData.fieldValues.push({ id: instance.email_field,       value: record.emailAddress || '' });
            if (instance.title_field)       cdoData.fieldValues.push({ id: instance.title_field,       value: 'SMS Link Hit' });
            if (instance.url_field)         cdoData.fieldValues.push({ id: instance.url_field,         value: latestHit.tracked_url });
            if (instance.originalurl_field) cdoData.fieldValues.push({ id: instance.originalurl_field, value: latestHit.original_url || '' });
            if (instance.link_hits_field)   cdoData.fieldValues.push({ id: instance.link_hits_field,   value: totalHits.toString() });

            if (instance.vn_field) {
                const sms = await SmsLog.findById(latestHit.smsId);
                if (sms?.senderId) {
                    cdoData.fieldValues.push({ id: instance.vn_field, value: sms.senderId });
                }
            }

            await eloquaService.createCustomObjectRecord(instance.custom_object_id, cdoData);
        } catch (error) {
            logger.error('Error updating custom object with link hit', { error: error.message });
        }
    }

    static getFieldValue(record, fieldPath) {
        if (!fieldPath) return null;
        const parts = fieldPath.split('__');
        if (parts.length > 1) return record[parts[1]] || null;
        return record[fieldPath] || null;
    }

    static copy = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;
        const newInstanceId = generateId();

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
            requiresConfiguration: instance.feederType === 'incoming_sms' ? true : (instance.custom_object_id ? true : false)
        });

        await newInstance.save();

        logger.info('Feeder instance copied', { from: instanceId, to: newInstanceId });

        res.json({ success: true, instanceId: newInstanceId });
    });

    static delete = asyncHandler(async (req, res) => {
        const { instanceId } = req.query;

        await FeederInstance.findOneAndUpdate({ instanceId }, { isActive: false });

        logger.info('Feeder instance deleted', { instanceId });

        res.json({ success: true, message: 'Instance deleted successfully' });
    });

    static getCustomObjects = asyncHandler(async (req, res) => {
        const { installId, siteId } = req.params;
        const { search = '', count = 50 } = req.query;

        const eloquaService = new EloquaService(installId, siteId);
        try {
            const customObjects = await eloquaService.getCustomObjects(search, count);
            res.json(customObjects);
        } catch (error) {
            res.status(500).json({ error: 'Failed to fetch custom objects', message: error.message, elements: [] });
        }
    });

    static getCustomObjectFields = asyncHandler(async (req, res) => {
        const { installId, siteId, customObjectId } = req.params;

        const eloquaService = new EloquaService(installId, siteId);
        try {
            const customObject = await eloquaService.getCustomObject(customObjectId);
            res.json(customObject);
        } catch (error) {
            res.status(500).json({ error: 'Failed to fetch fields', message: error.message, fields: [] });
        }
    });

    static getStats = asyncHandler(async (req, res) => {
        const { installId } = req.query;

        const totalHits      = await LinkHit.countDocuments({ installId });
        const uniqueClickers = await LinkHit.distinct('mobile', { installId });
        const recentHits     = await LinkHit.find({ installId }).sort({ createdAt: -1 }).limit(20).populate('smsId', 'campaignTitle message');
        const topUrls        = await LinkHit.aggregate([
            { $match: { installId } },
            { $group: { _id: '$original_url', clicks: { $sum: 1 }, uniqueClickers: { $addToSet: '$mobile' } } },
            { $sort: { clicks: -1 } },
            { $limit: 10 }
        ]);

        res.json({
            success: true,
            stats: {
                totalHits,
                uniqueClickers: uniqueClickers.length,
                recentHits,
                topUrls: topUrls.map(u => ({ url: u._id, clicks: u.clicks, uniqueClickers: u.uniqueClickers.length }))
            }
        });
    });
}

module.exports = FeederController;
