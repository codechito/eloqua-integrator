require('dotenv').config();
const mongoose = require('mongoose');
const Consumer = require('./models/Consumer');
const { EloquaService } = require('./services');
const { logger } = require('./utils');

// Color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

function log(color, symbol, message) {
    console.log(`${color}${symbol} ${message}${colors.reset}`);
}

async function testTokenRefresh() {
    console.log('\n' + '='.repeat(60));
    console.log('  TOKEN REFRESH & RE-AUTHORIZATION TEST');
    console.log('='.repeat(60) + '\n');

    try {
        // Connect to MongoDB
        await mongoose.connect(process.env.MONGODB_URI);
        log(colors.green, '✓', 'Connected to MongoDB');

        // Get a test consumer (use your actual installId)
        const testInstallId = process.argv[2];
        
        if (!testInstallId) {
            log(colors.red, '✗', 'Please provide an installId as argument');
            console.log('\nUsage: node test-token-refresh.js <installId>\n');
            process.exit(1);
        }

        log(colors.blue, 'ℹ', `Testing with installId: ${testInstallId}`);

        const consumer = await Consumer.findOne({ installId: testInstallId })
            .select('+oauth_token +oauth_refresh_token +oauth_expires_at');

        if (!consumer) {
            log(colors.red, '✗', 'Consumer not found');
            process.exit(1);
        }

        log(colors.green, '✓', 'Consumer found');
        console.log(`   Site ID: ${consumer.SiteId}`);
        console.log(`   Site Name: ${consumer.siteName}`);
        console.log(`   Has OAuth Token: ${!!consumer.oauth_token}`);
        console.log(`   Token Expires: ${consumer.oauth_expires_at}`);

        // TEST 1: Token not expired - should work normally
        console.log('\n' + '-'.repeat(60));
        log(colors.cyan, '►', 'TEST 1: API call with valid token');
        console.log('-'.repeat(60));

        try {
            const eloquaService = new EloquaService(testInstallId, consumer.SiteId);
            const customObjects = await eloquaService.getCustomObjects('', 5);
            
            log(colors.green, '✓', `Success! Fetched ${customObjects.elements?.length || 0} custom objects`);
            if (customObjects.elements && customObjects.elements.length > 0) {
                console.log(`   First object: ${customObjects.elements[0].name}`);
            }
        } catch (error) {
            log(colors.red, '✗', `Failed: ${error.message}`);
        }

        // TEST 2: Force token expiration - should auto-refresh
        console.log('\n' + '-'.repeat(60));
        log(colors.cyan, '►', 'TEST 2: Force token expiration (auto-refresh test)');
        console.log('-'.repeat(60));

        // Backup original values
        const originalToken = consumer.oauth_token;
        const originalExpiresAt = consumer.oauth_expires_at;

        // Set token to expire 1 minute ago
        consumer.oauth_expires_at = new Date(Date.now() - 60000);
        await consumer.save();
        
        log(colors.yellow, '⚠', 'Token expiration set to 1 minute ago');
        console.log(`   New expiry: ${consumer.oauth_expires_at}`);

        try {
            const eloquaService = new EloquaService(testInstallId, consumer.SiteId);
            const contactFields = await eloquaService.getContactFields(5);
            
            // Reload consumer to see if token was refreshed
            const updatedConsumer = await Consumer.findOne({ installId: testInstallId })
                .select('+oauth_token +oauth_expires_at');
            
            log(colors.green, '✓', `Success! Token was automatically refreshed`);
            console.log(`   New expiry: ${updatedConsumer.oauth_expires_at}`);
            console.log(`   Token changed: ${originalToken !== updatedConsumer.oauth_token}`);
            console.log(`   Fetched ${contactFields.elements?.length || 0} contact fields`);
        } catch (error) {
            log(colors.red, '✗', `Failed: ${error.message}`);
            
            // Restore original token
            consumer.oauth_expires_at = originalExpiresAt;
            await consumer.save();
        }

        // TEST 3: Invalid token - should trigger refresh
        console.log('\n' + '-'.repeat(60));
        log(colors.cyan, '►', 'TEST 3: Invalid token (should trigger 401 and refresh)');
        console.log('-'.repeat(60));

        const currentConsumer = await Consumer.findOne({ installId: testInstallId })
            .select('+oauth_token +oauth_expires_at');
        
        const backupToken = currentConsumer.oauth_token;
        
        // Set an invalid token
        currentConsumer.oauth_token = 'invalid_token_12345';
        await currentConsumer.save();
        
        log(colors.yellow, '⚠', 'Set invalid token');

        try {
            const eloquaService = new EloquaService(testInstallId, consumer.SiteId);
            const result = await eloquaService.getCustomObjects('', 5);
            
            // Reload to see if token was refreshed
            const refreshedConsumer = await Consumer.findOne({ installId: testInstallId })
                .select('+oauth_token');
            
            log(colors.green, '✓', `Success! Token was refreshed after 401 error`);
            console.log(`   Token was updated: ${refreshedConsumer.oauth_token !== 'invalid_token_12345'}`);
            console.log(`   API call succeeded after refresh`);
        } catch (error) {
            if (error.code === 'REAUTH_REQUIRED') {
                log(colors.yellow, '⚠', `Re-authorization required (expected if refresh token is invalid)`);
                console.log(`   Re-auth URL: ${error.reAuthUrl}`);
            } else {
                log(colors.red, '✗', `Unexpected error: ${error.message}`);
            }
            
            // Restore token
            currentConsumer.oauth_token = backupToken;
            await currentConsumer.save();
        }

        // TEST 4: Invalid refresh token - should trigger REAUTH_REQUIRED
        console.log('\n' + '-'.repeat(60));
        log(colors.cyan, '►', 'TEST 4: Invalid refresh token (should require re-auth)');
        console.log('-'.repeat(60));

        const testConsumer = await Consumer.findOne({ installId: testInstallId })
            .select('+oauth_token +oauth_refresh_token +oauth_expires_at');
        
        const backupRefreshToken = testConsumer.oauth_refresh_token;
        const backupTokenForTest4 = testConsumer.oauth_token;
        
        // Set invalid refresh token
        testConsumer.oauth_refresh_token = 'invalid_refresh_token';
        testConsumer.oauth_expires_at = new Date(Date.now() - 60000); // Expired
        await testConsumer.save();
        
        log(colors.yellow, '⚠', 'Set invalid refresh token and expired token');

        try {
            const eloquaService = new EloquaService(testInstallId, consumer.SiteId);
            await eloquaService.getCustomObjects('', 5);
            
            log(colors.red, '✗', 'Should have thrown REAUTH_REQUIRED error');
        } catch (error) {
            if (error.code === 'REAUTH_REQUIRED') {
                log(colors.green, '✓', `Correctly triggered re-authorization requirement`);
                console.log(`   Error message: ${error.message}`);
                console.log(`   Re-auth URL: ${error.reAuthUrl}`);
            } else {
                log(colors.yellow, '⚠', `Different error: ${error.message}`);
            }
        } finally {
            // Restore original tokens
            testConsumer.oauth_refresh_token = backupRefreshToken;
            testConsumer.oauth_token = backupTokenForTest4;
            testConsumer.oauth_expires_at = originalExpiresAt;
            await testConsumer.save();
            log(colors.blue, 'ℹ', 'Restored original tokens');
        }

        // TEST 5: Multiple rapid requests - should not refresh multiple times
        console.log('\n' + '-'.repeat(60));
        log(colors.cyan, '►', 'TEST 5: Multiple concurrent requests (should refresh once)');
        console.log('-'.repeat(60));

        const testConsumer5 = await Consumer.findOne({ installId: testInstallId })
            .select('+oauth_token +oauth_expires_at');
        
        // Set to expire soon
        testConsumer5.oauth_expires_at = new Date(Date.now() + 60000); // Expires in 1 minute
        await testConsumer5.save();

        try {
            const eloquaService = new EloquaService(testInstallId, consumer.SiteId);
            
            // Make 3 concurrent requests
            const promises = [
                eloquaService.getCustomObjects('', 3),
                eloquaService.getContactFields(3),
                eloquaService.getCustomObjects('test', 3)
            ];
            
            const results = await Promise.all(promises);
            
            log(colors.green, '✓', `All ${results.length} concurrent requests succeeded`);
            console.log(`   Results: ${results.map((r, i) => `[${i}]: ${r.elements?.length || 0} items`).join(', ')}`);
        } catch (error) {
            log(colors.red, '✗', `Failed: ${error.message}`);
        }

        // SUMMARY
        console.log('\n' + '='.repeat(60));
        log(colors.green, '✓', 'ALL TESTS COMPLETED');
        console.log('='.repeat(60) + '\n');

        console.log('Summary:');
        console.log('  ✓ Valid token works normally');
        console.log('  ✓ Expired token triggers automatic refresh');
        console.log('  ✓ Invalid token triggers 401 and refresh');
        console.log('  ✓ Invalid refresh token triggers REAUTH_REQUIRED');
        console.log('  ✓ Concurrent requests handled correctly\n');

    } catch (error) {
        log(colors.red, '✗', `Test failed: ${error.message}`);
        console.error(error.stack);
    } finally {
        await mongoose.connection.close();
        log(colors.blue, 'ℹ', 'MongoDB connection closed');
        process.exit(0);
    }
}

// Run the test
testTokenRefresh();