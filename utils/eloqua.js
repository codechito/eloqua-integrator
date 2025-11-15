// utils/eloqua.js - COMPLETE SAFE VERSION

const { Consumer } = require('../models');
const logger  = require('./logger');

/**
 * Get consumer by SiteId and update installId if it changed
 */
// utils/eloqua.js - Add extensive debug logging

async function getConsumerBySiteId(installId, siteId, includeToken = false) {
    try {
        logger.debug('Looking up consumer', {
            installId,
            siteId,
            siteIdType: typeof siteId,
            includeToken
        });

        // ✅ Build query
        let query = Consumer.findOne({ 
            SiteId: siteId,
            isActive: true 
        });

        if (includeToken) {
            query = query.select('+oauth_token +oauth_refresh_token +oauth_expires_at +transmitsms_api_key +transmitsms_api_secret');
        }

        // ✅ Log the actual query being executed
        logger.debug('Executing database query', {
            collection: 'consumers',
            filter: { SiteId: siteId, isActive: true },
            siteId,
            siteIdType: typeof siteId
        });

        let consumer = await query;

        // ✅ Log the result
        logger.debug('Query result', {
            found: !!consumer,
            consumerId: consumer?._id,
            consumerSiteId: consumer?.SiteId,
            consumerInstallId: consumer?.installId,
            consumerIsActive: consumer?.isActive
        });

        if (consumer) {
            // Check if installId changed
            if (consumer.installId !== installId) {
                logger.warn('Eloqua changed installId - updating', {
                    siteId,
                    oldInstallId: consumer.installId,
                    newInstallId: installId
                });

                try {
                    await Consumer.updateOne(
                        { _id: consumer._id },
                        { $set: { installId: installId } }
                    );
                    
                    consumer = await Consumer.findById(consumer._id);
                    
                    if (includeToken) {
                        consumer = await Consumer.findById(consumer._id)
                            .select('+oauth_token +oauth_refresh_token +oauth_expires_at +transmitsms_api_key +transmitsms_api_secret');
                    }

                    logger.info('Consumer installId updated successfully', {
                        siteId,
                        newInstallId: installId
                    });
                } catch (updateError) {
                    logger.warn('Could not update installId', {
                        siteId,
                        error: updateError.message
                    });
                }
            } else {
                logger.debug('Consumer found with matching installId', {
                    siteId,
                    installId
                });
            }

            return consumer;
        }

        // ✅ If not found by SiteId, check what's actually in the database
        logger.warn('Consumer not found by SiteId, checking database', {
            siteId,
            siteIdType: typeof siteId
        });

        // ✅ Try to find ANY consumer to see what's in DB
        const anyConsumer = await Consumer.findOne({}).limit(1);
        logger.debug('Sample consumer from database', {
            exists: !!anyConsumer,
            sampleSiteId: anyConsumer?.SiteId,
            sampleSiteIdType: typeof anyConsumer?.SiteId,
            sampleIsActive: anyConsumer?.isActive
        });

        // ✅ Count total consumers
        const totalConsumers = await Consumer.countDocuments({});
        const activeConsumers = await Consumer.countDocuments({ isActive: true });
        const matchingSiteId = await Consumer.countDocuments({ SiteId: siteId });
        const matchingBoth = await Consumer.countDocuments({ SiteId: siteId, isActive: true });

        logger.warn('Database statistics', {
            totalConsumers,
            activeConsumers,
            matchingSiteId,
            matchingBoth,
            searchedSiteId: siteId,
            searchedSiteIdType: typeof siteId
        });

        // Try by installId
        consumer = await Consumer.findOne({ 
            installId,
            isActive: true 
        });

        if (consumer) {
            logger.debug('Consumer found by installId', {
                installId,
                siteId,
                foundSiteId: consumer.SiteId
            });
            return consumer;
        }

        logger.warn('Consumer not found', {
            installId,
            siteId
        });

        return null;

    } catch (error) {
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
// utils/eloqua.js - FIXED getOrCreateConsumer

async function getOrCreateConsumer(installId, siteId, siteName = null) {
    try {
        logger.info('Getting or creating consumer', {
            installId,
            siteId,
            siteName
        });

        // ✅ First: Try to find ACTIVE consumer
        let consumer = await getConsumerBySiteId(installId, siteId);

        if (consumer) {
            logger.info('Existing active consumer found', {
                installId: consumer.installId,
                siteId: consumer.SiteId,
                wasUpdated: consumer.installId !== installId
            });

            if (siteName && consumer.siteName !== siteName) {
                consumer.siteName = siteName;
                await consumer.save();
            }

            return consumer;
        }

        // ✅ Second: Check for INACTIVE consumer (from previous uninstall)
        consumer = await Consumer.findOne({
            SiteId: siteId,
            isActive: false
        });

        if (consumer) {
            logger.info('Found inactive consumer - reactivating', {
                oldInstallId: consumer.installId,
                newInstallId: installId,
                siteId
            });

            // Reactivate and update
            consumer.isActive = true;
            consumer.installId = installId;
            if (siteName) consumer.siteName = siteName;
            
            // Clear old pending callbacks
            consumer.pending_oauth_callback = null;
            consumer.pending_oauth_expires = null;
            
            await consumer.save();

            logger.info('Consumer reactivated', {
                installId: consumer.installId,
                siteId: consumer.SiteId,
                hadToken: !!consumer.oauth_token
            });

            return consumer;
        }

        // ✅ Third: No consumer exists at all - create new one
        logger.info('Creating brand new consumer', {
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
        
        throw error instanceof Error ? error : new Error(errorMessage);
    }
}

module.exports = {
    getConsumerBySiteId,
    getOrCreateConsumer
};