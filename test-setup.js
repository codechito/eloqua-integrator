const mongoose = require('mongoose');
require('dotenv').config();

console.log('========================================');
console.log('  Testing Setup');
console.log('========================================\n');

console.log('✓ Environment variables loaded');
console.log(`  PORT: ${process.env.PORT}`);
console.log(`  NODE_ENV: ${process.env.NODE_ENV || 'not set'}`);
console.log(`  MONGODB_URI: ${process.env.MONGODB_URI ? '***configured***' : 'NOT SET'}`);

if (!process.env.MONGODB_URI) {
    console.error('\n✗ MONGODB_URI is not set in .env file');
    console.error('  Please configure your MongoDB connection string');
    process.exit(1);
}

// Modern connection options
const options = {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
};

console.log('\nConnecting to MongoDB...');

mongoose.connect(process.env.MONGODB_URI, options)
.then(() => {
    console.log('\n✓ MongoDB connection successful');
    console.log(`  Database: ${mongoose.connection.name}`);
    console.log(`  Host: ${mongoose.connection.host}`);
    mongoose.connection.close();
    console.log('\n✓ Setup verification complete!');
    console.log('========================================\n');
    process.exit(0);
})
.catch(err => {
    console.error('\n✗ MongoDB connection failed:', err.message);
    console.error('\nTroubleshooting steps:');
    console.error('  1. Check connection string in .env file');
    console.error('  2. Verify username and password are correct');
    console.error('  3. Ensure IP address is whitelisted (0.0.0.0/0 for dev)');
    console.error('  4. Check internet connection');
    console.error('========================================\n');
    process.exit(1);
});