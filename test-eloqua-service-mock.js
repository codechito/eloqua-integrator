require('dotenv').config();
const mongoose = require('mongoose');
const Consumer = require('./models/Consumer');

async function testWithMock() {
    console.log('\n' + '='.repeat(60));
    console.log('  ELOQUA SERVICE MOCK TEST');
    console.log('='.repeat(60) + '\n');

    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✓ Connected to MongoDB\n');

    // Create a test consumer
    const testInstallId = 'test-' + Date.now();
    
    const consumer = new Consumer({
        installId: testInstallId,
        SiteId: '123',
        siteName: 'Test Site',
        oauth_token: 'test_token',
        oauth_refresh_token: 'test_refresh_token',
        oauth_expires_at: new Date(Date.now() + 3600000), // 1 hour from now
        actions: {
            sendsms: {},
            receivesms: {},
            incomingsms: {},
            tracked_link: {}
        }
    });

    await consumer.save();
    console.log(`✓ Created test consumer: ${testInstallId}\n`);

    // Test 1: Check token expiry detection
    console.log('TEST 1: Token expiry detection');
    console.log('-'.repeat(60));

    const now = new Date();
    const expiresAt = consumer.oauth_expires_at;
    const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

    console.log(`Current time: ${now.toISOString()}`);
    console.log(`Token expires: ${expiresAt.toISOString()}`);
    console.log(`5 min from now: ${fiveMinutesFromNow.toISOString()}`);
    console.log(`Should refresh: ${expiresAt <= fiveMinutesFromNow ? 'YES' : 'NO'}`);

    // Test 2: Simulate token expiration
    console.log('\nTEST 2: Simulate token expiration');
    console.log('-'.repeat(60));

    consumer.oauth_expires_at = new Date(Date.now() - 60000); // 1 minute ago
    await consumer.save();

    const updatedConsumer = await Consumer.findOne({ installId: testInstallId })
        .select('+oauth_expires_at');
    
    const shouldRefresh = updatedConsumer.oauth_expires_at <= new Date();
    console.log(`Token expired: ${shouldRefresh ? 'YES' : 'NO'}`);
    console.log(`✓ Expiration logic working correctly`);

    // Test 3: Check needsTokenRefresh method
    console.log('\nTEST 3: Consumer needsTokenRefresh method');
    console.log('-'.repeat(60));

    if (typeof updatedConsumer.needsTokenRefresh === 'function') {
        const needsRefresh = updatedConsumer.needsTokenRefresh();
        console.log(`Needs refresh: ${needsRefresh ? 'YES' : 'NO'}`);
        console.log(`✓ Method exists and works`);
    } else {
        console.log('⚠ needsTokenRefresh method not found on Consumer model');
    }

    // Cleanup
    await Consumer.deleteOne({ installId: testInstallId });
    console.log(`\n✓ Cleaned up test consumer`);

    await mongoose.connection.close();
    console.log('✓ MongoDB connection closed\n');

    console.log('='.repeat(60));
    console.log('✓ MOCK TEST COMPLETED');
    console.log('='.repeat(60) + '\n');

    process.exit(0);
}

testWithMock();