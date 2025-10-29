require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');

// Import models
const Consumer = require('./models/Consumer');
const ActionInstance = require('./models/ActionInstance');
const DecisionInstance = require('./models/DecisionInstance');
const FeederInstance = require('./models/FeederInstance');
const SmsLog = require('./models/SmsLog');
const SmsReply = require('./models/SmsReply');
const LinkHit = require('./models/LinkHit');

async function testModels() {
    try {
        console.log('Starting Model Tests...\n');

        // Connect to MongoDB
        console.log('Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true
        });
        
        const dbHost = mongoose.connection.host;
        const dbName = mongoose.connection.name;
        
        console.log('✓ MongoDB Connected');
        console.log(`  Host: ${dbHost}`);
        console.log(`  Database: ${dbName}`);

        // Test Consumer
        console.log('\n1. Testing Consumer Model...');
        const testConsumer = new Consumer({
            installId: 'test-install-' + Date.now(),
            SiteId: 'test-site-123',
            siteName: 'Test Site',
            transmitsms_api_key: 'test_api_key',
            transmitsms_api_secret: 'test_api_secret',
            default_country: 'Australia',
            actions: {
                sendsms: {
                    custom_object_id: '123'
                },
                receivesms: {},
                incomingsms: {},
                tracked_link: {}
            }
        });

        await testConsumer.save();
        console.log('   ✓ Consumer created:', testConsumer.installId);

        // Test ActionInstance
        console.log('\n2. Testing ActionInstance Model...');
        const testAction = new ActionInstance({
            instanceId: 'action-' + Date.now(),
            installId: testConsumer.installId,
            SiteId: testConsumer.SiteId,
            message: 'Test SMS message',
            recipient_field: 'mobilePhone',
            caller_id: '61412345678'
        });

        await testAction.save();
        console.log('   ✓ ActionInstance created:', testAction.instanceId);

        // Test DecisionInstance
        console.log('\n3. Testing DecisionInstance Model...');
        const testDecision = new DecisionInstance({
            instanceId: 'decision-' + Date.now(),
            installId: testConsumer.installId,
            SiteId: testConsumer.SiteId,
            evaluation_period: 24,
            text_type: 'Keyword',
            keyword: 'YES'
        });

        await testDecision.save();
        console.log('   ✓ DecisionInstance created:', testDecision.instanceId);

        // Test FeederInstance
        console.log('\n4. Testing FeederInstance Model...');
        const testFeeder = new FeederInstance({
            instanceId: 'feeder-' + Date.now(),
            installId: testConsumer.installId,
            SiteId: testConsumer.SiteId,
            feederType: 'incoming_sms', // REQUIRED FIELD
            senderIds: ['61412345678'],
            fieldMappings: {
                mobile: 'mobileNumber',
                message: 'incomingMessage',
                timestamp: 'receivedAt',
                messageId: 'smsMessageId',
                senderId: 'virtualNumber'
            }
        });

        await testFeeder.save();
        console.log('   ✓ FeederInstance created:', testFeeder.instanceId);

        // Test SmsLog
        console.log('\n5. Testing SmsLog Model...');
        const testSmsLog = new SmsLog({
            installId: testConsumer.installId,
            instanceId: testAction.instanceId,
            contactId: 'contact-123',
            emailAddress: 'test@example.com',
            mobileNumber: '+61412345678',
            message: 'Test SMS message',
            messageId: 'msg-' + Date.now(),
            senderId: '61412345678',
            status: 'sent'
        });

        await testSmsLog.save();
        console.log('   ✓ SmsLog created:', testSmsLog.messageId);

        // Test SmsReply
        console.log('\n6. Testing SmsReply Model...');
        const testReply = new SmsReply({
            smsLogId: testSmsLog._id,
            installId: testConsumer.installId,
            contactId: 'contact-123',
            fromNumber: '+61412345678',
            toNumber: '61412345678',
            message: 'Test reply message',
            messageId: testSmsLog.messageId,
            responseId: 'response-' + Date.now(),
            receivedAt: new Date()
        });

        await testReply.save();
        console.log('   ✓ SmsReply created:', testReply.responseId);

        // Test LinkHit
        console.log('\n7. Testing LinkHit Model...');
        const testLinkHit = new LinkHit({
            smsLogId: testSmsLog._id,
            installId: testConsumer.installId,
            contactId: 'contact-123',
            mobileNumber: '+61412345678',
            shortUrl: 'https://tap.th/abc123',
            originalUrl: 'https://example.com',
            clickedAt: new Date()
        });

        await testLinkHit.save();
        console.log('   ✓ LinkHit created:', testLinkHit._id);

        // Test relationships
        console.log('\n8. Testing Model Relationships...');
        
        // Find SMS with replies
        const smsWithReplies = await SmsLog.findById(testSmsLog._id);
        const replies = await SmsReply.find({ smsLogId: smsWithReplies._id });
        console.log('   ✓ SMS has', replies.length, 'reply(ies)');

        // Find SMS with link hits
        const linkHits = await LinkHit.find({ smsLogId: smsWithReplies._id });
        console.log('   ✓ SMS has', linkHits.length, 'link hit(s)');

        // Find consumer with instances
        const consumer = await Consumer.findOne({ installId: testConsumer.installId });
        const actions = await ActionInstance.find({ installId: consumer.installId });
        const decisions = await DecisionInstance.find({ installId: consumer.installId });
        const feeders = await FeederInstance.find({ installId: consumer.installId });
        
        console.log('   ✓ Consumer has', actions.length, 'action instance(s)');
        console.log('   ✓ Consumer has', decisions.length, 'decision instance(s)');
        console.log('   ✓ Consumer has', feeders.length, 'feeder instance(s)');

        // Test queries
        console.log('\n9. Testing Common Queries...');
        
        // Find unprocessed replies
        const unprocessedReplies = await SmsReply.find({ 
            processed: { $ne: true } 
        });
        console.log('   ✓ Found', unprocessedReplies.length, 'unprocessed reply(ies)');

        // Find pending SMS logs
        const pendingSms = await SmsLog.find({ 
            status: 'pending' 
        });
        console.log('   ✓ Found', pendingSms.length, 'pending SMS log(s)');

        // Find active feeders
        const activeFeeders = await FeederInstance.find({ 
            isActive: true 
        });
        console.log('   ✓ Found', activeFeeders.length, 'active feeder(s)');

        // Find link hits in last 24 hours
        const recentLinkHits = await LinkHit.find({
            clickedAt: { 
                $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) 
            }
        });
        console.log('   ✓ Found', recentLinkHits.length, 'link hit(s) in last 24 hours');

        // Test model methods
        console.log('\n10. Testing Model Methods...');
        
        // Test Consumer methods
        const needsRefresh = testConsumer.needsTokenRefresh();
        console.log('   ✓ Consumer.needsTokenRefresh():', needsRefresh);

        // Test ActionInstance methods
        await testAction.incrementSent();
        console.log('   ✓ ActionInstance.incrementSent() - Total sent:', testAction.totalSent);

        await testAction.incrementFailed();
        console.log('   ✓ ActionInstance.incrementFailed() - Total failed:', testAction.totalFailed);

        // Test FeederInstance methods
        await testFeeder.incrementRecordsSent(5);
        console.log('   ✓ FeederInstance.incrementRecordsSent(5) - Total:', testFeeder.totalRecordsSent);

        // Cleanup test data
        console.log('\n11. Cleaning up test data...');
        await Consumer.deleteMany({ installId: testConsumer.installId });
        await ActionInstance.deleteMany({ instanceId: testAction.instanceId });
        await DecisionInstance.deleteMany({ instanceId: testDecision.instanceId });
        await FeederInstance.deleteMany({ instanceId: testFeeder.instanceId });
        await SmsLog.deleteMany({ messageId: testSmsLog.messageId });
        await SmsReply.deleteMany({ responseId: testReply.responseId });
        await LinkHit.deleteMany({ _id: testLinkHit._id });
        console.log('   ✓ Test data cleaned up');

        console.log('\n========================================');
        console.log('  ✓ ALL TESTS PASSED!');
        console.log('========================================\n');

    } catch (error) {
        console.error('\n✗ Test failed:', error.message);
        console.error('\nStack trace:');
        console.error(error.stack);
        process.exit(1);
    } finally {
        // Close connection
        await mongoose.connection.close();
        console.log('MongoDB connection closed');
        process.exit(0);
    }
}

// Run tests
testModels();