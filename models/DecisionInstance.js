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
    
    // Configuration
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
    
    // Custom Object Mapping
    custom_object_id: String,
    mobile_field: String,
    email_field: String,
    title_field: String,
    response_field: String,
    vn_field: String,
    
    // Configuration status
    requiresConfiguration: {
        type: Boolean,
        default: true
    },
    
    // Status
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true
});

// Index for efficient querying
DecisionInstanceSchema.index({ installId: 1, isActive: 1 });

module.exports = mongoose.model('DecisionInstance', DecisionInstanceSchema);