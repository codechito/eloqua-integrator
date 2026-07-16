const { logger } = require('../utils');
const SmsJob = require('../models/SmsJob');
const ActionController = require('../controllers/actionController');
const Consumer = require('../models/Consumer');

class SmsWorker {
    constructor() {
        this.isRunning = false;
        this.pollInterval = 5000; // 5 seconds - only used when queue is empty
        this.batchSize = 200; // Process 200 at a time
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
            rateLimitDelays: 0,
            totalRecovered: 0
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
            rateLimitDelays: this.stats.rateLimitDelays,
            totalRecovered: this.stats.totalRecovered,
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
                await this.recoverStaleJobs();
                const processed = await this.processPendingJobs();
                // Only sleep when queue is empty — no dead time during active sends
                if (processed === 0) {
                    await this.sleep(this.pollInterval);
                }
            } catch (error) {
                logger.error('Error in worker poll cycle', {
                    error: error.message,
                    stack: error.stack
                });
                await this.sleep(this.pollInterval);
            }
        }
    }

    /**
     * Reset jobs stuck in 'processing' for over 5 minutes back to 'pending'.
     * Handles crashes or mid-deploy restarts where a job was claimed but never completed.
     */
    async recoverStaleJobs() {
        const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
        const result = await SmsJob.updateMany(
            { status: 'processing', processingStartedAt: { $lt: staleThreshold } },
            { $set: { status: 'pending' } }
        );
        if (result.modifiedCount > 0) {
            logger.warn('Recovered stale SMS jobs', { count: result.modifiedCount });
            this.stats.totalRecovered += result.modifiedCount;
        }
    }

    /**
     * Process pending SMS jobs
     * Uses bulk claiming (3 DB calls) instead of N sequential findOneAndUpdate calls.
     * Returns the number of jobs processed so poll() knows whether to sleep.
     */
    async processPendingJobs() {
        try {
            // Step 1: Find candidate IDs (fast indexed read, no lock)
            const candidates = await SmsJob.find(
                { status: 'pending', scheduledAt: { $lte: new Date() } },
                '_id',
                { sort: { scheduledAt: 1 }, limit: this.batchSize }
            ).lean();

            if (candidates.length === 0) {
                logger.debug('No pending SMS jobs found');
                this.stats.currentBatchSize = 0;
                return 0;
            }

            const ids = candidates.map(c => c._id);

            // Step 2: Bulk claim — use a unique timestamp as a claim token so each
            // server instance only processes jobs it actually claimed
            const claimToken = new Date();
            await SmsJob.updateMany(
                { _id: { $in: ids }, status: 'pending' },
                { $set: { status: 'processing', processingStartedAt: claimToken } }
            );

            // Step 3: Fetch only the jobs this instance successfully claimed
            const jobs = await SmsJob.find({
                _id: { $in: ids },
                processingStartedAt: claimToken
            });

            if (jobs.length === 0) {
                this.stats.currentBatchSize = 0;
                return 0;
            }

            this.stats.currentBatchSize = jobs.length;
            logger.info('Claimed pending SMS jobs', { count: jobs.length });

            // Group jobs by execution and process each group
            const executionGroups = this.groupJobsByExecution(jobs);
            for (const [executionKey, executionJobs] of executionGroups.entries()) {
                await this.processExecutionBatch(executionKey, executionJobs);
            }

            return jobs.length;

        } catch (error) {
            logger.error('Error processing pending jobs', {
                error: error.message,
                stack: error.stack
            });
            return 0;
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
     * Process a batch of jobs from same execution.
     * Sends jobs concurrently in chunks of tpsLimit per second, respecting
     * the per-consumer TransmitSMS TPS governor (10–50+ TPS depending on account).
     */
    async processExecutionBatch(executionKey, jobs) {
        // Resolve TPS limit for this consumer
        const firstJob = jobs[0];
        let tpsLimit = 10; // Default / minimum

        try {
            const consumer = await Consumer.findOne({ installId: firstJob.installId })
                .select('tps_limit');
            tpsLimit = consumer?.tps_limit || 10;
        } catch (error) {
            logger.warn('Could not load TPS config, using default 10', {
                installId: firstJob.installId,
                error: error.message
            });
        }

        logger.info('Processing execution batch', {
            executionKey,
            jobCount: jobs.length,
            tpsLimit,
            estimatedSeconds: Math.ceil(jobs.length / tpsLimit)
        });

        const results = { complete: [], errored: [] };

        // Process in parallel chunks of tpsLimit.
        // Each chunk fires all jobs concurrently, then waits for the remainder
        // of 1 second before the next chunk — this saturates the TPS allowance
        // without exceeding it.
        for (let i = 0; i < jobs.length; i += tpsLimit) {
            const chunk = jobs.slice(i, i + tpsLimit);
            const chunkStart = Date.now();

            const chunkResults = await Promise.all(chunk.map(job => this.processJob(job)));

            chunkResults.forEach((result, idx) => {
                const job = chunk[idx];
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
                        ...(job.eloquaRecordId ? { Id: job.eloquaRecordId } : {}),
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
                        ...(job.eloquaRecordId ? { Id: job.eloquaRecordId } : {}),
                        sync_status: 'errored',
                        delivery: 'errored'
                    });
                }
            });

            // Throttle: hold the 1-second window before sending the next chunk
            if (i + tpsLimit < jobs.length) {
                const elapsed = Date.now() - chunkStart;
                if (elapsed < 1000) {
                    await this.sleep(1000 - elapsed);
                }
            }
        }

        // Track and check completion
        this.trackExecution(executionKey, jobs[0], results);
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
            // Check if there are any more pending OR in-flight (processing) jobs for this
            // execution. With multiple instances, 'processing' jobs on another instance
            // must also complete before we sync to Eloqua.
            const pendingCount = await SmsJob.countDocuments({
                installId: sampleJob.installId,
                instanceId: sampleJob.instanceId,
                executionId: sampleJob.executionId,
                status: { $in: ['pending', 'processing'] }
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

                    // Fire Eloqua sync in the background — don't block the worker
                    // so SMS sending continues immediately for the next batch.
                    ActionController.completeActionExecution(
                        execution.installId,
                        execution.instanceId,
                        execution.executionId,
                        {
                            complete: execution.complete,
                            errored: execution.errored
                        }
                    ).then(() => {
                        logger.info('Execution synced and completed successfully', {
                            executionKey,
                            totalProcessed: execution.totalProcessed
                        });
                    }).catch(syncError => {
                        logger.error('Failed to sync execution to Eloqua', {
                            executionKey,
                            error: syncError.message,
                            stack: syncError.stack
                        });
                    });

                    // Clean up tracking immediately — sync runs in background
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