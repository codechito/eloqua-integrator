// controllers/webhookController.js - COMPLETE MERGED VERSION

const { Consumer, SmsLog, SmsReply, LinkHit, ActionInstance } = require('../models');
const { EloquaService } = require('../services');
const DecisionController = require('./decisionController');
const { logger } = require('../utils');
const { asyncHandler } = require('../middleware');

class WebhookController {
    /**
     * Handle Delivery Reports (DLR)
     * POST /webhooks/dlr?installId=xxx&instanceId=xxx&contactId=xxx&executionId=xxx&mobile=xxx
     */
    static handleDeliveryReport = asyncHandler(async (req, res) => {
        const queryParams = req.query;
        const bodyData = req.body;
        const dlrData = { ...queryParams, ...bodyData };
        
        logger.webhook('dlr_received', { 
            messageId: dlrData.message_id,
            status: dlrData.status,
            mobile: dlrData.mobile || queryParams.mobile,
            installId: queryParams.installId,
            instanceId: queryParams.instanceId,
            contactId: queryParams.contactId,
            executionId: queryParams.executionId,
            queryParams,
            bodyData
        });

        try {
            let smsLog = null;

            // STRATEGY 1: Try to find by messageId (most reliable)
            if (dlrData.message_id) {
                smsLog = await SmsLog.findOne({
                    messageId: dlrData.message_id,
                    installId: queryParams.installId
                });

                if (smsLog) {
                    logger.debug('SMS log found by messageId', {
                        messageId: dlrData.message_id,
                        smsLogId: smsLog._id
                    });
                }
            }

            // STRATEGY 2: Fallback - find by contactId + mobile + recent timestamp
            if (!smsLog && queryParams.contactId && queryParams.mobile) {
                smsLog = await SmsLog.findOne({
                    installId: queryParams.installId,
                    contactId: queryParams.contactId,
                    mobileNumber: queryParams.mobile,
                    sentAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Last 24 hours
                }).sort({ sentAt: -1 });

                if (smsLog) {
                    logger.debug('SMS log found by contactId + mobile', {
                        contactId: queryParams.contactId,
                        mobile: queryParams.mobile,
                        smsLogId: smsLog._id
                    });
                }
            }

            if (!smsLog) {
                logger.warn('SMS log not found for DLR', {
                    messageId: dlrData.message_id,
                    contactId: queryParams.contactId,
                    mobile: queryParams.mobile || dlrData.mobile,
                    installId: queryParams.installId
                });
                return res.status(200).json({ 
                    success: true, 
                    message: 'DLR received but SMS log not found' 
                });
            }

            // Update SMS log with DLR data
            const previousStatus = smsLog.status;
            
            // Map TransmitSMS status to our status
            const newStatus = WebhookController.mapDlrStatus(dlrData.status);
            smsLog.status = newStatus;
            
            if (newStatus === 'delivered' || dlrData.status === 'delivered') {
                smsLog.deliveredAt = new Date(dlrData.datetime || Date.now());
            }

            if (newStatus === 'failed' || dlrData.status === 'failed') {
                smsLog.errorMessage = dlrData.error_text || dlrData.error_message || `Status: ${dlrData.status}`;
                smsLog.errorCode = dlrData.error_code;
            }

            // Store DLR data in array (for multiple DLRs)
            if (!smsLog.deliveryReceipts) {
                smsLog.deliveryReceipts = [];
            }
            
            smsLog.deliveryReceipts.push({
                status: dlrData.status,
                timestamp: new Date(dlrData.datetime || Date.now()),
                data: dlrData
            });

            await smsLog.save();

            logger.info('SMS log updated with DLR', {
                smsLogId: smsLog._id,
                messageId: smsLog.messageId,
                previousStatus,
                newStatus,
                deliveredAt: smsLog.deliveredAt
            });

            res.status(200).json({ 
                success: true, 
                message: 'DLR processed',
                smsLogId: smsLog._id,
                status: newStatus
            });

        } catch (error) {
            logger.error('Error processing DLR', {
                error: error.message,
                stack: error.stack,
                dlrData
            });
            
            // Still return 200 to prevent TransmitSMS from retrying
            res.status(200).json({ 
                success: false, 
                error: error.message 
            });
        }
    });

    /**
     * Handle SMS Replies
     * POST /webhooks/reply?installId=xxx&instanceId=xxx&contactId=xxx&executionId=xxx&mobile=xxx
     */
    static handleSmsReply = asyncHandler(async (req, res) => {
        const queryParams = req.query;
        const bodyData = req.body;
        const replyData = { ...queryParams, ...bodyData };
        
        logger.webhook('reply_received', { 
            from: replyData.mobile || bodyData.mobile,
            message: replyData.response || bodyData.response || bodyData.message,
            messageId: replyData.message_id || bodyData.message_id,
            responseId: replyData.response_id || bodyData.response_id,
            installId: queryParams.installId,
            instanceId: queryParams.instanceId,
            contactId: queryParams.contactId,
            executionId: queryParams.executionId,
            queryParams,
            bodyData
        });

        try {
            const fromNumber = replyData.mobile || bodyData.mobile || queryParams.mobile;
            const toNumber = replyData.longcode || bodyData.longcode || bodyData.to;
            const message = replyData.response || bodyData.response || bodyData.message || bodyData.text;
            const messageId = replyData.message_id || bodyData.message_id;
            const responseId = replyData.response_id || bodyData.response_id || bodyData.id;
            const timestamp = replyData.datetime_entry || bodyData.datetime_entry
                ? new Date(replyData.datetime_entry || bodyData.datetime_entry) 
                : new Date();
            const isOptOut = (replyData.is_optout || bodyData.is_optout) === 'yes';

            // Find the original SMS
            let smsLog = null;
            let installId = queryParams.installId;
            let contactId = queryParams.contactId;

            // STRATEGY 1: Try to find by message ID first
            if (messageId) {
                smsLog = await SmsLog.findOne({ 
                    messageId,
                    installId: installId
                });
                
                if (smsLog) {
                    installId = smsLog.installId;
                    contactId = smsLog.contactId;
                    
                    logger.info('Found SMS log by message ID', {
                        messageId,
                        smsLogId: smsLog._id,
                        hasDecision: !!smsLog.decisionInstanceId,
                        decisionStatus: smsLog.decisionStatus
                    });
                }
            }

            // STRATEGY 2: If not found by messageId, try by mobile number (most recent)
            if (!smsLog && fromNumber) {
                const recentSms = await SmsLog.find({
                    mobileNumber: fromNumber,
                    installId: installId
                }).sort({ createdAt: -1 }).limit(10);

                if (recentSms.length > 0) {
                    // Prefer SMS with pending decision
                    smsLog = recentSms.find(log => 
                        log.decisionInstanceId && 
                        log.decisionStatus === 'pending'
                    ) || recentSms[0];
                    
                    installId = smsLog.installId;
                    contactId = smsLog.contactId;
                    
                    logger.info('Found SMS log by mobile number', {
                        mobile: fromNumber,
                        smsLogId: smsLog._id,
                        hasDecision: !!smsLog.decisionInstanceId,
                        decisionStatus: smsLog.decisionStatus,
                        candidateCount: recentSms.length
                    });
                }
            }

            // STRATEGY 3: Try by contactId + mobile from query params
            if (!smsLog && contactId && fromNumber) {
                smsLog = await SmsLog.findOne({
                    installId: installId,
                    contactId: contactId,
                    mobileNumber: fromNumber,
                    sentAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // Last 7 days
                }).sort({ sentAt: -1 });

                if (smsLog) {
                    logger.info('Found SMS log by contactId + mobile', {
                        contactId,
                        mobile: fromNumber,
                        smsLogId: smsLog._id,
                        hasDecision: !!smsLog.decisionInstanceId
                    });
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
                webhookData: replyData,
                processed: false
            });

            await smsReply.save();

            logger.webhook('reply_saved', {
                replyId: smsReply._id,
                fromNumber,
                message: message?.substring(0, 50),
                isOptOut,
                linkedToSms: !!smsLog,
                hasDecision: !!(smsLog && smsLog.decisionInstanceId)
            });

            // Update SMS log with response
            if (smsLog) {
                smsLog.hasResponse = true;
                smsLog.responseMessage = message;
                smsLog.responseReceivedAt = timestamp;
                smsLog.responseMessageId = responseId;
                smsLog.linkedReplyId = smsReply._id;
                
                await smsLog.save();
                
                logger.info('SMS log updated with reply', {
                    smsLogId: smsLog._id,
                    messageId: smsLog.messageId,
                    hasResponse: true,
                    decisionInstanceId: smsLog.decisionInstanceId
                });
            }

            // Process for decision evaluation
            let decisionResult = null;
            
            if (smsLog && smsLog.decisionInstanceId) {
                try {
                    logger.info('Processing reply for decision evaluation', {
                        replyId: smsReply._id,
                        smsLogId: smsLog._id,
                        decisionInstanceId: smsLog.decisionInstanceId,
                        decisionStatus: smsLog.decisionStatus
                    });

                    decisionResult = await DecisionController.processReply(smsReply, smsLog);

                    if (decisionResult) {
                        smsReply.processed = true;
                        smsReply.processedAt = new Date();
                        await smsReply.save();

                        logger.info('Decision processed from reply', {
                            replyId: smsReply._id,
                            decision: decisionResult.decision,
                            matches: decisionResult.matches
                        });
                    }
                } catch (decisionError) {
                    logger.error('Error processing decision from reply', {
                        replyId: smsReply._id,
                        error: decisionError.message,
                        stack: decisionError.stack
                    });
                    // Don't fail the webhook - just log the error
                }
            }

            // Update custom object if configured
            if (smsLog && message && !isOptOut) {
                try {
                    const consumer = await Consumer.findOne({ installId });
                    if (consumer?.actions?.receivesms?.custom_object_id) {
                        const instance = await ActionInstance.findOne({ instanceId: smsLog.instanceId });
                        if (instance) {
                            const eloquaService = new EloquaService(installId, instance.SiteId);
                            await eloquaService.initialize();
                            
                            await WebhookController.updateReplyCustomObject(
                                eloquaService,
                                consumer,
                                smsLog,
                                message
                            );
                        }
                    }
                } catch (cdoError) {
                    logger.error('Error updating reply custom object', {
                        replyId: smsReply._id,
                        error: cdoError.message
                    });
                }
            }

            res.status(200).json({ 
                success: true, 
                message: 'Reply processed',
                replyId: smsReply._id,
                linkedToSms: !!smsLog,
                decision: decisionResult?.decision || null
            });

        } catch (error) {
            logger.error('Error processing SMS reply', {
                error: error.message,
                stack: error.stack,
                replyData
            });
            
            // Still return 200 to prevent retries
            res.status(200).json({ 
                success: false, 
                error: error.message 
            });
        }
    });

    /**
     * Handle Link Hits
     * POST /webhooks/linkhit?installId=xxx&instanceId=xxx&contactId=xxx&executionId=xxx&mobile=xxx
     */
    static handleLinkHit = asyncHandler(async (req, res) => {
        const queryParams = req.query;
        const bodyData = req.body;
        const hitData = { ...queryParams, ...bodyData };
        
        logger.webhook('linkhit_received', { 
            mobile: hitData.mobile || bodyData.mobile || queryParams.mobile,
            messageId: hitData.message_id || bodyData.message_id,
            linkHits: hitData.link_hits || bodyData.link_hits,
            installId: queryParams.installId,
            instanceId: queryParams.instanceId,
            contactId: queryParams.contactId,
            executionId: queryParams.executionId,
            queryParams,
            bodyData
        });

        try {
            const mobileNumber = hitData.mobile || bodyData.mobile || queryParams.mobile;
            const messageId = hitData.message_id || bodyData.message_id;
            const timestamp = hitData.datetime || bodyData.datetime
                ? new Date(hitData.datetime || bodyData.datetime) 
                : new Date();
            const linkHitsCount = parseInt(hitData.link_hits || bodyData.link_hits) || 1;
            const shortUrl = hitData.short_url || bodyData.short_url;
            const originalUrl = hitData.original_url || bodyData.original_url || bodyData.destination_url;

            // Find the SMS that contained this link
            let smsLog = null;
            let installId = queryParams.installId;
            let contactId = queryParams.contactId;

            // STRATEGY 1: Try by messageId
            if (messageId) {
                smsLog = await SmsLog.findOne({ 
                    messageId,
                    installId: installId
                });
                
                if (smsLog) {
                    installId = smsLog.installId;
                    contactId = smsLog.contactId;
                    
                    logger.debug('SMS log found by messageId for link hit', {
                        messageId,
                        smsLogId: smsLog._id
                    });
                }
            }

            // STRATEGY 2: Try by contactId + mobile
            if (!smsLog && contactId && mobileNumber) {
                smsLog = await SmsLog.findOne({
                    installId: installId,
                    contactId: contactId,
                    mobileNumber: mobileNumber,
                    trackedLinkRequested: true,
                    sentAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } // Last 30 days
                }).sort({ sentAt: -1 });

                if (smsLog) {
                    logger.debug('SMS log found by contactId + mobile for link hit', {
                        contactId,
                        mobile: mobileNumber,
                        smsLogId: smsLog._id
                    });
                }
            }

            // STRATEGY 3: Fallback by mobile number only
            if (!smsLog && mobileNumber) {
                smsLog = await SmsLog.findOne({
                    mobileNumber,
                    trackedLinkRequested: true,
                    sentAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
                }).sort({ sentAt: -1 });

                if (smsLog) {
                    installId = smsLog.installId;
                    contactId = smsLog.contactId;
                    
                    logger.debug('SMS log found by mobile number for link hit', {
                        mobile: mobileNumber,
                        smsLogId: smsLog._id
                    });
                }
            }

            if (!smsLog) {
                logger.warn('SMS log not found for link hit', {
                    messageId,
                    contactId,
                    mobile: mobileNumber,
                    installId
                });
            }

            // Create link hit record(s) - one for each hit
            const createdHits = [];
            for (let i = 0; i < linkHitsCount; i++) {
                const linkHit = new LinkHit({
                    smsLogId: smsLog ? smsLog._id : null,
                    installId,
                    contactId,
                    mobileNumber,
                    shortUrl,
                    originalUrl: originalUrl || smsLog?.trackedLinkOriginalUrl || '',
                    clickedAt: timestamp,
                    ipAddress: req.ip || hitData.ip_address || bodyData.ip_address,
                    userAgent: req.headers['user-agent'] || hitData.user_agent || bodyData.user_agent,
                    webhookData: hitData
                });

                await linkHit.save();
                createdHits.push(linkHit._id);
            }

            // Update SMS log with link hit data
            if (smsLog) {
                if (!smsLog.linkHits) {
                    smsLog.linkHits = [];
                }

                smsLog.linkHits.push({
                    clickedAt: timestamp,
                    shortUrl: shortUrl,
                    originalUrl: originalUrl || smsLog.trackedLinkOriginalUrl,
                    ipAddress: req.ip,
                    userAgent: req.headers['user-agent'],
                    data: hitData
                });

                smsLog.linkClickCount = (smsLog.linkClickCount || 0) + linkHitsCount;
                smsLog.firstLinkClickAt = smsLog.firstLinkClickAt || timestamp;
                smsLog.lastLinkClickAt = timestamp;

                await smsLog.save();

                logger.info('SMS log updated with link hit', {
                    smsLogId: smsLog._id,
                    messageId: smsLog.messageId,
                    linkClickCount: smsLog.linkClickCount,
                    shortUrl
                });
            }

            logger.webhook('linkhit_saved', {
                mobileNumber,
                shortUrl,
                hitCount: linkHitsCount,
                linkedToSms: !!smsLog,
                createdHitIds: createdHits
            });

            // Update custom object if configured
            if (smsLog) {
                try {
                    const consumer = await Consumer.findOne({ installId });
                    if (consumer?.actions?.tracked_link?.custom_object_id) {
                        const instance = await ActionInstance.findOne({ instanceId: smsLog.instanceId });
                        if (instance) {
                            const eloquaService = new EloquaService(installId, instance.SiteId);
                            await eloquaService.initialize();
                            
                            await WebhookController.updateLinkHitCustomObject(
                                eloquaService,
                                consumer,
                                smsLog,
                                hitData
                            );
                        }
                    }
                } catch (cdoError) {
                    logger.error('Error updating link hit custom object', {
                        error: cdoError.message
                    });
                }
            }

            res.status(200).json({ 
                success: true, 
                message: 'Link hit processed',
                hitCount: linkHitsCount,
                linkedToSms: !!smsLog,
                linkHitIds: createdHits
            });

        } catch (error) {
            logger.error('Error processing link hit', {
                error: error.message,
                stack: error.stack,
                hitData
            });
            
            // Still return 200 to prevent retries
            res.status(200).json({ 
                success: false, 
                error: error.message 
            });
        }
    });

    /**
     * Update custom object for SMS replies
     */
    static async updateReplyCustomObject(eloquaService, consumer, smsLog, replyMessage) {
        try {
            const cdoConfig = consumer.actions.receivesms;
            
            if (!cdoConfig.custom_object_id) {
                return;
            }

            logger.info('Updating reply custom object', {
                customObjectId: cdoConfig.custom_object_id,
                contactId: smsLog.contactId
            });

            // Fetch CDO field map
            const cdoFieldMap = await eloquaService.getCustomObjectFieldMap(cdoConfig.custom_object_id);

            const fieldMap = new Map();

            const addField = (fieldName, value) => {
                if (!fieldName || !fieldName.trim()) return;
                
                const field = cdoFieldMap[fieldName.trim()];
                if (!field || !field.id) {
                    logger.warn('Field not found in CDO for reply', { fieldName: fieldName.trim() });
                    return;
                }
                
                fieldMap.set(field.id, value || '');
            };

            addField(cdoConfig.mobile_field, smsLog.mobileNumber);
            addField(cdoConfig.email_field, smsLog.emailAddress);
            addField(cdoConfig.response_field, replyMessage ? replyMessage.substring(0, 250) : '');
            addField(cdoConfig.title_field, smsLog.campaignTitle);
            addField(cdoConfig.vn_field, smsLog.senderId);

            if (fieldMap.size === 0) {
                logger.warn('No valid fields for reply CDO');
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

            await eloquaService.createCustomObjectRecord(cdoConfig.custom_object_id, cdoData);

            logger.info('Reply custom object updated', {
                customObjectId: cdoConfig.custom_object_id,
                contactId: smsLog.contactId,
                fieldCount: cdoData.fieldValues.length
            });

        } catch (error) {
            logger.error('Error updating reply custom object', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Update custom object for link hits
     */
    static async updateLinkHitCustomObject(eloquaService, consumer, smsLog, linkHitData) {
        try {
            const cdoConfig = consumer.actions.tracked_link;
            
            if (!cdoConfig.custom_object_id) {
                return;
            }

            logger.info('Updating link hit custom object', {
                customObjectId: cdoConfig.custom_object_id,
                contactId: smsLog.contactId
            });

            // Fetch CDO field map
            const cdoFieldMap = await eloquaService.getCustomObjectFieldMap(cdoConfig.custom_object_id);

            const fieldMap = new Map();

            const addField = (fieldName, value) => {
                if (!fieldName || !fieldName.trim()) return;
                
                const field = cdoFieldMap[fieldName.trim()];
                if (!field || !field.id) {
                    logger.warn('Field not found in CDO for link hit', { fieldName: fieldName.trim() });
                    return;
                }
                
                fieldMap.set(field.id, value || '');
            };

            addField(cdoConfig.mobile_field, smsLog.mobileNumber);
            addField(cdoConfig.email_field, smsLog.emailAddress);
            addField(cdoConfig.vn_field, smsLog.senderId);
            addField(cdoConfig.title_field, smsLog.campaignTitle);
            addField(cdoConfig.link_hits, String(smsLog.linkClickCount || 1));
            addField(cdoConfig.url_field, linkHitData.short_url);
            addField(cdoConfig.originalurl_field, linkHitData.original_url || smsLog.trackedLinkOriginalUrl);

            if (fieldMap.size === 0) {
                logger.warn('No valid fields for link hit CDO');
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

            await eloquaService.createCustomObjectRecord(cdoConfig.custom_object_id, cdoData);

            logger.info('Link hit custom object updated', {
                customObjectId: cdoConfig.custom_object_id,
                contactId: smsLog.contactId,
                fieldCount: cdoData.fieldValues.length
            });

        } catch (error) {
            logger.error('Error updating link hit custom object', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

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
            'pending': 'pending',
            'queued': 'pending'
        };

        return statusMap[transmitStatus?.toLowerCase()] || 'pending';
    }
}

module.exports = WebhookController;