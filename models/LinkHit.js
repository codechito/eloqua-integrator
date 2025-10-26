const mongoose = require('mongoose');

const LinkHitSchema = new mongoose.Schema({
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
    
    // Mobile Number
    mobileNumber: {
        type: String,
        required: true,
        trim: true,
        index: true
    },
    
    // Link Details
    shortUrl: {
        type: String,
        trim: true,
        index: true
    },
    originalUrl: {
        type: String,
        trim: true
    },
    
    // Click Information
    clickedAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    ipAddress: {
        type: String,
        trim: true
    },
    userAgent: {
        type: String,
        trim: true
    },
    
    // Geolocation (if available)
    country: String,
    city: String,
    
    // Device Info
    deviceType: {
        type: String,
        enum: ['mobile', 'tablet', 'desktop', 'unknown'],
        default: 'unknown'
    },
    browser: String,
    os: String,
    
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
    
    // Associated Contact
    contactId: String,
    emailAddress: {
        type: String,
        lowercase: true,
        trim: true
    },
    
}, {
    timestamps: true,
    collection: 'linkhits'
});

// Compound indexes
LinkHitSchema.index({ mobileNumber: 1, clickedAt: -1 });
LinkHitSchema.index({ smsLogId: 1, processed: 1 });
LinkHitSchema.index({ installId: 1, processed: 1, clickedAt: -1 });
LinkHitSchema.index({ shortUrl: 1, clickedAt: -1 });
LinkHitSchema.index({ processed: 1, clickedAt: 1 });

// Method to mark as processed
LinkHitSchema.methods.markAsProcessed = async function() {
    this.processed = true;
    this.processedAt = new Date();
    return this.save();
};

// Method to parse device info from user agent
LinkHitSchema.methods.parseUserAgent = function() {
    if (!this.userAgent) return;
    
    const ua = this.userAgent.toLowerCase();
    
    // Device type
    if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) {
        this.deviceType = 'mobile';
    } else if (ua.includes('tablet') || ua.includes('ipad')) {
        this.deviceType = 'tablet';
    } else if (ua.includes('windows') || ua.includes('mac') || ua.includes('linux')) {
        this.deviceType = 'desktop';
    }
    
    // Browser
    if (ua.includes('chrome')) this.browser = 'Chrome';
    else if (ua.includes('safari')) this.browser = 'Safari';
    else if (ua.includes('firefox')) this.browser = 'Firefox';
    else if (ua.includes('edge')) this.browser = 'Edge';
    
    // OS
    if (ua.includes('android')) this.os = 'Android';
    else if (ua.includes('iphone') || ua.includes('ipad')) this.os = 'iOS';
    else if (ua.includes('windows')) this.os = 'Windows';
    else if (ua.includes('mac')) this.os = 'macOS';
    else if (ua.includes('linux')) this.os = 'Linux';
};

// Static method to find unprocessed hits
LinkHitSchema.statics.findUnprocessed = function(limit = 100) {
    return this.find({ processed: false })
        .sort({ clickedAt: 1 })
        .limit(limit);
};

// Static method to count hits for SMS
LinkHitSchema.statics.countForSms = function(smsLogId) {
    return this.countDocuments({ smsLogId });
};

// Static method to find hits by mobile number
LinkHitSchema.statics.findByMobile = function(mobileNumber, limit = 50) {
    return this.find({ mobileNumber })
        .sort({ clickedAt: -1 })
        .limit(limit);
};

// Static method to get click statistics
LinkHitSchema.statics.getClickStats = async function(installId, startDate, endDate) {
    return this.aggregate([
        {
            $match: {
                installId,
                clickedAt: { $gte: startDate, $lte: endDate }
            }
        },
        {
            $group: {
                _id: {
                    url: '$shortUrl',
                    date: { $dateToString: { format: '%Y-%m-%d', date: '$clickedAt' } }
                },
                clicks: { $sum: 1 },
                uniqueNumbers: { $addToSet: '$mobileNumber' }
            }
        },
        {
            $project: {
                url: '$_id.url',
                date: '$_id.date',
                clicks: 1,
                uniqueClicks: { $size: '$uniqueNumbers' }
            }
        },
        {
            $sort: { date: -1, clicks: -1 }
        }
    ]);
};

// Pre-save middleware to parse user agent
LinkHitSchema.pre('save', function(next) {
    if (this.isNew || this.isModified('userAgent')) {
        this.parseUserAgent();
    }
    next();
});

module.exports = mongoose.model('LinkHit', LinkHitSchema);