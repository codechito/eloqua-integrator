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
     * Process expired decisions
     * Find SMS logs with pending decisions past their deadline
     */
    async processExpiredDecisions() {
        if (!this.isRunning) return;

        try {
            this.stats.lastPollAt = new Date();

            logger.debug('Polling for expired decisions');

            // Get overall decision statistics first
            const decisionStats = await this.getDecisionStats();

            // Find all SMS logs with expired pending decisions
            const expiredLogs = await SmsLog.find({
                decisionInstanceId: { $ne: null },
                decisionStatus: 'pending',
                decisionDeadline: { $lt: new Date() }
            }).limit(this.config.batchSize);

            this.stats.currentBatchSize = expiredLogs.length;

            if (expiredLogs.length === 0) {
                logger.debug('No expired decisions found', {
                    totalPending: decisionStats.pending,
                    waitingForResponse: decisionStats.waitingForResponse,
                    waitingForCleanup: 0
                });
                this.stats.currentBatchSize = 0;
                return;
            }

            logger.info('Found expired decisions to process', {
                count: expiredLogs.length,
                totalPending: decisionStats.pending,
                waitingForResponse: decisionStats.waitingForResponse,
                waitingForCleanup: expiredLogs.length,
                totalYesDecisions: decisionStats.yes,
                totalNoDecisions: decisionStats.no
            });

            let processedCount = 0;
            let errorCount = 0;

            for (const smsLog of expiredLogs) {
                try {
                    // Get decision instance
                    const instance = await DecisionInstance.findOne({
                        instanceId: smsLog.decisionInstanceId,
                        isActive: true
                    });

                    if (!instance) {
                        logger.warn('Decision instance not found for expired log', {
                            smsLogId: smsLog._id,
                            instanceId: smsLog.decisionInstanceId
                        });
                        continue;
                    }

                    // Mark as no response
                    smsLog.decisionStatus = 'no';
                    smsLog.decisionProcessedAt = new Date();
                    await smsLog.save();

                    // Sync to Eloqua
                    await DecisionController.syncSingleDecisionResult(
                        instance,
                        smsLog,
                        'no'
                    );

                    processedCount++;
                    this.stats.totalProcessed++;
                    this.stats.totalNo++;
                    this.stats.totalExpired++;

                    logger.debug('Expired decision processed', {
                        smsLogId: smsLog._id,
                        contactId: smsLog.contactId,
                        deadline: smsLog.decisionDeadline
                    });

                } catch (error) {
                    errorCount++;
                    this.stats.totalErrors++;
                    logger.error('Error processing expired decision', {
                        smsLogId: smsLog._id,
                        error: error.message
                    });
                }
            }

            logger.info('Expired decisions processing completed', {
                total: expiredLogs.length,
                processed: processedCount,
                errors: errorCount,
                totalProcessedLifetime: this.stats.totalProcessed,
                totalExpiredLifetime: this.stats.totalExpired
            });

            this.stats.currentBatchSize = 0;

        } catch (error) {
            logger.error('Error in decision cleanup worker', {
                error: error.message,
                stack: error.stack
            });
            this.stats.currentBatchSize = 0;
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