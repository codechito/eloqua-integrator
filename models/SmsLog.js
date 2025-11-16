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
        required: false,  // ✅ CHANGED: Allow null for errors
        index: true
    },
    
    // SMS Details
    message: {
        type: String,
        required: true
    },
    messageId: {
        type: String,
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
    decisionInstanceId: {
        type: String,
        index: true
    },
    decisionStatus: {
        type: String,
        enum: ['pending', 'yes', 'no'],
        default: 'pending'
    },
    decisionProcessedAt: Date,
    // Response Tracking
    hasResponse: {
        type: Boolean,
        default: false,
        index: true
    },
    responseMessage: {
        type: String
    },
    responseReceivedAt: {
        type: Date
    },
    responseMessageId: {
        type: String
    },
    
    // Link between original SMS and response
    linkedReplyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SmsReply',
        index: true
    },
    
    // Decision tracking deadline
    decisionDeadline: {
        type: Date,
        index: true
    },
    
    // Campaign/Asset tracking
    campaignId: {
        type: String,
        index: true
    },
    executionId: {
        type: String,
        index: true
    }
    
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
SmsLogSchema.index({ messageId: 1, hasResponse: 1 });
SmsLogSchema.index({ decisionInstanceId: 1, decisionStatus: 1, decisionDeadline: 1 });
SmsLogSchema.index({ installId: 1, campaignId: 1, contactId: 1 });

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

// ADD this method
SmsLogSchema.methods.markAsReplied = async function(responseMessage, responseMessageId, replyId) {
    this.hasResponse = true;
    this.responseMessage = responseMessage;
    this.responseReceivedAt = new Date();
    this.responseMessageId = responseMessageId;
    this.linkedReplyId = replyId;
    
    if (this.decisionStatus === 'pending') {
        this.decisionStatus = 'yes';
        this.decisionProcessedAt = new Date();
    }
    
    return this.save();
};

// ADD this static method
SmsLogSchema.statics.findByMessageIdWithinPeriod = function(messageId, hours) {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return this.findOne({
        messageId,
        sentAt: { $gte: cutoff },
        decisionInstanceId: { $ne: null },
        decisionStatus: 'pending'
    });
};

module.exports = mongoose.model('SmsLog', SmsLogSchema);