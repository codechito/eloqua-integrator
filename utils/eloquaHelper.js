// utils/eloquaHelper.js - NEW FILE

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
            error: error.message
        });
        throw error;
    }
}

/**
 * Get or create consumer by SiteId
 */
async function getOrCreateConsumer(installId, siteId, siteName = null) {
    try {
        let consumer = await getConsumerBySiteId(installId, siteId);

        if (!consumer) {
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

            logger.info('Consumer created', {
                installId,
                siteId
            });
        }

        return consumer;

    } catch (error) {
        logger.error('Error getting or creating consumer', {
            installId,
            siteId,
            error: error.message
        });
        throw error;
    }
}

module.exports = {
    getConsumerBySiteId,
    getOrCreateConsumer
};