const mongoose = require('mongoose');

const SmsReplySchema = new mongoose.Schema({
    // Reference to original SMS
    smsLogId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SmsLog',
        index: true
    },
    installId: {
        type: String,
        required: true,
        index: true
    },
    
    // Reply Details
    fromNumber: {
        type: String,
        required: true,
        trim: true,
        index: true
    },
    toNumber: {
        type: String,
        trim: true
    },
    message: {
        type: String,
        required: true
    },
    
    // Timing
    receivedAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    
    // Processing Status
    processed: {
        type: Boolean,
        default: false,
        index: true
    },
    processedAt: Date,
    
    // Webhook Data
    webhookData: {
        type: mongoose.Schema.Types.Mixed
    },
    
    // Classification
    isOptOut: {
        type: Boolean,
        default: false
    },
    isAutoReply: {
        type: Boolean,
        default: false
    },
    
    // Associated Contact
    contactId: String,
    emailAddress: {
        type: String,
        lowercase: true,
        trim: true
    },
    
}, {
    timestamps: true,
    collection: 'smsreplies'
});

// Compound indexes
SmsReplySchema.index({ fromNumber: 1, receivedAt: -1 });
SmsReplySchema.index({ smsLogId: 1, processed: 1 });
SmsReplySchema.index({ installId: 1, processed: 1, receivedAt: -1 });
SmsReplySchema.index({ processed: 1, receivedAt: 1 });

// Virtual for response time (if linked to original SMS)
SmsReplySchema.virtual('responseTime').get(function() {
    // Will be calculated when populated with smsLog
    return null;
});

// Method to mark as processed
SmsReplySchema.methods.markAsProcessed = async function() {
    this.processed = true;
    this.processedAt = new Date();
    return this.save();
};

// Method to check for opt-out keywords
SmsReplySchema.methods.checkOptOut = function() {
    const optOutKeywords = ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
    const messageUpper = this.message.toUpperCase().trim();
    this.isOptOut = optOutKeywords.includes(messageUpper);
    return this.isOptOut;
};

// Static method to find unprocessed replies
SmsReplySchema.statics.findUnprocessed = function(limit = 100) {
    return this.find({ processed: false })
        .sort({ receivedAt: 1 })
        .limit(limit);
};

// Static method to find replies for SMS
SmsReplySchema.statics.findRepliesForSms = function(smsLogId) {
    return this.find({ smsLogId }).sort({ receivedAt: 1 });
};

// Static method to find replies in time window
SmsReplySchema.statics.findInTimeWindow = function(fromNumber, hours = 24) {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return this.find({
        fromNumber,
        receivedAt: { $gte: cutoff }
    }).sort({ receivedAt: -1 });
};

// Pre-save middleware to check opt-out
SmsReplySchema.pre('save', function(next) {
    if (this.isNew || this.isModified('message')) {
        this.checkOptOut();
    }
    next();
});

module.exports = mongoose.model('SmsReply', SmsReplySchema);