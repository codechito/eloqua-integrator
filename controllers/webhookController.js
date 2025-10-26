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
        const dlrData = req.body;
        
        logger.webhook('dlr_received', { 
            messageId: dlrData.message_id,
            status: dlrData.status 
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
                    smsLog.deliveredAt = new Date();
                }

                if (dlrData.error_code) {
                    smsLog.errorMessage = dlrData.error_text || `Error code: ${dlrData.error_code}`;
                    smsLog.errorCode = dlrData.error_code;
                }

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
        const replyData = req.body;
        
        logger.webhook('reply_received', { 
            from: replyData.from || replyData.mobile,
            message: replyData.message 
        });

        try {
            const fromNumber = replyData.from || replyData.mobile;
            const toNumber = replyData.to || replyData.destination;
            const message = replyData.message || replyData.message_text;
            const timestamp = replyData.timestamp 
                ? new Date(replyData.timestamp * 1000) 
                : new Date();

            // Find the original SMS(s)
            const smsLogs = await SmsLog.find({
                mobileNumber: fromNumber
            }).sort({ createdAt: -1 }).limit(10);

            let smsLogId = null;
            let installId = null;

            if (smsLogs.length > 0) {
                // Associate with most recent SMS
                const smsLog = smsLogs[0];
                smsLogId = smsLog._id;
                installId = smsLog.installId;

                logger.debug('Reply associated with SMS', {
                    smsLogId,
                    fromNumber
                });
            } else {
                logger.warn('No associated SMS found for reply', {
                    fromNumber
                });
            }

            // Create reply record
            const smsReply = new SmsReply({
                smsLogId,
                installId,
                fromNumber,
                toNumber,
                message,
                receivedAt: timestamp,
                webhookData: replyData
            });

            await smsReply.save();

            logger.webhook('reply_saved', {
                replyId: smsReply._id,
                fromNumber,
                isOptOut: smsReply.isOptOut
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
        const hitData = req.body;
        
        logger.webhook('linkhit_received', { 
            mobile: hitData.mobile || hitData.to,
            url: hitData.short_url || hitData.link 
        });

        try {
            const mobileNumber = hitData.mobile || hitData.to;
            const shortUrl = hitData.short_url || hitData.link;
            const originalUrl = hitData.original_url || hitData.destination;
            const timestamp = hitData.timestamp 
                ? new Date(hitData.timestamp * 1000) 
                : new Date();

            // Find the SMS that contained this link
            const smsLog = await SmsLog.findOne({
                mobileNumber,
                'trackedLink.shortUrl': shortUrl
            }).sort({ createdAt: -1 });

            let smsLogId = null;
            let installId = null;

            if (smsLog) {
                smsLogId = smsLog._id;
                installId = smsLog.installId;

                logger.debug('Link hit associated with SMS', {
                    smsLogId,
                    mobileNumber,
                    shortUrl
                });
            } else {
                // Try to find by mobile number and approximate URL
                const recentSms = await SmsLog.findOne({
                    mobileNumber,
                    message: { $regex: new RegExp(shortUrl.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')) }
                }).sort({ createdAt: -1 });

                if (recentSms) {
                    smsLogId = recentSms._id;
                    installId = recentSms.installId;
                }

                logger.warn('No exact SMS match found for link hit', {
                    mobileNumber,
                    shortUrl,
                    foundApproximate: !!recentSms
                });
            }

            // Create link hit record
            const linkHit = new LinkHit({
                smsLogId,
                installId,
                mobileNumber,
                shortUrl,
                originalUrl,
                clickedAt: timestamp,
                ipAddress: hitData.ip_address || req.ip,
                userAgent: hitData.user_agent || req.headers['user-agent'],
                webhookData: hitData
            });

            await linkHit.save();

            logger.webhook('linkhit_saved', {
                linkHitId: linkHit._id,
                mobileNumber,
                shortUrl
            });

            res.json({ 
                success: true, 
                message: 'Link hit processed',
                linkHitId: linkHit._id 
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