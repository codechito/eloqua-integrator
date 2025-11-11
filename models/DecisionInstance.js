// models/DecisionInstance.js - UPDATE schema

const mongoose = require('mongoose');

const DecisionInstanceSchema = new mongoose.Schema({
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
    assetId: String,
    
    // Decision Configuration (only decision-specific settings)
    evaluation_period: {
        type: Number,
        default: 1,
        min: 1,
        max: 168 // 7 days
    },
    text_type: {
        type: String,
        enum: ['Anything', 'Keyword'],
        default: 'Anything'
    },
    keyword: String,
    
    // NOTE: Custom object mapping is now in Consumer.actions.receivesms
    // No longer storing CDO fields here
    
    // Configuration status
    requiresConfiguration: {
        type: Boolean,
        default: true
    },
    
    configureAt: Date,
    
    // Status
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true,
    collection: 'decision_instances'
});

// Index for efficient querying
DecisionInstanceSchema.index({ installId: 1, isActive: 1 });
DecisionInstanceSchema.index({ instanceId: 1, isActive: 1 });

module.exports = mongoose.model('DecisionInstance', DecisionInstanceSchema);