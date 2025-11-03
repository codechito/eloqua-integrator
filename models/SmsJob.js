const mongoose = require('mongoose');

const SmsJobSchema = new mongoose.Schema({
    // Job identification
    jobId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    
    // Instance info
    installId: {
        type: String,
        required: true,
        index: true
    },
    instanceId: {
        type: String,
        required: true,
        index: true
    },
    executionId: {
        type: String,
        index: true
    },
    
    // Contact info
    contactId: {
        type: String,
        required: true,
        index: true
    },
    emailAddress: {
        type: String
    },
    
    // SMS details
    mobileNumber: {
        type: String,
        required: true
    },
    message: {
        type: String,
        required: true
    },
    senderId: {
        type: String
    },
    
    // Campaign info
    campaignId: {
        type: String
    },
    campaignTitle: {
        type: String
    },
    assetName: {
        type: String
    },
    
    // SMS options - FIXED: Use camelCase and add country
    smsOptions: {
        from: String,
        country: String,                    // ← ADD THIS
        validity: Number,
        messageExpiry: Boolean,             // ← ADD THIS
        messageValidity: Number,            // ← ADD THIS
        dlrCallback: String,                // ← Changed from dlr_callback
        replyCallback: String,              // ← Changed from reply_callback
        linkHitsCallback: String,           // ← Changed from link_hits_callback
        trackedLinkUrl: String              // ← Changed from tracked_link_url
    },
    
    // Custom object data for later update
    customObjectData: {
        customObjectId: String,
        fields: mongoose.Schema.Types.Mixed  // ← Simplified
    },
    
    // Status
    status: {
        type: String,
        enum: ['pending', 'processing', 'sent', 'failed', 'cancelled'],
        default: 'pending',
        index: true
    },
    
    // Execution details
    scheduledAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    processingStartedAt: {
        type: Date
    },
    processedAt: {
        type: Date
    },
    sentAt: {
        type: Date
    },
    
    // Response from TransmitSMS
    messageId: {
        type: String,
        index: true
    },
    transmitSmsResponse: {
        type: mongoose.Schema.Types.Mixed
    },
    
    // Error handling
    errorMessage: {
        type: String
    },
    errorCode: {
        type: String
    },
    retryCount: {
        type: Number,
        default: 0
    },
    maxRetries: {
        type: Number,
        default: 3
    },
    lastRetryAt: {
        type: Date
    },

    executionId: {
        type: String,
        index: true
    },
    
    // Linked records
    smsLogId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SmsLog'
    }
}, {
    timestamps: true
});

// Indexes for worker queries
SmsJobSchema.index({ status: 1, scheduledAt: 1 });
SmsJobSchema.index({ installId: 1, status: 1 });
SmsJobSchema.index({ instanceId: 1, executionId: 1 });

// Methods
SmsJobSchema.methods.markAsProcessing = async function() {
    this.status = 'processing';
    this.processingStartedAt = new Date();
    this.processedAt = new Date();
    return await this.save();
};

SmsJobSchema.methods.markAsSent = async function(messageId, transmitSmsResponse) {
    this.status = 'sent';
    this.messageId = messageId;
    this.transmitSmsResponse = transmitSmsResponse;
    this.sentAt = new Date();
    return await this.save();
};

SmsJobSchema.methods.markAsFailed = async function(errorMessage, errorCode) {
    this.status = 'failed';
    this.errorMessage = errorMessage;
    this.errorCode = errorCode;
    this.lastRetryAt = new Date();
    return await this.save();
};

SmsJobSchema.methods.canRetry = function() {
    return this.retryCount < this.maxRetries;
};

SmsJobSchema.methods.resetForRetry = async function() {
    this.status = 'pending';
    this.retryCount += 1;
    this.scheduledAt = new Date(Date.now() + (this.retryCount * 60000)); // Retry after N minutes
    this.processingStartedAt = null;
    this.processedAt = null;
    this.errorMessage = null;
    this.errorCode = null;
    return await this.save();
};

module.exports = mongoose.model('SmsJob', SmsJobSchema);