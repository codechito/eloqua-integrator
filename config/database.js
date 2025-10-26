const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        // Modern connection options (no deprecated options)
        const options = {
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        };

        const conn = await mongoose.connect(process.env.MONGODB_URI, options);
        
        console.log('✓ MongoDB Connected');
        console.log(`  Host: ${conn.connection.host}`);
        console.log(`  Database: ${conn.connection.name}`);
        
        return conn;
    } catch (error) {
        console.error('✗ MongoDB Connection Error:', error.message);
        
        if (error.message.includes('authentication')) {
            console.error('  → Check your MongoDB credentials');
        } else if (error.message.includes('ENOTFOUND')) {
            console.error('  → Check your internet connection');
            console.error('  → Verify MongoDB Atlas cluster URL');
        }
        
        process.exit(1);
    }
};

// Handle connection events
mongoose.connection.on('connected', () => {
    console.log('MongoDB connection established');
});

mongoose.connection.on('error', (err) => {
    console.error('MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {
    console.log('MongoDB connection disconnected');
});

// Graceful shutdown
process.on('SIGINT', async () => {
    await mongoose.connection.close();
    console.log('MongoDB connection closed through app termination');
    process.exit(0);
});

module.exports = connectDB;