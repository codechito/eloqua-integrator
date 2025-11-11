// workers/decisionCleanupWorker.js - NEW FILE

const { DecisionInstance, SmsLog } = require('../models');
const { logger } = require('../utils');
const DecisionController = require('../controllers/decisionController');

class DecisionCleanupWorker {
    constructor() {
        this.isRunning = false;
        this.interval = null;
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

        logger.info('Starting decision cleanup worker');
        
        this.isRunning = true;
        
        // Run immediately
        this.processExpiredDecisions();
        
        // Then run every 10 minutes
        this.interval = setInterval(() => {
            this.processExpiredDecisions();
        }, 10 * 60 * 1000); // 10 minutes
    }

    /**
     * Stop the cleanup worker
     */
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        this.isRunning = false;
        logger.info('Decision cleanup worker stopped');
    }

    /**
     * Process expired decisions
     * Find SMS logs with pending decisions past their deadline
     */
    async processExpiredDecisions() {
        try {
            logger.info('Processing expired decisions');

            // Find all SMS logs with expired pending decisions
            const expiredLogs = await SmsLog.find({
                decisionInstanceId: { $ne: null },
                decisionStatus: 'pending',
                decisionDeadline: { $lt: new Date() }
            }).limit(100);

            if (expiredLogs.length === 0) {
                logger.debug('No expired decisions found');
                return;
            }

            logger.info('Found expired decisions to process', {
                count: expiredLogs.length
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

                    logger.debug('Expired decision processed', {
                        smsLogId: smsLog._id,
                        contactId: smsLog.contactId,
                        deadline: smsLog.decisionDeadline
                    });

                } catch (error) {
                    errorCount++;
                    logger.error('Error processing expired decision', {
                        smsLogId: smsLog._id,
                        error: error.message
                    });
                }
            }

            logger.info('Expired decisions processing completed', {
                total: expiredLogs.length,
                processed: processedCount,
                errors: errorCount
            });

        } catch (error) {
            logger.error('Error in decision cleanup worker', {
                error: error.message,
                stack: error.stack
            });
        }
    }

    /**
     * Get worker stats
     */
    getStats() {
        return {
            isRunning: this.isRunning,
            hasInterval: !!this.interval
        };
    }
}

module.exports = DecisionCleanupWorker;