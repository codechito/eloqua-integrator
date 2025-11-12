// workers/decisionCleanupWorker.js - UPDATED VERSION

const { DecisionInstance, SmsLog } = require('../models');
const { logger } = require('../utils');
const DecisionController = require('../controllers/decisionController');

class DecisionCleanupWorker {
    constructor() {
        this.isRunning = false;
        this.interval = null;
        this.statsInterval = null;
        
        // Statistics
        this.stats = {
            startedAt: null,
            lastPollAt: null,
            totalProcessed: 0,
            totalYes: 0,
            totalNo: 0,
            totalPending: 0,
            totalExpired: 0,
            totalErrors: 0,
            currentBatchSize: 0
        };
        
        // Configuration
        this.config = {
            pollIntervalMs: 10 * 60 * 1000, // 10 minutes
            statsIntervalMs: 5 * 60 * 1000, // Log stats every 5 minutes
            batchSize: 100
        };
    }

    /**
     * Start the cleanup worker
     * Runs every 10 minutes
     */
    start() {
        if (this.isRunning) {
            logger.warn('Decision cleanup worker already running');
            return;
        }

        logger.info('Starting decision cleanup worker', {
            pollInterval: this.config.pollIntervalMs,
            statsInterval: this.config.statsIntervalMs,
            batchSize: this.config.batchSize
        });
        
        this.isRunning = true;
        this.stats.startedAt = new Date();
        
        // Run immediately
        this.processExpiredDecisions();
        
        // Then run every 10 minutes
        this.interval = setInterval(() => {
            this.processExpiredDecisions();
        }, this.config.pollIntervalMs);

        // Start periodic stats logging (every 5 minutes)
        this.statsInterval = setInterval(() => {
            this.logStats();
        }, this.config.statsIntervalMs);

        logger.info('Decision cleanup worker started successfully');
    }

    /**
     * Stop the cleanup worker
     */
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = null;
        }
        this.isRunning = false;
        
        logger.info('Decision cleanup worker stopped', {
            totalProcessed: this.stats.totalProcessed,
            totalYes: this.stats.totalYes,
            totalNo: this.stats.totalNo,
            totalExpired: this.stats.totalExpired
        });
    }

    /**
     * Process expired decision evaluations
     * FIXED: Now logs to CDO when decisions are made
     */
    async processExpiredDecisions() {
        try {
            logger.info('Processing expired decision evaluations');

            const now = new Date();

            // Find all pending decisions that have passed their deadline
            const expiredLogs = await SmsLog.find({
                decisionStatus: 'pending',
                decisionDeadline: { $lt: now },
                decisionInstanceId: { $ne: null }
            }).limit(1000); // Process max 1000 per run

            if (expiredLogs.length === 0) {
                logger.debug('No expired decision evaluations found');
                return;
            }

            logger.info('Found expired decision evaluations', {
                count: expiredLogs.length
            });

            // Group by instance for bulk processing
            const groupedByInstance = {};

            for (const smsLog of expiredLogs) {
                try {
                    const instance = await DecisionInstance.findOne({
                        instanceId: smsLog.decisionInstanceId,
                        isActive: true
                    });

                    if (!instance) {
                        logger.warn('Decision instance not found for expired log', {
                            instanceId: smsLog.decisionInstanceId,
                            contactId: smsLog.contactId
                        });
                        continue;
                    }

                    const consumer = await Consumer.findOne({
                        installId: instance.installId
                    });

                    if (!consumer) {
                        logger.error('Consumer not found for decision', {
                            installId: instance.installId
                        });
                        continue;
                    }

                    // Evaluate the response (if any)
                    let decision = 'no';
                    if (smsLog.hasResponse) {
                        const matches = DecisionController.evaluateReply(
                            smsLog.responseMessage,
                            instance.text_type,
                            instance.keyword
                        );
                        decision = matches ? 'yes' : 'no';
                    }

                    // Update SMS log
                    smsLog.decisionStatus = decision;
                    smsLog.decisionProcessedAt = new Date();
                    await smsLog.save();

                    logger.info('Decision evaluated on expiry', {
                        contactId: smsLog.contactId,
                        messageId: smsLog.messageId,
                        decision,
                        hadResponse: smsLog.hasResponse
                    });

                    // Log to CDO if there was a response
                    if (smsLog.hasResponse && consumer.actions?.receivesms?.custom_object_id) {
                        try {
                            const eloquaService = new EloquaService(
                                consumer.installId,
                                instance.SiteId
                            );
                            await eloquaService.initialize();

                            await DecisionController.updateCustomObject(
                                eloquaService,
                                instance,
                                consumer,
                                smsLog,
                                smsLog.responseMessage
                            );

                            logger.info('CDO updated for expired decision', {
                                contactId: smsLog.contactId,
                                decision,
                                responseMessage: smsLog.responseMessage?.substring(0, 50)
                            });
                        } catch (cdoError) {
                            logger.error('Failed to update CDO for expired decision', {
                                contactId: smsLog.contactId,
                                error: cdoError.message
                            });
                        }
                    }

                    // Group for potential bulk sync (optional - may not work without executionId)
                    const key = smsLog.decisionInstanceId;
                    if (!groupedByInstance[key]) {
                        groupedByInstance[key] = {
                            instance,
                            consumer,
                            yes: [],
                            no: []
                        };
                    }

                    groupedByInstance[key][decision].push({
                        contactId: smsLog.contactId,
                        emailAddress: smsLog.emailAddress,
                        messageId: smsLog.messageId,
                        responseMessage: smsLog.responseMessage
                    });

                } catch (error) {
                    logger.error('Error processing expired decision for contact', {
                        contactId: smsLog.contactId,
                        error: error.message
                    });
                }
            }

            logger.info('Expired decision processing completed', {
                totalProcessed: expiredLogs.length,
                instancesAffected: Object.keys(groupedByInstance).length
            });

            // Log summary by instance
            for (const [instanceId, data] of Object.entries(groupedByInstance)) {
                logger.info('Expired decisions processed for instance', {
                    instanceId,
                    yesCount: data.yes.length,
                    noCount: data.no.length,
                    note: 'CDO records created for contacts with responses'
                });
            }

        } catch (error) {
            logger.error('Error in processExpiredDecisions', {
                error: error.message,
                stack: error.stack
            });
        }
    }

    /**
     * Get current decision statistics
     */
    async getDecisionStats() {
        try {
            const now = new Date();

            // Count by decision status
            const statusCounts = await SmsLog.aggregate([
                {
                    $match: {
                        decisionInstanceId: { $ne: null }
                    }
                },
                {
                    $group: {
                        _id: '$decisionStatus',
                        count: { $sum: 1 }
                    }
                }
            ]);

            // Count waiting for response (pending and not expired)
            const waitingForResponse = await SmsLog.countDocuments({
                decisionInstanceId: { $ne: null },
                decisionStatus: 'pending',
                decisionDeadline: { $gte: now }
            });

            // Count waiting for cleanup (pending and expired)
            const waitingForCleanup = await SmsLog.countDocuments({
                decisionInstanceId: { $ne: null },
                decisionStatus: 'pending',
                decisionDeadline: { $lt: now }
            });

            const stats = {
                yes: 0,
                no: 0,
                pending: 0,
                waitingForResponse,
                waitingForCleanup
            };

            statusCounts.forEach(item => {
                if (item._id === 'yes') stats.yes = item.count;
                else if (item._id === 'no') stats.no = item.count;
                else if (item._id === 'pending') stats.pending = item.count;
            });

            return stats;

        } catch (error) {
            logger.error('Error getting decision stats', {
                error: error.message
            });
            return {
                yes: 0,
                no: 0,
                pending: 0,
                waitingForResponse: 0,
                waitingForCleanup: 0
            };
        }
    }

    /**
     * Log worker statistics
     */
    async logStats() {
        try {
            const uptime = this.stats.startedAt 
                ? Date.now() - this.stats.startedAt.getTime()
                : 0;

            const uptimeHuman = this.formatUptime(uptime);

            // Get current decision counts
            const currentStats = await this.getDecisionStats();

            const stats = {
                status: this.isRunning ? 'running' : 'stopped',
                startedAt: this.stats.startedAt,
                uptime,
                uptimeHuman,
                
                // Lifetime stats
                totalProcessed: this.stats.totalProcessed,
                totalYes: this.stats.totalYes,
                totalNo: this.stats.totalNo,
                totalExpired: this.stats.totalExpired,
                totalErrors: this.stats.totalErrors,
                
                // Current state
                currentPending: currentStats.pending,
                waitingForResponse: currentStats.waitingForResponse,
                waitingForCleanup: currentStats.waitingForCleanup,
                currentYes: currentStats.yes,
                currentNo: currentStats.no,
                
                // Last poll
                lastPollAt: this.stats.lastPollAt,
                currentBatchSize: this.stats.currentBatchSize,
                
                // Config
                pollInterval: this.config.pollIntervalMs,
                batchSize: this.config.batchSize
            };

            logger.info('Decision Worker Stats', stats);

        } catch (error) {
            logger.error('Error logging decision worker stats', {
                error: error.message
            });
        }
    }

    /**
     * Format uptime in human readable format
     */
    formatUptime(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) {
            return `${days}d ${hours % 24}h ${minutes % 60}m`;
        } else if (hours > 0) {
            return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        } else {
            return `${seconds}s`;
        }
    }

    /**
     * Get worker stats (for health checks)
     */
    async getStats() {
        const uptime = this.stats.startedAt 
            ? Date.now() - this.stats.startedAt.getTime()
            : 0;

        const currentStats = await this.getDecisionStats();

        return {
            isRunning: this.isRunning,
            hasInterval: !!this.interval,
            startedAt: this.stats.startedAt,
            uptime,
            uptimeHuman: this.formatUptime(uptime),
            totalProcessed: this.stats.totalProcessed,
            totalYes: this.stats.totalYes,
            totalNo: this.stats.totalNo,
            totalExpired: this.stats.totalExpired,
            totalErrors: this.stats.totalErrors,
            currentPending: currentStats.pending,
            waitingForResponse: currentStats.waitingForResponse,
            waitingForCleanup: currentStats.waitingForCleanup,
            lastPollAt: this.stats.lastPollAt
        };
    }
}

module.exports = DecisionCleanupWorker;