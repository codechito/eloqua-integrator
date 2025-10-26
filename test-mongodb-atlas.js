require('dotenv').config();
const mongoose = require('mongoose');

console.log('========================================');
console.log('  Testing MongoDB Atlas Connection');
console.log('========================================\n');

const options = {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
};

console.log('Connecting to MongoDB Atlas...');
console.log('This may take a few seconds...\n');

mongoose.connect(process.env.MONGODB_URI, options)
    .then(() => {
        console.log('✓ Successfully connected to MongoDB Atlas!\n');
        console.log('Connection Details:');
        console.log(`  Host: ${mongoose.connection.host}`);
        console.log(`  Database: ${mongoose.connection.name}`);
        console.log(`  Port: ${mongoose.connection.port}`);
        console.log(`  ReadyState: ${mongoose.connection.readyState}`);
        
        return testWriteOperation();
    })
    .then(() => {
        console.log('\n✓ All tests passed!');
        console.log('✓ MongoDB Atlas is ready to use.');
        console.log('========================================\n');
        mongoose.connection.close();
        process.exit(0);
    })
    .catch(err => {
        console.error('\n✗ Connection failed!\n');
        console.error('Error Details:');
        console.error(`  Message: ${err.message}\n`);
        
        if (err.message.includes('authentication failed')) {
            console.error('⚠️  Authentication Error:');
            console.error('  - Check your username and password in .env');
            console.error('  - Make sure you replaced <password> with actual password');
            console.error('  - Verify user has correct permissions');
        } else if (err.message.includes('Could not connect')) {
            console.error('⚠️  Network Error:');
            console.error('  - Check your internet connection');
            console.error('  - Verify IP whitelist in MongoDB Atlas');
            console.error('  - Use 0.0.0.0/0 for development testing');
        }
        
        console.error('========================================\n');
        process.exit(1);
    });

async function testWriteOperation() {
    console.log('\nTesting Database Operations:');
    console.log('----------------------------');
    
    const TestSchema = new mongoose.Schema({
        message: String,
        timestamp: { type: Date, default: Date.now }
    });
    
    const TestModel = mongoose.model('Test', TestSchema);
    
    // Create
    const testDoc = new TestModel({
        message: 'MongoDB Atlas connection test successful!'
    });
    
    await testDoc.save();
    console.log('  ✓ Write operation successful');
    
    // Read
    const found = await TestModel.findById(testDoc._id);
    console.log('  ✓ Read operation successful');
    console.log(`    Message: "${found.message}"`);
    
    // Delete
    await TestModel.deleteOne({ _id: testDoc._id });
    console.log('  ✓ Delete operation successful');
}