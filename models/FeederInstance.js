const mongoose = require('mongoose');

const FeederInstanceSchema = new mongoose.Schema({
    // Eloqua instance info
    instanceId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    installId: {
        type: String,
        required: true,
        index: true
    },
    SiteId: {
        type: String,
        required: true
    },
    assetId: {
        type: String
    },
    assetName: {
        type: String
    },
    
    // Feeder type: 'incoming_sms' or 'link_hits'
    feederType: {
        type: String,
        enum: ['incoming_sms', 'link_hits'],
        required: true
    },
    
    // Configuration for incoming SMS feeder
    senderIds: [{
        type: String,
        trim: true
    }],
    textType: {
        type: String,
        enum: ['Anything', 'Keyword'],
        default: 'Anything'
    },
    keyword: {
        type: String,
        trim: true
    },
    customObjectId: {
        type: String
    },
    
    // Field mappings
    fieldMappings: {
        mobile: String,
        email: String,
        message: String,
        timestamp: String,
        messageId: String,
        senderId: String,
        // For link hits
        url: String,
        originalUrl: String,
        linkHits: String
    },
    
    // Feeder state
    isActive: {
        type: Boolean,
        default: true
    },
    
    lastPolledAt: {
        type: Date
    },
    
    totalRecordsSent: {
        type: Number,
        default: 0
    },
    
    // Metadata
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

// Indexes
FeederInstanceSchema.index({ installId: 1, feederType: 1 });
FeederInstanceSchema.index({ isActive: 1 });

// Methods
FeederInstanceSchema.methods.incrementRecordsSent = function(count = 1) {
    this.totalRecordsSent += count;
    this.lastPolledAt = new Date();
    return this.save();
};

module.exports = mongoose.model('FeederInstance', FeederInstanceSchema);