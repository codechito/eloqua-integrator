const moment = require('moment');
const { v4: uuidv4 } = require('uuid');

/**
 * Parse field path (handles both contact and CDO fields)
 * @param {string} fieldPath - Field path string
 * @returns {object} Parsed field information
 */
function parseFieldPath(fieldPath) {
    if (!fieldPath) return null;
    
    const parts = fieldPath.split('__');
    if (parts.length > 1) {
        return {
            type: 'cdo',
            id: parts[0],
            internalName: parts[1]
        };
    }
    
    return {
        type: 'contact',
        internalName: fieldPath
    };
}

/**
 * Extract merge field placeholders from message
 * @param {string} message - Message text with merge fields
 * @returns {Array} Array of merge field objects
 */
function extractMergeFields(message) {
    if (!message) return [];
    
    const fields = [];
    
    // Contact fields: [C_FieldName]
    const contactMatches = message.match(/\[C_([^\]]+)\]/g);
    if (contactMatches) {
        contactMatches.forEach(match => {
            fields.push({
                type: 'contact',
                placeholder: match,
                fieldName: match.replace('[C_', '').replace(']', '')
            });
        });
    }

    // CDO fields: {{CustomObject<123>.Field<456>}}
    const cdoMatches = message.match(/\{\{CustomObject<(\d+)>\.Field<(\d+)>\}\}/g);
    if (cdoMatches) {
        cdoMatches.forEach(match => {
            const cdoMatch = match.match(/CustomObject<(\d+)>\.Field<(\d+)>/);
            if (cdoMatch) {
                fields.push({
                    type: 'cdo',
                    placeholder: match,
                    objectId: cdoMatch[1],
                    fieldId: cdoMatch[2]
                });
            }
        });
    }

    // Tracked link: [tracked-link]
    if (message.includes('[tracked-link]')) {
        fields.push({
            type: 'special',
            placeholder: '[tracked-link]',
            fieldName: 'tracked-link'
        });
    }

    return fields;
}

/**
 * Replace merge fields in message with actual values
 * @param {string} template - Message template
 * @param {object} data - Data object with field values
 * @returns {string} Message with replaced values
 */
function replaceMergeFields(template, data) {
    if (!template || !data) return template;
    
    let message = template;
    
    // Replace contact fields [C_FieldName]
    const contactFields = template.match(/\[C_([^\]]+)\]/g);
    if (contactFields) {
        contactFields.forEach(field => {
            const fieldName = field.replace('[C_', '').replace(']', '');
            const value = data[fieldName] || '';
            message = message.replace(field, value);
        });
    }
    
    // Replace CDO fields (if provided in data)
    const cdoFields = template.match(/\{\{CustomObject<(\d+)>\.Field<(\d+)>\}\}/g);
    if (cdoFields && data.customObjectFields) {
        cdoFields.forEach(field => {
            const match = field.match(/CustomObject<(\d+)>\.Field<(\d+)>/);
            if (match && data.customObjectFields[match[2]]) {
                message = message.replace(field, data.customObjectFields[match[2]]);
            }
        });
    }
    
    return message;
}

/**
 * Calculate message segments for SMS
 * @param {string} message - SMS message
 * @returns {object} Segment information
 */
function calculateSmsSegments(message) {
    if (!message) {
        return { segments: 0, length: 0, remainingChars: 0 };
    }
    
    const length = message.length;
    const singleSmsLength = 160;
    const concatenatedSmsLength = 153;
    
    let segments;
    let remainingChars;
    
    if (length <= singleSmsLength) {
        segments = 1;
        remainingChars = singleSmsLength - length;
    } else {
        segments = Math.ceil(length / concatenatedSmsLength);
        remainingChars = (segments * concatenatedSmsLength) - length;
    }
    
    return {
        segments,
        length,
        remainingChars,
        maxSegments: 4,
        isWithinLimit: segments <= 4
    };
}

/**
 * Format date for display
 * @param {Date|string} date - Date to format
 * @param {string} format - Moment.js format string
 * @returns {string} Formatted date
 */
function formatDate(date, format = 'YYYY-MM-DD HH:mm:ss') {
    if (!date) return '';
    return moment(date).format(format);
}

/**
 * Calculate hours between two dates
 * @param {Date} date1 - Start date
 * @param {Date} date2 - End date
 * @returns {number} Hours between dates
 */
function hoursBetween(date1, date2) {
    if (!date1 || !date2) return 0;
    return moment(date2).diff(moment(date1), 'hours');
}

/**
 * Calculate minutes between two dates
 * @param {Date} date1 - Start date
 * @param {Date} date2 - End date
 * @returns {number} Minutes between dates
 */
function minutesBetween(date1, date2) {
    if (!date1 || !date2) return 0;
    return moment(date2).diff(moment(date1), 'minutes');
}

/**
 * Check if date is within time window
 * @param {Date} date - Date to check
 * @param {number} hours - Time window in hours
 * @returns {boolean}
 */
function isWithinTimeWindow(date, hours) {
    if (!date) return false;
    const cutoff = moment().subtract(hours, 'hours');
    return moment(date).isAfter(cutoff);
}

/**
 * Sanitize string for regex
 * @param {string} string - String to sanitize
 * @returns {string} Sanitized string
 */
function escapeRegex(string) {
    if (!string) return '';
    return string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * Truncate string
 * @param {string} str - String to truncate
 * @param {number} length - Maximum length
 * @returns {string} Truncated string
 */
function truncate(str, length = 50) {
    if (!str) return '';
    return str.length > length ? str.substring(0, length) + '...' : str;
}

/**
 * Generate unique ID
 * @returns {string} UUID v4
 */
function generateId() {
    return uuidv4();
}

/**
 * Generate short ID (first 8 chars of UUID)
 * @returns {string} Short UUID
 */
function generateShortId() {
    return uuidv4().substring(0, 8);
}

/**
 * Safely parse JSON
 * @param {string} jsonString - JSON string
 * @param {*} defaultValue - Default value if parsing fails
 * @returns {*} Parsed object or default value
 */
function safeJsonParse(jsonString, defaultValue = null) {
    try {
        return JSON.parse(jsonString);
    } catch (error) {
        console.error('JSON parse error:', error.message);
        return defaultValue;
    }
}

/**
 * Deep clone object
 * @param {object} obj - Object to clone
 * @returns {object} Cloned object
 */
function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

/**
 * Check if string is valid email
 * @param {string} email - Email to validate
 * @returns {boolean}
 */
function isValidEmail(email) {
    if (!email) return false;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry async function
 * @param {Function} fn - Async function to retry
 * @param {number} retries - Number of retries
 * @param {number} delay - Delay between retries in ms
 * @returns {Promise}
 */
async function retry(fn, retries = 3, delay = 1000) {
    try {
        return await fn();
    } catch (error) {
        if (retries <= 0) throw error;
        await sleep(delay);
        return retry(fn, retries - 1, delay);
    }
}

/**
 * Chunk array into smaller arrays
 * @param {Array} array - Array to chunk
 * @param {number} size - Chunk size
 * @returns {Array} Array of chunks
 */
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

/**
 * Remove duplicates from array
 * @param {Array} array - Array with duplicates
 * @returns {Array} Array without duplicates
 */
function removeDuplicates(array) {
    return [...new Set(array)];
}

/**
 * URL encode special characters
 * @param {string} str - String to encode
 * @returns {string} Encoded string
 */
function urlEncode(str) {
    if (!str) return '';
    return encodeURIComponent(str);
}

/**
 * Build query string from object
 * @param {object} params - Parameters object
 * @returns {string} Query string
 */
function buildQueryString(params) {
    if (!params || Object.keys(params).length === 0) return '';
    
    return Object.keys(params)
        .filter(key => params[key] !== null && params[key] !== undefined)
        .map(key => `${urlEncode(key)}=${urlEncode(params[key])}`)
        .join('&');
}

/**
 * Parse query string to object
 * @param {string} queryString - Query string
 * @returns {object} Parameters object
 */
function parseQueryString(queryString) {
    if (!queryString) return {};
    
    const params = {};
    const pairs = queryString.replace('?', '').split('&');
    
    pairs.forEach(pair => {
        const [key, value] = pair.split('=');
        if (key) {
            params[decodeURIComponent(key)] = decodeURIComponent(value || '');
        }
    });
    
    return params;
}

/**
 * Parse field name from Eloqua format
 * @param {string} fieldValue - Format: "fieldId__fieldName" or "fieldName"
 * @returns {string|null} - Parsed field name
 */
function parseFieldName(fieldValue) {
    if (!fieldValue) return null;
    
    const parts = fieldValue.split('__');
    return parts.length > 1 ? parts[1] : parts[0];
}

module.exports = {
    parseFieldName,
    parseFieldPath,
    extractMergeFields,
    replaceMergeFields,
    calculateSmsSegments,
    formatDate,
    hoursBetween,
    minutesBetween,
    isWithinTimeWindow,
    escapeRegex,
    truncate,
    generateId,
    generateShortId,
    safeJsonParse,
    deepClone,
    isValidEmail,
    sleep,
    retry,
    chunkArray,
    removeDuplicates,
    urlEncode,
    buildQueryString,
    parseQueryString
};