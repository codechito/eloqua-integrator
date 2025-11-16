const { logger } = require('../utils');
const SmsJob = require('../models/SmsJob');
const ActionController = require('../controllers/actionController');
const Consumer = require('../models/Consumer');

class SmsWorker {
    constructor() {
        this.isRunning = false;
        this.pollInterval = 5000; // 5 seconds
        this.batchSize = 10; // Process 10 at a time
        this.executionBatches = new Map(); // Track executions
        
        // ✅ NEW: TPS rate limiting per consumer
        this.consumerRateLimits = new Map(); // Track last send time per consumer
        
        // Stats tracking
        this.stats = {
            startedAt: new Date(),
            totalProcessed: 0,
            totalSuccess: 0,
            totalFailed: 0,
            lastPollAt: null,
            currentBatchSize: 0,
            rateLimitDelays: 0  // ✅ NEW: Track rate limit delays
        };
    }

    /**
     * Get worker statistics
     */
    getStats() {
        const uptime = Date.now() - this.stats.startedAt.getTime();
        
        return {
            status: this.isRunning ? 'running' : 'stopped',
            startedAt: this.stats.startedAt,
            uptime: uptime,
            uptimeHuman: this.formatUptime(uptime),
            totalProcessed: this.stats.totalProcessed,
            totalSuccess: this.stats.totalSuccess,
            totalFailed: this.stats.totalFailed,
            successRate: this.stats.totalProcessed > 0 
                ? ((this.stats.totalSuccess / this.stats.totalProcessed) * 100).toFixed(2) + '%'
                : '0%',
            lastPollAt: this.stats.lastPollAt,
            currentBatchSize: this.stats.currentBatchSize,
            activeExecutions: this.executionBatches.size,
            rateLimitDelays: this.stats.rateLimitDelays,  // ✅ NEW
            pollInterval: this.pollInterval,
            batchSize: this.batchSize
        };
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
     * Start the worker
     */
    start() {
        if (this.isRunning) {
            logger.warn('SMS Worker already running');
            return;
        }

        this.isRunning = true;
        this.stats.startedAt = new Date();
        
        logger.info('SMS Worker started with TPS rate limiting', {
            pollInterval: this.pollInterval,
            batchSize: this.batchSize,
            defaultTPS: 10
        });

        this.poll();
    }

    /**
     * Stop the worker
     */
    stop() {
        this.isRunning = false;
        logger.info('SMS Worker stopped', {
            stats: this.getStats()
        });
    }

    /**
     * Poll for pending jobs
     */
    async poll() {
        while (this.isRunning) {
            try {
                this.stats.lastPollAt = new Date();
                await this.processPendingJobs();
            } catch (error) {
                logger.error('Error in worker poll cycle', {
                    error: error.message,
                    stack: error.stack
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
                this.stats.currentBatchSize = 0;
                return;
            }

            this.stats.currentBatchSize = jobs.length;
            logger.info('Found pending SMS jobs', { count: jobs.length });

            // Group jobs by execution
            const executionGroups = this.groupJobsByExecution(jobs);

            // Process each group
            for (const [executionKey, executionJobs] of executionGroups.entries()) {
                await this.processExecutionBatch(executionKey, executionJobs);
            }

        } catch (error) {
            logger.error('Error processing pending jobs', {
                error: error.message,
                stack: error.stack
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
     * ENHANCED: TPS rate limiting per consumer
     */
    async processExecutionBatch(executionKey, jobs) {
        logger.info('Processing execution batch with TPS rate limiting', {
            executionKey,
            jobCount: jobs.length
        });

        const results = {
            complete: [],
            errored: []
        };

        // ✅ Get consumer for TPS limit
        const firstJob = jobs[0];
        let tpsLimit = 10; // Default
        
        try {
            const consumer = await Consumer.findOne({ installId: firstJob.installId })
                .select('tps_limit');
            
            tpsLimit = consumer?.tps_limit || 10;
            
            logger.debug('TPS configuration loaded', {
                installId: firstJob.installId,
                tpsLimit,
                delayBetweenSends: `${(1000 / tpsLimit).toFixed(2)}ms`
            });
        } catch (error) {
            logger.warn('Could not load TPS config, using default', {
                installId: firstJob.installId,
                error: error.message
            });
        }

        // ✅ Process jobs with TPS rate limiting
        for (const job of jobs) {
            try {
                // ✅ Apply TPS rate limiting BEFORE processing
                await this.applyTpsRateLimit(job.installId, tpsLimit);

                const result = await this.processJob(job);
                
                // Update stats
                this.stats.totalProcessed++;
                
                if (result.success) {
                    this.stats.totalSuccess++;
                    results.complete.push({
                        contactId: job.contactId,
                        emailAddress: job.emailAddress,
                        phone: job.mobileNumber,
                        message: job.message,
                        message_id: result.messageId,
                        caller_id: job.senderId,
                        assetId: job.campaignId,
                        Id: job.customObjectData?.recordId,
                        sync_status: 'sent',
                        delivery: 'sent'
                    });
                } else {
                    this.stats.totalFailed++;
                    results.errored.push({
                        contactId: job.contactId,
                        emailAddress: job.emailAddress,
                        phone: job.mobileNumber,
                        message: job.message,
                        error: result.error,
                        errorCode: result.errorCode || 'SEND_FAILED',
                        sync_status: 'errored',
                        delivery: 'errored'
                    });
                    
                    logger.debug('Added failed job to errored results', {
                        jobId: job.jobId,
                        contactId: job.contactId,
                        error: result.error,
                        errorCode: result.errorCode
                    });
                }

            } catch (error) {
                logger.error('Error processing job', {
                    jobId: job.jobId,
                    error: error.message,
                    stack: error.stack
                });

                this.stats.totalProcessed++;
                this.stats.totalFailed++;

                results.errored.push({
                    contactId: job.contactId,
                    emailAddress: job.emailAddress,
                    phone: job.mobileNumber,
                    error: error.message,
                    errorCode: 'PROCESSING_ERROR',
                    sync_status: 'errored',
                    delivery: 'errored'
                });
            }
        }

        // Track this execution
        this.trackExecution(executionKey, jobs[0], results);

        // Check if execution is complete and sync to Eloqua
        await this.checkAndCompleteExecution(executionKey, jobs[0]);
    }

    /**
     * ✅ NEW: Apply TPS rate limiting per consumer
     * Ensures we don't exceed the configured SMS per second limit
     */
    async applyTpsRateLimit(installId, tpsLimit) {
        const now = Date.now();
        const minDelayMs = 1000 / tpsLimit; // Minimum milliseconds between sends

        // Get last send time for this consumer
        const lastSendTime = this.consumerRateLimits.get(installId) || 0;
        const timeSinceLastSend = now - lastSendTime;

        // If not enough time has passed, wait
        if (timeSinceLastSend < minDelayMs) {
            const waitTime = minDelayMs - timeSinceLastSend;
            
            logger.debug('TPS rate limit - delaying send', {
                installId,
                tpsLimit,
                waitTimeMs: waitTime.toFixed(2),
                timeSinceLastSend: timeSinceLastSend.toFixed(2)
            });

            this.stats.rateLimitDelays++;
            await this.sleep(waitTime);
        }

        // Update last send time for this consumer
        this.consumerRateLimits.set(installId, Date.now());
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
                totalProcessed: 0,
                startedAt: new Date()
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
                        totalProcessed: execution.totalProcessed,
                        completeCount: execution.complete.length,
                        erroredCount: execution.errored.length,
                        duration: Date.now() - execution.startedAt.getTime()
                    });

                    try {
                        await ActionController.completeActionExecution(
                            execution.installId,
                            execution.instanceId,
                            execution.executionId,
                            {
                                complete: execution.complete,
                                errored: execution.errored
                            }
                        );

                        logger.info('Execution synced and completed successfully', {
                            executionKey,
                            totalProcessed: execution.totalProcessed
                        });
                    } catch (syncError) {
                        logger.error('Failed to sync execution to Eloqua', {
                            executionKey,
                            error: syncError.message,
                            stack: syncError.stack
                        });
                        return;
                    }

                    // Clean up tracking only if sync was successful
                    this.executionBatches.delete(executionKey);
                }
            } else {
                logger.debug('Execution still has pending jobs', {
                    executionKey,
                    pendingCount
                });
            }

        } catch (error) {
            logger.error('Error checking execution completion', {
                executionKey,
                error: error.message,
                stack: error.stack
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
                
                return {
                    success: true,
                    messageId: result.messageId
                };
            } else {
                logger.warn('SMS job failed', {
                    jobId: job.jobId,
                    error: result.error,
                    errorCode: result.errorCode
                });
                
                return {
                    success: false,
                    error: result.error,
                    errorCode: result.errorCode || 'SEND_FAILED'
                };
            }

        } catch (error) {
            logger.error('Error in processJob', {
                jobId: job.jobId,
                error: error.message,
                stack: error.stack
            });
            
            return {
                success: false,
                error: error.message,
                errorCode: 'PROCESSING_ERROR'
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