require('dotenv').config();
const mongoose = require('mongoose');
const SmsWorker = require('./smsWorker');
const { logger } = require('../utils');

// Create worker instance
const smsWorker = new SmsWorker({
    batchSize: parseInt(process.env.SMS_WORKER_BATCH_SIZE) || 10,
    pollInterval: parseInt(process.env.SMS_WORKER_POLL_INTERVAL) || 5000,
    concurrency: parseInt(process.env.SMS_WORKER_CONCURRENCY) || 5
});

// Connect to MongoDB
async function connectDB() {
    try {
        await mongoose.connect(process.env.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true
        });
        logger.info('MongoDB connected for SMS Worker');
    } catch (error) {
        logger.error('MongoDB connection error', { error: error.message });
        process.exit(1);
    }
}

// Start worker
async function startWorker() {
    try {
        await connectDB();
        await smsWorker.start();

        logger.info('SMS Worker started successfully');

        // Log stats periodically
        setInterval(async () => {
            try {
                const stats = await smsWorker.getStats();
                logger.info('SMS Worker Stats', stats);
            } catch (error) {
                logger.error('Error getting worker stats', { error: error.message });
            }
        }, 60000); // Every minute

        // Cleanup old jobs daily
        setInterval(async () => {
            try {
                await smsWorker.cleanupOldJobs(30);
            } catch (error) {
                logger.error('Error cleaning up old jobs', { error: error.message });
            }
        }, 24 * 60 * 60 * 1000); // Every 24 hours

        // Process failed jobs every 10 minutes
        setInterval(async () => {
            try {
                await smsWorker.processFailedJobs();
            } catch (error) {
                logger.error('Error processing failed jobs', { error: error.message });
            }
        }, 10 * 60 * 1000); // Every 10 minutes

    } catch (error) {
        logger.error('Failed to start SMS Worker', { error: error.message });
        process.exit(1);
    }
}

// Graceful shutdown
function gracefulShutdown() {
    logger.info('Received shutdown signal');
    
    smsWorker.stop();
    
    setTimeout(() => {
        mongoose.connection.close(() => {
            logger.info('MongoDB connection closed');
            process.exit(0);
        });
    }, 5000); // Wait 5 seconds for current jobs to finish
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Start the worker
startWorker();