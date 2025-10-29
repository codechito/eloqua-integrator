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
    
    // SMS options
    smsOptions: {
        from: String,
        validity: Number,
        dlr_callback: String,
        reply_callback: String,
        link_hits_callback: String,
        tracked_link_url: String
    },
    
    // Custom object data for later update
    customObjectData: {
        customObjectId: String,
        fieldMappings: mongoose.Schema.Types.Mixed,
        recordData: mongoose.Schema.Types.Mixed
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
    
    // Linked records
    smsLogId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SmsLog'
    },
    
    // Metadata
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

// Indexes for worker queries
SmsJobSchema.index({ status: 1, scheduledAt: 1 });
SmsJobSchema.index({ installId: 1, status: 1 });
SmsJobSchema.index({ createdAt: 1 });

// Methods
SmsJobSchema.methods.markAsProcessing = function() {
    this.status = 'processing';
    this.processedAt = new Date();
    return this.save();
};

SmsJobSchema.methods.markAsSent = function(messageId, transmitSmsResponse) {
    this.status = 'sent';
    this.messageId = messageId;
    this.transmitSmsResponse = transmitSmsResponse;
    this.sentAt = new Date();
    return this.save();
};

SmsJobSchema.methods.markAsFailed = function(errorMessage, errorCode) {
    this.status = 'failed';
    this.errorMessage = errorMessage;
    this.errorCode = errorCode;
    this.retryCount += 1;
    this.lastRetryAt = new Date();
    return this.save();
};

SmsJobSchema.methods.canRetry = function() {
    return this.retryCount < this.maxRetries;
};

SmsJobSchema.methods.resetForRetry = function() {
    this.status = 'pending';
    this.processedAt = null;
    this.errorMessage = null;
    this.errorCode = null;
    return this.save();
};

module.exports = mongoose.model('SmsJob', SmsJobSchema);