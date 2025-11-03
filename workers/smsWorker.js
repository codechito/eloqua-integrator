const { logger } = require('../utils');
const SmsJob = require('../models/SmsJob');
const ActionController = require('../controllers/actionController');

class SmsWorker {
    constructor() {
        this.isRunning = false;
        this.pollInterval = 5000; // 5 seconds
        this.batchSize = 10; // Process 10 at a time
        this.rateLimitDelay = 100; // 100ms between sends
        this.executionBatches = new Map(); // Track executions
    }

    /**
     * Start the worker
     */
    start() {
        if (this.isRunning) {
            logger.warn('SMS Worker already running');
            return;
        }

        this.isRunning = true;
        logger.info('SMS Worker started', {
            pollInterval: this.pollInterval,
            batchSize: this.batchSize
        });

        this.poll();
    }

    /**
     * Stop the worker
     */
    stop() {
        this.isRunning = false;
        logger.info('SMS Worker stopped');
    }

    /**
     * Poll for pending jobs
     */
    async poll() {
        while (this.isRunning) {
            try {
                await this.processPendingJobs();
            } catch (error) {
                logger.error('Error in worker poll cycle', {
                    error: error.message
                });
            }

            // Wait before next poll
            await this.sleep(this.pollInterval);
        }
    }

    /**
     * Process pending SMS jobs
     */
    async processPendingJobs() {
        try {
            const jobs = await SmsJob.find({
                status: 'pending',
                scheduledAt: { $lte: new Date() }
            })
            .sort({ scheduledAt: 1 })
            .limit(this.batchSize);

            if (jobs.length === 0) {
                logger.debug('No pending SMS jobs found');
                return;
            }

            logger.info('Found pending SMS jobs', { count: jobs.length });

            // Group jobs by execution
            const executionGroups = this.groupJobsByExecution(jobs);

            // Process each group
            for (const [executionKey, executionJobs] of executionGroups.entries()) {
                await this.processExecutionBatch(executionKey, executionJobs);
            }

        } catch (error) {
            logger.error('Error processing pending jobs', {
                error: error.message
            });
        }
    }

    /**
     * Group jobs by execution ID for tracking
     */
    groupJobsByExecution(jobs) {
        const groups = new Map();

        jobs.forEach(job => {
            const key = `${job.installId}_${job.instanceId}_${job.executionId || 'default'}`;
            
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            
            groups.get(key).push(job);
        });

        return groups;
    }

    /**
     * Process a batch of jobs from same execution
     */
    async processExecutionBatch(executionKey, jobs) {
        logger.info('Processing execution batch', {
            executionKey,
            jobCount: jobs.length
        });

        const results = {
            complete: [],
            errored: []
        };

        // Process jobs with rate limiting
        for (const job of jobs) {
            try {
                const result = await this.processJob(job);
                
                if (result.success) {
                    results.complete.push({
                        contactId: job.contactId,
                        emailAddress: job.emailAddress,
                        phone: job.mobileNumber,
                        message: job.message,
                        message_id: result.messageId,
                        caller_id: job.senderId,
                        assetId: job.campaignId,
                        Id: job.customObjectData?.recordId
                    });
                } else {
                    results.errored.push({
                        contactId: job.contactId,
                        emailAddress: job.emailAddress,
                        phone: job.mobileNumber,
                        message: job.message,
                        error: result.error
                    });
                }

                // Rate limiting delay
                await this.sleep(this.rateLimitDelay);

            } catch (error) {
                logger.error('Error processing job', {
                    jobId: job.jobId,
                    error: error.message
                });

                results.errored.push({
                    contactId: job.contactId,
                    emailAddress: job.emailAddress,
                    phone: job.mobileNumber,
                    error: error.message
                });
            }
        }

        // Track this execution
        this.trackExecution(executionKey, jobs[0], results);

        // Check if execution is complete and sync to Eloqua
        await this.checkAndCompleteExecution(executionKey, jobs[0]);
    }

    /**
     * Track execution progress
     */
    trackExecution(executionKey, sampleJob, results) {
        if (!this.executionBatches.has(executionKey)) {
            this.executionBatches.set(executionKey, {
                installId: sampleJob.installId,
                instanceId: sampleJob.instanceId,
                executionId: sampleJob.executionId,
                complete: [],
                errored: [],
                totalProcessed: 0
            });
        }

        const execution = this.executionBatches.get(executionKey);
        execution.complete.push(...results.complete);
        execution.errored.push(...results.errored);
        execution.totalProcessed += results.complete.length + results.errored.length;

        this.executionBatches.set(executionKey, execution);

        logger.debug('Execution tracked', {
            executionKey,
            totalProcessed: execution.totalProcessed,
            completeCount: execution.complete.length,
            erroredCount: execution.errored.length
        });
    }

    /**
     * Check if execution is complete and sync to Eloqua
     */
    async checkAndCompleteExecution(executionKey, sampleJob) {
        try {
            // Check if there are any more pending jobs for this execution
            const pendingCount = await SmsJob.countDocuments({
                installId: sampleJob.installId,
                instanceId: sampleJob.instanceId,
                executionId: sampleJob.executionId,
                status: 'pending'
            });

            if (pendingCount === 0) {
                // All jobs processed, sync to Eloqua
                const execution = this.executionBatches.get(executionKey);

                if (execution) {
                    logger.info('Execution complete, syncing to Eloqua', {
                        executionKey,
                        totalProcessed: execution.totalProcessed
                    });

                    await ActionController.completeActionExecution(
                        execution.installId,
                        execution.instanceId,
                        execution.executionId,
                        {
                            complete: execution.complete,
                            errored: execution.errored
                        }
                    );

                    // Clean up tracking
                    this.executionBatches.delete(executionKey);

                    logger.info('Execution synced and completed', {
                        executionKey
                    });
                }
            }

        } catch (error) {
            logger.error('Error checking execution completion', {
                executionKey,
                error: error.message
            });
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
            }

            return result;

        } catch (error) {
            logger.error('Error in processJob', {
                jobId: job.jobId,
                error: error.message
            });
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Sleep utility
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = SmsWorker;