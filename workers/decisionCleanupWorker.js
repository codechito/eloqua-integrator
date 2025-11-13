// workers/decisionCleanupWorker.js - COMPLETE MERGED VERSION

const { DecisionInstance, SmsLog, Consumer } = require('../models');
const { EloquaService } = require('../services');
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
            currentBatchSize: 0,
            lastBatchProcessed: 0
        };
        
        // Configuration
        this.config = {
            pollIntervalMs: 2 * 60 * 1000, // 2 minutes
            statsIntervalMs: 5 * 60 * 1000, // Log stats every 5 minutes
            batchSize: 30 // Maximum 30 recipients per batch
        };
    }

    /**
     * Start the cleanup worker
     * Runs every 2 minutes, processes max 30 recipients per batch
     */
    start() {
        if (this.isRunning) {
            logger.warn('Decision cleanup worker already running');
            return;
        }

        logger.info('Starting decision cleanup worker', {
            pollInterval: `${this.config.pollIntervalMs / 1000 / 60} minutes`,
            statsInterval: `${this.config.statsIntervalMs / 1000 / 60} minutes`,
            batchSize: this.config.batchSize,
            action: 'No reply after interval → NO path'
        });
        
        this.isRunning = true;
        this.stats.startedAt = new Date();
        
        // Run immediately (after 5 seconds for initialization)
        setTimeout(() => {
            logger.info('Running initial decision cleanup');
            this.processExpiredDecisions();
        }, 5000);
        
        // Then run every 2 minutes
        this.interval = setInterval(() => {
            this.processExpiredDecisions();
        }, this.config.pollIntervalMs);

        // Start periodic stats logging (every 5 minutes)
        this.statsInterval = setInterval(() => {
            this.logStats();
        }, this.config.statsIntervalMs);

        logger.info('Decision cleanup worker started successfully', {
            nextRun: `In ${this.config.pollIntervalMs / 1000 / 60} minutes`,
            maxPerBatch: this.config.batchSize
        });
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
     * - Maximum 30 recipients per batch
     * - No reply after interval → NO path
     */
    async processExpiredDecisions() {
        try {
            this.stats.lastPollAt = new Date();
            
            logger.info('Processing expired decision evaluations', {
                maxBatchSize: this.config.batchSize
            });

            const now = new Date();

            // Find all pending decisions that have passed their deadline
            // LIMIT to 30 recipients per run
            const expiredLogs = await SmsLog.find({
                decisionStatus: 'pending',
                decisionDeadline: { $lt: now },
                decisionInstanceId: { $ne: null, $exists: true }
            })
            .sort({ decisionDeadline: 1 }) // Process oldest first
            .limit(this.config.batchSize);

            if (expiredLogs.length === 0) {
                logger.debug('No expired decision evaluations found');
                this.stats.currentBatchSize = 0;
                return;
            }

            logger.info('Found expired decision evaluations', {
                count: expiredLogs.length,
                maxBatchSize: this.config.batchSize,
                now: now.toISOString(),
                oldestDeadline: expiredLogs[0]?.decisionDeadline,
                newestDeadline: expiredLogs[expiredLogs.length - 1]?.decisionDeadline
            });

            this.stats.currentBatchSize = expiredLogs.length;
            this.stats.totalExpired += expiredLogs.length;

            // Group by instance for better logging
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
                        
                        // Mark as processed anyway to prevent retry
                        smsLog.decisionStatus = 'no';
                        smsLog.decisionProcessedAt = now;
                        await smsLog.save();
                        
                        this.stats.totalNo++;
                        this.stats.totalProcessed++;
                        continue;
                    }

                    const consumer = await Consumer.findOne({
                        installId: instance.installId
                    });

                    if (!consumer) {
                        logger.error('Consumer not found for decision', {
                            installId: instance.installId
                        });
                        this.stats.totalErrors++;
                        continue;
                    }

                    // Evaluate the response (if any)
                    let decision = 'no';
                    let hasResponse = false;
                    
                    if (smsLog.hasResponse && smsLog.responseMessage) {
                        hasResponse = true;
                        const matches = DecisionController.evaluateReply(
                            smsLog.responseMessage,
                            instance.text_type,
                            instance.keyword
                        );
                        decision = matches ? 'yes' : 'no';
                        
                        logger.info('Decision evaluated with response', {
                            contactId: smsLog.contactId,
                            messageId: smsLog.messageId,
                            decision,
                            matches,
                            responsePreview: smsLog.responseMessage?.substring(0, 50)
                        });
                    } else {
                        // NO RESPONSE after deadline → NO path
                        decision = 'no';
                        
                        logger.info('Decision evaluated - NO RESPONSE (timeout)', {
                            contactId: smsLog.contactId,
                            messageId: smsLog.messageId,
                            decision: 'no',
                            deadline: smsLog.decisionDeadline,
                            hoursOverdue: ((now - smsLog.decisionDeadline) / (1000 * 60 * 60)).toFixed(2)
                        });
                    }

                    // Update SMS log
                    smsLog.decisionStatus = decision;
                    smsLog.decisionProcessedAt = now;
                    await smsLog.save();

                    // Update stats
                    if (decision === 'yes') {
                        this.stats.totalYes++;
                    } else {
                        this.stats.totalNo++;
                    }
                    this.stats.totalProcessed++;

                    // Log to CDO if there was a response (only if configured)
                    if (hasResponse && consumer.actions?.receivesms?.custom_object_id) {
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
                            // Don't throw - decision still processed
                        }
                    }

                    // Group for summary
                    const key = smsLog.decisionInstanceId;
                    if (!groupedByInstance[key]) {
                        groupedByInstance[key] = {
                            instance,
                            consumer,
                            yes: 0,
                            no: 0,
                            withResponse: 0,
                            noResponse: 0
                        };
                    }
                    
                    groupedByInstance[key][decision]++;
                    if (hasResponse) {
                        groupedByInstance[key].withResponse++;
                    } else {
                        groupedByInstance[key].noResponse++;
                    }

                } catch (error) {
                    logger.error('Error processing expired decision for contact', {
                        contactId: smsLog.contactId,
                        error: error.message,
                        stack: error.stack
                    });
                    this.stats.totalErrors++;
                }
            }

            this.stats.lastBatchProcessed = expiredLogs.length;

            logger.info('Expired decision batch completed', {
                totalInBatch: expiredLogs.length,
                processed: this.stats.lastBatchProcessed,
                errors: this.stats.totalErrors,
                yesInBatch: Object.values(groupedByInstance).reduce((sum, g) => sum + g.yes, 0),
                noInBatch: Object.values(groupedByInstance).reduce((sum, g) => sum + g.no, 0)
            });

            // Log summary by instance
            for (const [instanceId, data] of Object.entries(groupedByInstance)) {
                logger.info('Expired decisions processed for instance', {
                    instanceId,
                    yesCount: data.yes,
                    noCount: data.no,
                    withResponse: data.withResponse,
                    noResponse: data.noResponse,
                    total: data.yes + data.no,
                    note: 'CDO records created for contacts with responses'
                });
            }

        } catch (error) {
            logger.error('Error in processExpiredDecisions', {
                error: error.message,
                stack: error.stack
            });
            this.stats.totalErrors++;
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
                nextBatchSize: Math.min(currentStats.waitingForCleanup, this.config.batchSize),
                currentYes: currentStats.yes,
                currentNo: currentStats.no,
                
                // Last poll
                lastPollAt: this.stats.lastPollAt,
                lastBatchProcessed: this.stats.lastBatchProcessed,
                
                // Config
                pollInterval: `${this.config.pollIntervalMs / 1000 / 60} minutes`,
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
            
            // Lifetime totals
            totalProcessed: this.stats.totalProcessed,
            totalYes: this.stats.totalYes,
            totalNo: this.stats.totalNo,
            totalExpired: this.stats.totalExpired,
            totalErrors: this.stats.totalErrors,
            
            // Current state
            currentPending: currentStats.pending,
            waitingForResponse: currentStats.waitingForResponse,
            waitingForCleanup: currentStats.waitingForCleanup,
            nextBatchSize: Math.min(currentStats.waitingForCleanup, this.config.batchSize),
            
            // Last run
            lastPollAt: this.stats.lastPollAt,
            lastBatchProcessed: this.stats.lastBatchProcessed,
            
            // Config
            config: {
                pollIntervalMs: this.config.pollIntervalMs,
                pollIntervalMinutes: this.config.pollIntervalMs / 1000 / 60,
                batchSize: this.config.batchSize
            }
        };
    }

    /**
     * Manual trigger for testing
     */
    async triggerManually() {
        if (this.isRunning && this.interval) {
            logger.warn('Worker already running with scheduled interval');
        }

        logger.info('Manual decision cleanup triggered');
        await this.processExpiredDecisions();
        
        return this.getStats();
    }
}

module.exports = DecisionCleanupWorker;