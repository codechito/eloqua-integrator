const Consumer = require('../models/Consumer');
const SmsLog = require('../models/SmsLog');
const SmsReply = require('../models/SmsReply');
const LinkHit = require('../models/LinkHit');
const { logger } = require('../utils');
const { asyncHandler } = require('../middleware');

class WebhookController {
    /**
     * Handle Delivery Reports (DLR)
     * POST /webhooks/dlr
     */
    static handleDeliveryReport = asyncHandler(async (req, res) => {
        const dlrData = { ...req.query, ...req.body };
        
        logger.webhook('dlr_received', { 
            messageId: dlrData.message_id,
            status: dlrData.status,
            mobile: dlrData.mobile,
            installId: dlrData.installId,
            contactId: dlrData.contactId
        });

        try {
            // Find SMS by message ID
            const smsLog = await SmsLog.findOne({
                messageId: dlrData.message_id
            });

            if (smsLog) {
                // Map TransmitSMS status to our status
                const status = WebhookController.mapDlrStatus(dlrData.status);
                
                smsLog.status = status;
                
                if (dlrData.status === 'delivered') {
                    smsLog.deliveredAt = new Date(dlrData.datetime || Date.now());
                }

                if (dlrData.error_code) {
                    smsLog.errorMessage = dlrData.error_text || `Error code: ${dlrData.error_code}`;
                    smsLog.errorCode = dlrData.error_code;
                }

                // Store webhook data
                smsLog.webhookData = {
                    dlr: dlrData,
                    receivedAt: new Date()
                };

                await smsLog.save();

                logger.webhook('dlr_processed', {
                    messageId: dlrData.message_id,
                    status,
                    smsLogId: smsLog._id
                });
            } else {
                logger.warn('SMS log not found for DLR', {
                    messageId: dlrData.message_id
                });
            }

            res.json({ 
                success: true, 
                message: 'DLR processed' 
            });

        } catch (error) {
            logger.error('Error processing DLR', {
                error: error.message,
                dlrData
            });
            
            // Still return 200 to prevent retries
            res.json({ 
                success: false, 
                error: error.message 
            });
        }
    });

    /**
     * Handle SMS Replies
     * POST /webhooks/reply
     */
    static handleSmsReply = asyncHandler(async (req, res) => {
        const replyData = { ...req.query, ...req.body };
        
        logger.webhook('reply_received', { 
            from: replyData.mobile,
            message: replyData.response,
            messageId: replyData.message_id,
            responseId: replyData.response_id,
            installId: replyData.installId,
            contactId: replyData.contactId
        });

        try {
            const fromNumber = replyData.mobile;
            const toNumber = replyData.longcode;
            const message = replyData.response;
            const messageId = replyData.message_id;
            const responseId = replyData.response_id;
            const timestamp = replyData.datetime_entry 
                ? new Date(replyData.datetime_entry) 
                : new Date();
            const isOptOut = replyData.is_optout === 'yes';

            // Find the original SMS(s)
            let smsLog = null;
            let installId = replyData.installId || null;
            let contactId = replyData.contactId || null;

            if (messageId) {
                smsLog = await SmsLog.findOne({ messageId });
                if (smsLog) {
                    installId = smsLog.installId;
                    contactId = smsLog.contactId;
                }
            }

            // If not found by messageId, try by mobile number
            if (!smsLog && fromNumber) {
                const recentSms = await SmsLog.find({
                    mobileNumber: fromNumber
                }).sort({ createdAt: -1 }).limit(1);

                if (recentSms.length > 0) {
                    smsLog = recentSms[0];
                    installId = smsLog.installId;
                    contactId = smsLog.contactId;
                }
            }

            // Create reply record
            const smsReply = new SmsReply({
                smsLogId: smsLog ? smsLog._id : null,
                installId,
                contactId,
                fromNumber,
                toNumber,
                message,
                messageId,
                responseId,
                receivedAt: timestamp,
                isOptOut,
                webhookData: replyData
            });

            await smsReply.save();

            logger.webhook('reply_saved', {
                replyId: smsReply._id,
                fromNumber,
                isOptOut,
                linkedToSms: !!smsLog
            });

            res.json({ 
                success: true, 
                message: 'Reply processed',
                replyId: smsReply._id 
            });

        } catch (error) {
            logger.error('Error processing SMS reply', {
                error: error.message,
                replyData
            });
            
            // Still return 200 to prevent retries
            res.json({ 
                success: false, 
                error: error.message 
            });
        }
    });

    /**
     * Handle Link Hits
     * POST /webhooks/linkhit
     */
    static handleLinkHit = asyncHandler(async (req, res) => {
        const hitData = { ...req.query, ...req.body };
        
        logger.webhook('linkhit_received', { 
            mobile: hitData.mobile,
            messageId: hitData.message_id,
            linkHits: hitData.link_hits,
            installId: hitData.installId,
            contactId: hitData.contactId
        });

        try {
            const mobileNumber = hitData.mobile;
            const messageId = hitData.message_id;
            const timestamp = hitData.datetime 
                ? new Date(hitData.datetime) 
                : new Date();
            const linkHitsCount = parseInt(hitData.link_hits) || 1;

            // Extract URLs from message
            const message = hitData.message || '';
            const urlRegex = /(https?:\/\/[^\s]+)/g;
            const urls = message.match(urlRegex) || [];
            const shortUrl = urls.find(url => url.includes('TapTh.is') || url.includes('tap.th')) || urls[0];

            // Find the SMS that contained this link
            let smsLog = null;
            let installId = hitData.installId || null;
            let contactId = hitData.contactId || null;

            if (messageId) {
                smsLog = await SmsLog.findOne({ messageId });
                if (smsLog) {
                    installId = smsLog.installId;
                    contactId = smsLog.contactId;
                }
            }

            // If not found by messageId, try by mobile number
            if (!smsLog && mobileNumber) {
                const recentSms = await SmsLog.find({
                    mobileNumber,
                    'trackedLink.shortUrl': { $exists: true }
                }).sort({ createdAt: -1 }).limit(1);

                if (recentSms.length > 0) {
                    smsLog = recentSms[0];
                    installId = smsLog.installId;
                    contactId = smsLog.contactId;
                }
            }

            // Create link hit record(s) - one for each hit
            for (let i = 0; i < linkHitsCount; i++) {
                const linkHit = new LinkHit({
                    smsLogId: smsLog ? smsLog._id : null,
                    installId,
                    contactId,
                    mobileNumber,
                    shortUrl,
                    originalUrl: smsLog?.trackedLink?.originalUrl || '',
                    clickedAt: timestamp,
                    ipAddress: req.ip,
                    userAgent: req.headers['user-agent'],
                    webhookData: hitData
                });

                await linkHit.save();
            }

            logger.webhook('linkhit_saved', {
                mobileNumber,
                shortUrl,
                hitCount: linkHitsCount,
                linkedToSms: !!smsLog
            });

            res.json({ 
                success: true, 
                message: 'Link hit processed',
                hitCount: linkHitsCount
            });

        } catch (error) {
            logger.error('Error processing link hit', {
                error: error.message,
                hitData
            });
            
            // Still return 200 to prevent retries
            res.json({ 
                success: false, 
                error: error.message 
            });
        }
    });

    /**
     * Map TransmitSMS DLR status to our status
     */
    static mapDlrStatus(transmitStatus) {
        const statusMap = {
            'delivered': 'delivered',
            'sent': 'sent',
            'failed': 'failed',
            'expired': 'expired',
            'rejected': 'failed',
            'undelivered': 'failed',
            'pending': 'pending'
        };

        return statusMap[transmitStatus?.toLowerCase()] || 'pending';
    }
}

module.exports = WebhookController;