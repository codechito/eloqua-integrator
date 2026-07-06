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

    // Feeder type — 'link_hits' (default) or 'incoming_sms'
    feederType: {
        type: String,
        enum: ['link_hits', 'incoming_sms'],
        default: 'link_hits'
    },

    // Incoming SMS feeder config
    sender_id: String,   // virtual number to monitor
    text_type: {
        type: String,
        enum: ['Anything', 'Keyword'],
        default: 'Anything'
    },
    keyword: String,

    // Link Hits feeder — Custom Object Mapping
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
        default: false
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