const phoneFormatter = require('./phoneFormatter');
const helpers = require('./helpers');
const logger = require('./logger');

module.exports = {
    // Phone formatter functions
    formatPhoneNumber: phoneFormatter.formatPhoneNumber,
    validatePhoneNumber: phoneFormatter.validatePhoneNumber,
    getPhoneNumberInfo: phoneFormatter.getPhoneNumberInfo,
    batchFormatPhoneNumbers: phoneFormatter.batchFormatPhoneNumbers,
    
    // Helper functions
    parseFieldPath: helpers.parseFieldPath,
    extractMergeFields: helpers.extractMergeFields,
    replaceMergeFields: helpers.replaceMergeFields,
    calculateSmsSegments: helpers.calculateSmsSegments,
    formatDate: helpers.formatDate,
    hoursBetween: helpers.hoursBetween,
    minutesBetween: helpers.minutesBetween,
    isWithinTimeWindow: helpers.isWithinTimeWindow,
    escapeRegex: helpers.escapeRegex,
    truncate: helpers.truncate,
    generateId: helpers.generateId,
    generateShortId: helpers.generateShortId,
    safeJsonParse: helpers.safeJsonParse,
    deepClone: helpers.deepClone,
    isValidEmail: helpers.isValidEmail,
    sleep: helpers.sleep,
    retry: helpers.retry,
    chunkArray: helpers.chunkArray,
    removeDuplicates: helpers.removeDuplicates,
    urlEncode: helpers.urlEncode,
    buildQueryString: helpers.buildQueryString,
    parseQueryString: helpers.parseQueryString,
    
    // Logger
    logger
};