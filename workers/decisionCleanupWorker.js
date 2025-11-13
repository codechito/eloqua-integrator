// workers/decisionCleanupWorker.js - COMPLETE WITH ELOQUA SYNC

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
            totalSyncedToEloqua: 0,
            totalSyncErrors: 0,
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
            action: 'No reply after interval → NO path + Sync to Eloqua'
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
            totalExpired: this.stats.totalExpired,
            totalSyncedToEloqua: this.stats.totalSyncedToEloqua
        });
    }

    /**
     * Process expired decision evaluations
     * FIXED: Now syncs ALL results to Eloqua (including NO decisions)
     * - Maximum 30 recipients per batch
     * - No reply after interval → NO path + Sync to Eloqua
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

            const minutesOverdue = expiredLogs[0] ? ((now - expiredLogs[0].decisionDeadline) / (60 * 1000)).toFixed(2) : 0;

            logger.info('Found expired decision evaluations', {
                count: expiredLogs.length,
                maxBatchSize: this.config.batchSize,
                now: now.toISOString(),
                oldestDeadline: expiredLogs[0]?.decisionDeadline,
                newestDeadline: expiredLogs[expiredLogs.length - 1]?.decisionDeadline,
                minutesOverdue
            });

            this.stats.currentBatchSize = expiredLogs.length;
            this.stats.totalExpired += expiredLogs.length;

            // Group by instance for Eloqua sync
            const groupedByInstance = {};

            // ============================================
            // STEP 1: EVALUATE ALL EXPIRED DECISIONS
            // ============================================
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
                        
                        const hoursOverdue = ((now - smsLog.decisionDeadline) / (1000 * 60 * 60)).toFixed(2);
                        
                        logger.info('Decision evaluated - NO RESPONSE (timeout)', {
                            contactId: smsLog.contactId,
                            messageId: smsLog.messageId,
                            decision: 'no',
                            deadline: smsLog.decisionDeadline,
                            hoursOverdue
                        });
                    }

                    // Update SMS log with decision
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

                    // ============================================
                    // CRITICAL: Group for Eloqua sync
                    // ============================================
                    const key = smsLog.decisionInstanceId;
                    if (!groupedByInstance[key]) {
                        groupedByInstance[key] = {
                            instance,
                            consumer,
                            executionId: smsLog.executionId, // Store executionId
                            yes: [],
                            no: [],
                            withResponse: 0,
                            noResponse: 0
                        };
                    }
                    
                    // Add to appropriate decision array for Eloqua sync
                    groupedByInstance[key][decision].push({
                        contactId: smsLog.contactId,
                        emailAddress: smsLog.emailAddress,
                        messageId: smsLog.messageId,
                        responseMessage: smsLog.responseMessage
                    });
                    
                    // Track stats
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

            // ============================================
            // STEP 2: SYNC ALL DECISIONS TO ELOQUA
            // ============================================
            if (Object.keys(groupedByInstance).length === 0) {
                logger.warn('No decisions to sync to Eloqua', {
                    processedCount: expiredLogs.length
                });
                return;
            }

            logger.info('Syncing expired decisions to Eloqua', {
                instancesAffected: Object.keys(groupedByInstance).length,
                totalYes: Object.values(groupedByInstance).reduce((sum, g) => sum + g.yes.length, 0),
                totalNo: Object.values(groupedByInstance).reduce((sum, g) => sum + g.no.length, 0)
            });

            for (const [instanceId, data] of Object.entries(groupedByInstance)) {
                try {
                    // Get executionId - try from stored value, or find most recent
                    let executionId = data.executionId;
                    
                    if (!executionId) {
                        // Try to find most recent executionId from any SMS log for this instance
                        const recentLog = await SmsLog.findOne({
                            decisionInstanceId: instanceId,
                            executionId: { $exists: true, $ne: null }
                        }).sort({ createdAt: -1 });

                        if (recentLog && recentLog.executionId) {
                            executionId = recentLog.executionId;
                            logger.info('Found executionId from recent SMS log', {
                                instanceId,
                                executionId
                            });
                        }
                    }

                    if (!executionId) {
                        // No executionId available - cannot sync to Eloqua
                        logger.error('❌ CRITICAL: No executionId available - cannot sync to Eloqua', {
                            instanceId,
                            yesCount: data.yes.length,
                            noCount: data.no.length,
                            note: 'Contacts will remain STUCK in decision step! This happens when campaign completed before timeout.'
                        });
                        this.stats.totalSyncErrors++;
                        continue;
                    }

                    // Initialize Eloqua service
                    const eloquaService = new EloquaService(
                        data.consumer.installId,
                        data.instance.SiteId
                    );
                    await eloquaService.initialize();

                    const instanceIdNoDashes = instanceId.replace(/-/g, '');

                    // Sync YES contacts
                    if (data.yes.length > 0) {
                        try {
                            logger.info('Syncing YES decisions to Eloqua', {
                                instanceId,
                                executionId,
                                count: data.yes.length
                            });

                            await DecisionController.syncDecisionBatch(
                                eloquaService,
                                data.instance,
                                instanceIdNoDashes,
                                executionId,
                                data.yes,
                                'yes'
                            );

                            logger.info('✅ YES decisions synced to Eloqua', {
                                instanceId,
                                executionId,
                                count: data.yes.length
                            });

                            this.stats.totalSyncedToEloqua += data.yes.length;

                        } catch (syncError) {
                            logger.error('❌ Error syncing YES decisions', {
                                instanceId,
                                executionId,
                                count: data.yes.length,
                                error: syncError.message,
                                stack: syncError.stack
                            });
                            this.stats.totalSyncErrors++;
                        }
                    }

                    // Sync NO contacts
                    if (data.no.length > 0) {
                        try {
                            logger.info('Syncing NO decisions to Eloqua', {
                                instanceId,
                                executionId,
                                count: data.no.length
                            });

                            await DecisionController.syncDecisionBatch(
                                eloquaService,
                                data.instance,
                                instanceIdNoDashes,
                                executionId,
                                data.no,
                                'no'
                            );

                            logger.info('✅ NO decisions synced to Eloqua', {
                                instanceId,
                                executionId,
                                count: data.no.length
                            });

                            this.stats.totalSyncedToEloqua += data.no.length;

                        } catch (syncError) {
                            logger.error('❌ Error syncing NO decisions', {
                                instanceId,
                                executionId,
                                count: data.no.length,
                                error: syncError.message,
                                stack: syncError.stack
                            });
                            this.stats.totalSyncErrors++;
                        }
                    }

                    // Log summary for this instance
                    logger.info('✅ Expired decisions processed and synced for instance', {
                        instanceId,
                        executionId,
                        yesCount: data.yes.length,
                        noCount: data.no.length,
                        withResponse: data.withResponse,
                        noResponse: data.noResponse,
                        total: data.yes.length + data.no.length,
                        syncedToEloqua: true
                    });

                } catch (error) {
                    logger.error('❌ Error syncing expired decisions for instance', {
                        instanceId,
                        error: error.message,
                        stack: error.stack
                    });
                    this.stats.totalSyncErrors++;
                }
            }

            logger.info('✅ Expired decision batch completed', {
                totalInBatch: expiredLogs.length,
                processed: this.stats.lastBatchProcessed,
                errors: this.stats.totalErrors,
                yesInBatch: Object.values(groupedByInstance).reduce((sum, g) => sum + g.yes.length, 0),
                noInBatch: Object.values(groupedByInstance).reduce((sum, g) => sum + g.no.length, 0),
                syncedToEloqua: this.stats.totalSyncedToEloqua,
                syncErrors: this.stats.totalSyncErrors
            });

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
                totalSyncedToEloqua: this.stats.totalSyncedToEloqua,
                totalSyncErrors: this.stats.totalSyncErrors,
                
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
            totalSyncedToEloqua: this.stats.totalSyncedToEloqua,
            totalSyncErrors: this.stats.totalSyncErrors,
            
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