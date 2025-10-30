const mongoose = require('mongoose');

const FeederInstanceSchema = new mongoose.Schema({
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
    
    // Custom Object Mapping (optional for feeder)
    custom_object_id: String,
    mobile_field: String,
    email_field: String,
    title_field: String,
    url_field: String,
    originalurl_field: String,
    link_hits_field: String,
    vn_field: String,
    
    // Configuration status
    requiresConfiguration: {
        type: Boolean,
        default: false // Feeder can work without configuration
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
FeederInstanceSchema.index({ installId: 1, isActive: 1 });

module.exports = mongoose.model('FeederInstance', FeederInstanceSchema);