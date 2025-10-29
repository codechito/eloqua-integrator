const mongoose = require('mongoose');
const SmsJob = require('../models/SmsJob');
const { ActionController } = require('../controllers');
const { logger } = require('../utils');

class SmsWorker {
    constructor(options = {}) {
        this.isRunning = false;
        this.batchSize = options.batchSize || 10; // Process 10 jobs at a time
        this.pollInterval = options.pollInterval || 5000; // Poll every 5 seconds
        this.concurrency = options.concurrency || 5; // Process 5 jobs concurrently
        this.timer = null;
    }

    /**
     * Start the worker
     */
    async start() {
        if (this.isRunning) {
            logger.warn('SMS Worker already running');
            return;
        }

        logger.info('Starting SMS Worker', {
            batchSize: this.batchSize,
            pollInterval: this.pollInterval,
            concurrency: this.concurrency
        });

        this.isRunning = true;
        this.poll();
    }

    /**
     * Stop the worker
     */
    stop() {
        logger.info('Stopping SMS Worker');
        this.isRunning = false;
        
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /**
     * Poll for pending jobs
     */
    async poll() {
        if (!this.isRunning) {
            return;
        }

        try {
            await this.processPendingJobs();
        } catch (error) {
            logger.error('Error in SMS worker poll', {
                error: error.message,
                stack: error.stack
            });
        }

        // Schedule next poll
        if (this.isRunning) {
            this.timer = setTimeout(() => this.poll(), this.pollInterval);
        }
    }

    /**
     * Process pending jobs
     */
    async processPendingJobs() {
        // Find pending jobs
        const pendingJobs = await SmsJob.find({
            status: 'pending',
            scheduledAt: { $lte: new Date() }
        })
        .sort({ scheduledAt: 1 })
        .limit(this.batchSize);

        if (pendingJobs.length === 0) {
            logger.debug('No pending SMS jobs found');
            return;
        }

        logger.info('Found pending SMS jobs', { count: pendingJobs.length });

        // Process jobs with concurrency control
        const chunks = this.chunkArray(pendingJobs, this.concurrency);

        for (const chunk of chunks) {
            await Promise.allSettled(
                chunk.map(job => this.processJob(job))
            );
        }
    }

    /**
     * Process a single job
     */
    async processJob(job) {
        try {
            logger.info('Processing SMS job', {
                jobId: job.jobId,
                contactId: job.contactId,
                attempt: job.retryCount + 1
            });

            const result = await ActionController.processSmsJob(job);

            if (result.success) {
                logger.info('SMS job completed successfully', {
                    jobId: job.jobId,
                    messageId: result.messageId
                });
            } else {
                logger.error('SMS job failed', {
                    jobId: job.jobId,
                    error: result.error
                });
            }

            return result;

        } catch (error) {
            logger.error('Error processing SMS job', {
                jobId: job.jobId,
                error: error.message,
                stack: error.stack
            });

            throw error;
        }
    }

    /**
     * Process failed jobs for retry
     */
    async processFailedJobs() {
        const retryableJobs = await SmsJob.find({
            status: 'failed',
            retryCount: { $lt: 3 }, // maxRetries
            lastRetryAt: {
                $lt: new Date(Date.now() - 5 * 60 * 1000) // Last retry was 5+ minutes ago
            }
        }).limit(10);

        if (retryableJobs.length === 0) {
            return;
        }

        logger.info('Retrying failed SMS jobs', { count: retryableJobs.length });

        for (const job of retryableJobs) {
            try {
                await job.resetForRetry();
                logger.info('SMS job reset for retry', {
                    jobId: job.jobId,
                    retryCount: job.retryCount
                });
            } catch (error) {
                logger.error('Error resetting job for retry', {
                    jobId: job.jobId,
                    error: error.message
                });
            }
        }
    }

    /**
     * Get worker statistics
     */
    async getStats() {
        const stats = await SmsJob.aggregate([
            {
                $group: {
                    _id: '$status',
                    count: { $sum: 1 }
                }
            }
        ]);

        const statsMap = {
            pending: 0,
            processing: 0,
            sent: 0,
            failed: 0,
            cancelled: 0
        };

        stats.forEach(stat => {
            statsMap[stat._id] = stat.count;
        });

        // Get oldest pending job
        const oldestPending = await SmsJob.findOne({
            status: 'pending'
        }).sort({ scheduledAt: 1 });

        return {
            ...statsMap,
            total: Object.values(statsMap).reduce((a, b) => a + b, 0),
            oldestPendingAge: oldestPending 
                ? Date.now() - oldestPending.scheduledAt.getTime() 
                : 0,
            isRunning: this.isRunning
        };
    }

    /**
     * Clean up old completed jobs
     */
    async cleanupOldJobs(daysOld = 30) {
        const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);

        const result = await SmsJob.deleteMany({
            status: { $in: ['sent', 'cancelled'] },
            updatedAt: { $lt: cutoffDate }
        });

        logger.info('Cleaned up old SMS jobs', {
            deletedCount: result.deletedCount,
            olderThan: daysOld + ' days'
        });

        return result.deletedCount;
    }

    /**
     * Utility: Split array into chunks
     */
    chunkArray(array, size) {
        const chunks = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }
}

module.exports = SmsWorker;