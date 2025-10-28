const mongoose = require('mongoose');

const ActionInstanceSchema = new mongoose.Schema({
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
    
    // SMS Configuration
    message: {
        type: String,
        required: false
    },
    caller_id: {
        type: String,
        trim: false
    },
    
    // Field Mappings
    recipient_field: {
        type: String,
        required: false,
        trim: true
    },
    country_field: {
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
    title_field: {
        type: String,
        trim: true
    },
    notification_field: {
        type: String,
        trim: true
    },
    outgoing_field: {
        type: String,
        trim: true
    },
    vn_field: {
        type: String,
        trim: true
    },
    
    // Tracked Link
    tracked_link: {
        type: String,
        trim: true
    },
    
    // Message Options
    message_expiry: {
        type: String,
        enum: ['YES', 'NO'],
        default: 'NO'
    },
    message_validity: {
        type: Number,
        default: 1,
        min: 1,
        max: 72
    },
    
    // Send Mode
    send_mode: {
        type: String,
        enum: ['all', 'first', 'last'],
        default: 'all'
    },
    
    // Program Configuration
    program_coid: {
        type: String,
        trim: true
    },
    
    // Testing
    test_phone: {
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
    totalSent: {
        type: Number,
        default: 0
    },
    totalFailed: {
        type: Number,
        default: 0
    },
    lastExecutedAt: Date,
    
}, {
    timestamps: true,
    collection: 'actioninstances'
});

// Indexes
ActionInstanceSchema.index({ instanceId: 1, isActive: 1 });
ActionInstanceSchema.index({ installId: 1, isActive: 1 });
ActionInstanceSchema.index({ assetId: 1 });

// Virtual for success rate
ActionInstanceSchema.virtual('successRate').get(function() {
    const total = this.totalSent + this.totalFailed;
    if (total === 0) return 0;
    return ((this.totalSent / total) * 100).toFixed(2);
});

// Method to increment stats
ActionInstanceSchema.methods.incrementSent = async function() {
    this.totalSent += 1;
    this.lastExecutedAt = new Date();
    return this.save();
};

ActionInstanceSchema.methods.incrementFailed = async function() {
    this.totalFailed += 1;
    this.lastExecutedAt = new Date();
    return this.save();
};

// Static method to find by instance and install ID
ActionInstanceSchema.statics.findActiveInstance = function(instanceId, installId) {
    return this.findOne({ instanceId, installId, isActive: true });
};

module.exports = mongoose.model('ActionInstance', ActionInstanceSchema);