const mongoose = require('mongoose');

const FeederInstanceSchema = new mongoose.Schema({
    // Instance Identification
    instanceId: {
        type: String,
        required: true,
        unique: true,
        index: true,
        trim: true
    },
    installId: {
        type: String,
        required: true,
        ref: 'Consumer',
        index: true
    },
    SiteId: {
        type: String,
        required: true
    },
    assetId: {
        type: String,
        trim: true
    },
    assetName: {
        type: String,
        trim: true
    },
    
    // Configuration
    batchSize: {
        type: Number,
        default: 50,
        min: 1,
        max: 100
    },
    
    // Status
    isActive: {
        type: Boolean,
        default: true,
        index: true
    },
    
    // Statistics
    totalLinkHitsProcessed: {
        type: Number,
        default: 0
    },
    lastExecutedAt: Date,
    
}, {
    timestamps: true,
    collection: 'feederinstances'
});

// Indexes
FeederInstanceSchema.index({ instanceId: 1, isActive: 1 });
FeederInstanceSchema.index({ installId: 1, isActive: 1 });

// Method to increment stats
FeederInstanceSchema.methods.recordProcessing = async function(count) {
    this.totalLinkHitsProcessed += count;
    this.lastExecutedAt = new Date();
    return this.save();
};

// Static method to find active instance
FeederInstanceSchema.statics.findActiveInstance = function(instanceId, installId) {
    return this.findOne({ instanceId, installId, isActive: true });
};

module.exports = mongoose.model('FeederInstance', FeederInstanceSchema);