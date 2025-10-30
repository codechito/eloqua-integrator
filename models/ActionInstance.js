const mongoose = require('mongoose');

const ActionInstanceSchema = new mongoose.Schema({
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
    assetName: String,
    
    // Configuration
    caller_id: String,
    recipient_field: String,
    custom_object_id: String,
    country_field: String,
    mobile_field: String,
    email_field: String,
    title_field: String,
    notification_field: String,
    outgoing_field: String,
    vn_field: String,
    message: String,
    tracked_link: String,
    message_expiry: {
        type: String,
        default: 'NO'
    },
    message_validity: {
        type: Number,
        default: 1
    },
    send_mode: {
        type: String,
        enum: ['all', 'first', 'last'],
        default: 'all'
    },
    test_phone: String,
    
    // Configuration status
    requiresConfiguration: {
        type: Boolean,
        default: true
    },
    
    // Statistics
    totalSent: {
        type: Number,
        default: 0
    },
    totalFailed: {
        type: Number,
        default: 0
    },
    lastExecutedAt: Date,
    
    // Status
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true
});

// Methods
ActionInstanceSchema.methods.incrementSent = function() {
    this.totalSent += 1;
    this.lastExecutedAt = new Date();
    return this.save();
};

ActionInstanceSchema.methods.incrementFailed = function() {
    this.totalFailed += 1;
    this.lastExecutedAt = new Date();
    return this.save();
};

// Index for efficient querying
ActionInstanceSchema.index({ installId: 1, isActive: 1 });

module.exports = mongoose.model('ActionInstance', ActionInstanceSchema);