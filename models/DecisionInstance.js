const mongoose = require('mongoose');

const DecisionInstanceSchema = new mongoose.Schema({
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
    
    // Decision Configuration
    evaluation_period: {
        type: Number,
        required: true,
        default: 24,
        min: 1,
        max: 168 // 7 days
    },
    text_type: {
        type: String,
        enum: ['Anything', 'Keyword'],
        default: 'Anything'
    },
    keyword: {
        type: String,
        trim: true
    },
    
    // Custom Object Mapping
    custom_object_id: {
        type: String,
        trim: true
    },
    mobile_field: {
        type: String,
        trim: true
    },
    email_field: {
        type: String,
        trim: true
    },
    response_field: {
        type: String,
        trim: true
    },
    title_field: {
        type: String,
        trim: true
    },
    
    // Status
    isActive: {
        type: Boolean,
        default: true,
        index: true
    },
    
    // Statistics
    totalEvaluations: {
        type: Number,
        default: 0
    },
    totalRepliesFound: {
        type: Number,
        default: 0
    },
    lastExecutedAt: Date,
    
}, {
    timestamps: true,
    collection: 'decisioninstances'
});

// Indexes
DecisionInstanceSchema.index({ instanceId: 1, isActive: 1 });
DecisionInstanceSchema.index({ installId: 1, isActive: 1 });
DecisionInstanceSchema.index({ assetId: 1 });

// Virtual for reply rate
DecisionInstanceSchema.virtual('replyRate').get(function() {
    if (this.totalEvaluations === 0) return 0;
    return ((this.totalRepliesFound / this.totalEvaluations) * 100).toFixed(2);
});

// Method to increment stats
DecisionInstanceSchema.methods.recordEvaluation = async function(foundReply) {
    this.totalEvaluations += 1;
    if (foundReply) {
        this.totalRepliesFound += 1;
    }
    this.lastExecutedAt = new Date();
    return this.save();
};

// Static method to find active instance
DecisionInstanceSchema.statics.findActiveInstance = function(instanceId, installId) {
    return this.findOne({ instanceId, installId, isActive: true });
};

module.exports = mongoose.model('DecisionInstance', DecisionInstanceSchema);