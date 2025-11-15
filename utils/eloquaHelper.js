// utils/eloquaHelper.js - COMPLETE FIXED VERSION

const { Consumer } = require('../models');
const { logger } = require('./logger');

/**
 * Get consumer by SiteId and update installId if it changed
 * This handles Eloqua's changing installId behavior
 */
async function getConsumerBySiteId(installId, siteId) {
    try {
        logger.debug('Looking up consumer', {
            installId,
            siteId
        });

        // Try to find by SiteId (stable identifier)
        let consumer = await Consumer.findOne({ 
            SiteId: siteId,
            isActive: true 
        });

        if (consumer) {
            // Check if installId changed
            if (consumer.installId !== installId) {
                logger.warn('Eloqua changed installId - updating', {
                    siteId,
                    oldInstallId: consumer.installId,
                    newInstallId: installId
                });

                // Update installId
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

        // If not found by SiteId, try by installId (new installation)
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

        // Not found
        logger.warn('Consumer not found', {
            installId,
            siteId
        });

        return null;

    } catch (error) {
        logger.error('Error getting consumer', {
            installId,
            siteId,
            error: error.message,
            stack: error.stack
        });
        throw error;
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

        // First try to get existing consumer
        let consumer = await getConsumerBySiteId(installId, siteId);

        if (consumer) {
            logger.info('Existing consumer found', {
                installId: consumer.installId,
                siteId: consumer.SiteId,
                oldInstallId: consumer.installId !== installId ? consumer.installId : null
            });

            // Update siteName if provided
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

        // No existing consumer found - create new one
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
            id: consumer._id
        });

        return consumer;

    } catch (error) {
        logger.error('Error in getOrCreateConsumer', {
            installId,
            siteId,
            siteName,
            error: error.message,
            stack: error.stack
        });
        
        // ✅ FIX: Throw the error properly (don't access error.error)
        throw error;
    }
}


module.exports = {
    getConsumerBySiteId,
    getOrCreateConsumer
};