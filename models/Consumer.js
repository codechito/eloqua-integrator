const mongoose = require('mongoose');

const ConsumerSchema = new mongoose.Schema({
    // Eloqua Installation Info
    installId: {
        type: String,
        required: true,
        unique: true,
        index: true,
        trim: true
    },
    SiteId: {
        type: String,
        required: true,
        trim: true
    },
    siteName: {
        type: String,
        default: 'Unknown Site'
    },
    
    // TransmitSMS Credentials
    transmitsms_api_key: {
        type: String,
        trim: true
    },
    transmitsms_api_secret: {
        type: String,
        trim: true
    },
    
    // Configuration
    default_country: {
        type: String,
        default: 'Australia',
        trim: true
    },
    
    // Webhook URLs
    dlr_callback: {
        type: String,
        trim: true
    },
    reply_callback: {
        type: String,
        trim: true
    },
    link_hits_callback: {
        type: String,
        trim: true
    },
    
    // OAuth Tokens
    oauth_token: {
        type: String,
        select: false // Don't return in queries by default
    },
    oauth_refresh_token: {
        type: String,
        select: false
    },
    oauth_expires_at: {
        type: Date
    },
    oauth_token_type: {
        type: String,
        default: 'Bearer'
    },
    
    // Custom Object Mappings for different action types
    actions: {
        sendsms: {
            custom_object_id: String,
            mobile_field: String,
            vn_field: String,
            email_field: String,
            title_field: String,
            notification_field: String,
            outgoing_field: String
        },
        receivesms: {
            custom_object_id: String,
            mobile_field: String,
            vn_field: String,
            email_field: String,
            title_field: String,
            response_field: String
        },
        incomingsms: {
            custom_object_id: String,
            mobile_field: String,
            vn_field: String,
            email_field: String,
            title_field: String,
            response_field: String
        },
        tracked_link: {
            custom_object_id: String,
            mobile_field: String,
            vn_field: String,
            email_field: String,
            title_field: String,
            link_hits: String,
            url_field: String,
            originalurl_field: String
        }
    },
    
    // Status
    isActive: {
        type: Boolean,
        default: true,
        index: true
    },
    
    // Metadata
    lastSyncedAt: Date,
    configuredAt: Date,
    
}, {
    timestamps: true,
    collection: 'consumers'
});

// Indexes
ConsumerSchema.index({ installId: 1, isActive: 1 });
ConsumerSchema.index({ SiteId: 1 });

// Virtual for checking if OAuth is valid
ConsumerSchema.virtual('isOAuthValid').get(function() {
    if (!this.oauth_token || !this.oauth_expires_at) {
        return false;
    }
    return new Date() < this.oauth_expires_at;
});

// Virtual for checking if configured
ConsumerSchema.virtual('isConfigured').get(function() {
    return !!(this.transmitsms_api_key && this.transmitsms_api_secret);
});

// Method to check if OAuth needs refresh
ConsumerSchema.methods.needsTokenRefresh = function() {
    if (!this.oauth_expires_at) return true;
    const bufferTime = 5 * 60 * 1000; // 5 minutes buffer
    return new Date().getTime() + bufferTime >= this.oauth_expires_at.getTime();
};

// Method to update last synced
ConsumerSchema.methods.updateLastSynced = async function() {
    this.lastSyncedAt = new Date();
    return this.save();
};

// Pre-save middleware
ConsumerSchema.pre('save', function(next) {
    if (this.isModified('transmitsms_api_key') || this.isModified('transmitsms_api_secret')) {
        this.configuredAt = new Date();
    }
    next();
});

// Static method to find active consumer
ConsumerSchema.statics.findActiveByInstallId = function(installId) {
    return this.findOne({ installId, isActive: true });
};

module.exports = mongoose.model('Consumer', ConsumerSchema);