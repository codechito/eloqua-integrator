require('dotenv').config();
const connectDB = require('./config/database');
const {
    Consumer,
    ActionInstance,
    DecisionInstance,
    FeederInstance,
    SmsLog,
    SmsReply,
    LinkHit
} = require('./models');

async function testModels() {
    console.log('========================================');
    console.log('  Testing Database Models');
    console.log('========================================\n');
    
    try {
        // Connect to database
        await connectDB();
        
        // Test Consumer Model
        console.log('1. Testing Consumer Model...');
        const testConsumer = new Consumer({
            installId: 'test-install-' + Date.now(),
            SiteId: '1234',
            siteName: 'Test Site',
            transmitsms_api_key: 'test-key',
            transmitsms_api_secret: 'test-secret',
            default_country: 'Australia'
        });
        await testConsumer.save();
        console.log('   ✓ Consumer created:', testConsumer.installId);
        
        // Test ActionInstance Model
        console.log('\n2. Testing ActionInstance Model...');
        const testAction = new ActionInstance({
            instanceId: 'action-' + Date.now(),
            installId: testConsumer.installId,
            SiteId: '1234',
            message: 'Test SMS message',
            recipient_field: 'mobilePhone'
        });
        await testAction.save();
        console.log('   ✓ ActionInstance created:', testAction.instanceId);
        
        // Test DecisionInstance Model
        console.log('\n3. Testing DecisionInstance Model...');
        const testDecision = new DecisionInstance({
            instanceId: 'decision-' + Date.now(),
            installId: testConsumer.installId,
            SiteId: '1234',
            evaluation_period: 24,
            text_type: 'Anything'
        });
        await testDecision.save();
        console.log('   ✓ DecisionInstance created:', testDecision.instanceId);
        
        // Test FeederInstance Model
        console.log('\n4. Testing FeederInstance Model...');
        const testFeeder = new FeederInstance({
            instanceId: 'feeder-' + Date.now(),
            installId: testConsumer.installId,
            SiteId: '1234'
        });
        await testFeeder.save();
        console.log('   ✓ FeederInstance created:', testFeeder.instanceId);
        
        // Test SmsLog Model
        console.log('\n5. Testing SmsLog Model...');
        const testSms = new SmsLog({
            installId: testConsumer.installId,
            instanceId: testAction.instanceId,
            mobileNumber: '+61412345678',
            emailAddress: 'test@example.com',
            message: 'Test SMS',
            status: 'sent'
        });
        await testSms.save();
        console.log('   ✓ SmsLog created:', testSms._id);
        
        // Test SmsReply Model
        console.log('\n6. Testing SmsReply Model...');
        const testReply = new SmsReply({
            smsLogId: testSms._id,
            installId: testConsumer.installId,
            fromNumber: '+61412345678',
            toNumber: '+61400000000',
            message: 'Test reply'
        });
        await testReply.save();
        console.log('   ✓ SmsReply created:', testReply._id);
        
        // Test LinkHit Model
        console.log('\n7. Testing LinkHit Model...');
        const testLinkHit = new LinkHit({
            smsLogId: testSms._id,
            installId: testConsumer.installId,
            mobileNumber: '+61412345678',
            shortUrl: 'https://short.url/abc',
            originalUrl: 'https://example.com/page'
        });
        await testLinkHit.save();
        console.log('   ✓ LinkHit created:', testLinkHit._id);
        
        // Test queries
        console.log('\n8. Testing Model Methods...');
        const foundConsumer = await Consumer.findActiveByInstallId(testConsumer.installId);
        console.log('   ✓ Found consumer by installId:', foundConsumer.installId);
        
        const recentSms = await SmsLog.findRecentByMobile('+61412345678', 24);
        console.log('   ✓ Found recent SMS (count):', recentSms.length);
        
        const unprocessedReplies = await SmsReply.findUnprocessed(10);
        console.log('   ✓ Found unprocessed replies (count):', unprocessedReplies.length);
        
        const unprocessedHits = await LinkHit.findUnprocessed(10);
        console.log('   ✓ Found unprocessed link hits (count):', unprocessedHits.length);
        
        // Test virtual properties
        console.log('\n9. Testing Virtual Properties...');
        console.log('   ✓ Consumer isConfigured:', testConsumer.isConfigured);
        console.log('   ✓ Action successRate:', testAction.successRate + '%');
        console.log('   ✓ Decision replyRate:', testDecision.replyRate + '%');
        
        // Cleanup
        console.log('\n10. Cleaning up test data...');
        await Consumer.deleteOne({ _id: testConsumer._id });
        await ActionInstance.deleteOne({ _id: testAction._id });
        await DecisionInstance.deleteOne({ _id: testDecision._id });
        await FeederInstance.deleteOne({ _id: testFeeder._id });
        await SmsLog.deleteOne({ _id: testSms._id });
        await SmsReply.deleteOne({ _id: testReply._id });
        await LinkHit.deleteOne({ _id: testLinkHit._id });
        console.log('   ✓ Cleanup complete');
        
        console.log('\n✓ All model tests passed!');
        console.log('========================================\n');
        process.exit(0);
        
    } catch (error) {
        console.error('\n✗ Test failed:', error.message);
        console.error('\nStack trace:');
        console.error(error.stack);
        console.error('========================================\n');
        process.exit(1);
    }
}

testModels();