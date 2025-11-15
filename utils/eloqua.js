// utils/eloqua.js - COMPLETE SAFE VERSION

const { Consumer } = require('../models');
const { logger } = require('./logger');

/**
 * Get consumer by SiteId and update installId if it changed
 */
async function getConsumerBySiteId(installId, siteId) {
    try {
        logger.debug('Looking up consumer', {
            installId,
            siteId
        });

        let consumer = await Consumer.findOne({ 
            SiteId: siteId,
            isActive: true 
        });

        if (consumer) {
            if (consumer.installId !== installId) {
                logger.warn('Eloqua changed installId - updating', {
                    siteId,
                    oldInstallId: consumer.installId,
                    newInstallId: installId
                });

                consumer.installId = installId;
                await consumer.save();

                logger.info('Consumer installId updated', {
                    siteId,
                    newInstallId: installId
                });
            } else {
                logger.debug('Consumer found with matching installId', {
                    siteId,
                    installId
                });
            }

            return consumer;
        }

        consumer = await Consumer.findOne({ 
            installId,
            isActive: true 
        });

        if (consumer) {
            logger.debug('Consumer found by installId', {
                installId,
                siteId
            });
            return consumer;
        }

        logger.warn('Consumer not found', {
            installId,
            siteId
        });

        return null;

    } catch (error) {
        // ✅ SAFE ERROR LOGGING
        const errorMessage = error?.message || String(error);
        const errorStack = error?.stack || 'No stack trace';

        logger.error('Error getting consumer', {
            installId,
            siteId,
            error: errorMessage,
            stack: errorStack
        });

        throw error instanceof Error ? error : new Error(errorMessage);
    }
}

/**
 * Get or create consumer by SiteId
 */
async function getOrCreateConsumer(installId, siteId, siteName = null) {
    try {
        logger.info('Getting or creating consumer', {
            installId,
            siteId,
            siteName
        });

        let consumer = await getConsumerBySiteId(installId, siteId);

        if (consumer) {
            logger.info('Existing consumer found', {
                installId: consumer.installId,
                siteId: consumer.SiteId,
                wasUpdated: consumer.installId !== installId
            });

            if (siteName && consumer.siteName !== siteName) {
                consumer.siteName = siteName;
                await consumer.save();
                logger.info('Updated consumer siteName', {
                    installId: consumer.installId,
                    siteName
                });
            }

            return consumer;
        }

        logger.info('Creating new consumer', {
            installId,
            siteId,
            siteName
        });

        consumer = new Consumer({
            installId,
            SiteId: siteId,
            siteName: siteName || 'Unknown Site',
            isActive: true,
            Status: 'active'
        });

        await consumer.save();

        logger.info('Consumer created successfully', {
            installId,
            siteId,
            siteName: consumer.siteName,
            _id: consumer._id
        });

        return consumer;

    } catch (error) {
        // ✅ SAFE ERROR LOGGING - FIX FOR LINE 145
        const errorMessage = error?.message || String(error);
        const errorStack = error?.stack || 'No stack trace';

        logger.error('Error in getOrCreateConsumer', {
            installId,
            siteId,
            siteName,
            error: errorMessage,
            stack: errorStack,
            errorType: typeof error
        });
        
        // ✅ Throw proper Error object
        throw error instanceof Error ? error : new Error(errorMessage);
    }
}

module.exports = {
    getConsumerBySiteId,
    getOrCreateConsumer
};