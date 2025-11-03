const mongoose = require('mongoose');

const SmsLogSchema = new mongoose.Schema({
    // Reference Information
    installId: {
        type: String,
        required: true,
        index: true
    },
    instanceId: {
        type: String,
        index: true
    },
    
    // Contact Information
    contactId: {
        type: String,
        index: true
    },
    emailAddress: {
        type: String,
        trim: true,
        lowercase: true,
        index: true
    },
    mobileNumber: {
        type: String,
        required: true,
        trim: true,
        index: true
    },
    
    // SMS Details
    message: {
        type: String,
        required: true
    },
    messageId: {
        type: String,
        unique: true,
        sparse: true,
        index: true
    },
    senderId: {
        type: String,
        trim: true
    },
    campaignTitle: {
        type: String,
        trim: true
    },
    
    // Status Tracking
    status: {
        type: String,
        enum: ['pending', 'sent', 'delivered', 'failed', 'expired'],
        default: 'pending',
        index: true
    },
    
    // Response Data
    transmitSmsResponse: {
        type: mongoose.Schema.Types.Mixed
    },
    errorMessage: {
        type: String
    },
    errorCode: {
        type: String
    },
    
    // Timestamps
    sentAt: {
        type: Date,
        index: true
    },
    deliveredAt: Date,
    
    // Tracking
    trackedLink: {
        shortUrl: String,
        originalUrl: String
    },
    trackedLinkRequested: {
        type: Boolean,
        default: false
    },
    trackedLinkOriginalUrl: {
        type: String
    },
    trackedLinkShortUrl: {
        type: String  // Will be populated from webhook
    },
    
    // Metadata
    cost: Number,
    messageCount: {
        type: Number,
        default: 1
    },
    
}, {
    timestamps: true,
    collection: 'smslogs'
});

// Compound indexes for efficient queries
SmsLogSchema.index({ installId: 1, status: 1, createdAt: -1 });
SmsLogSchema.index({ mobileNumber: 1, createdAt: -1 });
SmsLogSchema.index({ emailAddress: 1, createdAt: -1 });
SmsLogSchema.index({ messageId: 1, status: 1 });
SmsLogSchema.index({ contactId: 1, createdAt: -1 });

// Virtual for delivery time
SmsLogSchema.virtual('deliveryTime').get(function() {
    if (!this.sentAt || !this.deliveredAt) return null;
    return Math.round((this.deliveredAt - this.sentAt) / 1000); // seconds
});

// Method to mark as sent
SmsLogSchema.methods.markAsSent = async function(messageId, response) {
    this.status = 'sent';
    this.messageId = messageId;
    this.sentAt = new Date();
    this.transmitSmsResponse = response;
    return this.save();
};

// Method to mark as delivered
SmsLogSchema.methods.markAsDelivered = async function() {
    this.status = 'delivered';
    this.deliveredAt = new Date();
    return this.save();
};

// Method to mark as failed
SmsLogSchema.methods.markAsFailed = async function(errorMessage, errorCode) {
    this.status = 'failed';
    this.errorMessage = errorMessage;
    this.errorCode = errorCode;
    return this.save();
};

// Static method to find recent SMS for mobile number
SmsLogSchema.statics.findRecentByMobile = function(mobileNumber, hours = 24) {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return this.find({
        mobileNumber,
        createdAt: { $gte: cutoff }
    }).sort({ createdAt: -1 });
};

// Static method to get statistics
SmsLogSchema.statics.getStats = async function(installId, startDate, endDate) {
    return this.aggregate([
        {
            $match: {
                installId,
                createdAt: { $gte: startDate, $lte: endDate }
            }
        },
        {
            $group: {
                _id: '$status',
                count: { $sum: 1 },
                totalCost: { $sum: '$cost' }
            }
        }
    ]);
};

module.exports = mongoose.model('SmsLog', SmsLogSchema);