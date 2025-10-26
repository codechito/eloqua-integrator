const { parsePhoneNumber, isValidPhoneNumber } = require('libphonenumber-js');

/**
 * Format phone number to E.164 format
 * @param {string} phoneNumber - The phone number to format
 * @param {string} defaultCountry - Default country if not specified in number
 * @returns {string} Formatted phone number in E.164 format
 */
function formatPhoneNumber(phoneNumber, defaultCountry = 'AU') {
    if (!phoneNumber) {
        throw new Error('Phone number is required');
    }

    try {
        // Remove any whitespace and special characters except +
        let cleanNumber = phoneNumber.replace(/[\s\-\(\)\.]/g, '');
        
        // Map country names to ISO codes
        const countryMap = {
            'Australia': 'AU',
            'United States': 'US',
            'United Kingdom': 'GB',
            'New Zealand': 'NZ',
            'Canada': 'CA',
            'Singapore': 'SG',
            'Malaysia': 'MY',
            'Philippines': 'PH',
            'India': 'IN',
            'Hong Kong': 'HK',
            'Thailand': 'TH',
            'Indonesia': 'ID',
            'Vietnam': 'VN'
        };

        const countryCode = countryMap[defaultCountry] || defaultCountry;

        // If number doesn't start with +, try to parse with country code
        if (!cleanNumber.startsWith('+')) {
            // Handle leading zero for some countries
            if (cleanNumber.startsWith('0') && countryCode !== 'US') {
                cleanNumber = cleanNumber.substring(1);
            }
        }

        // Parse and validate
        const phoneNumberObj = parsePhoneNumber(cleanNumber, countryCode);
        
        if (!phoneNumberObj) {
            throw new Error('Unable to parse phone number');
        }

        // Return in E.164 format
        return phoneNumberObj.number;
        
    } catch (error) {
        console.error('Phone formatting error:', error.message);
        throw new Error(`Invalid phone number: ${phoneNumber}. ${error.message}`);
    }
}

/**
 * Validate phone number
 * @param {string} phoneNumber - Phone number to validate
 * @param {string} country - Country code
 * @returns {boolean}
 */
function validatePhoneNumber(phoneNumber, country = 'AU') {
    try {
        const countryMap = {
            'Australia': 'AU',
            'United States': 'US',
            'United Kingdom': 'GB',
            'New Zealand': 'NZ',
            'Canada': 'CA',
            'Singapore': 'SG',
            'Malaysia': 'MY',
            'Philippines': 'PH',
            'India': 'IN',
            'Hong Kong': 'HK',
            'Thailand': 'TH',
            'Indonesia': 'ID',
            'Vietnam': 'VN'
        };

        const countryCode = countryMap[country] || country;
        return isValidPhoneNumber(phoneNumber, countryCode);
    } catch (error) {
        return false;
    }
}

/**
 * Get phone number info
 * @param {string} phoneNumber - Phone number to analyze
 * @param {string} defaultCountry - Default country
 * @returns {object} Phone number information
 */
function getPhoneNumberInfo(phoneNumber, defaultCountry = 'AU') {
    try {
        const formatted = formatPhoneNumber(phoneNumber, defaultCountry);
        const phoneObj = parsePhoneNumber(formatted);
        
        return {
            formatted: phoneObj.number,
            country: phoneObj.country,
            countryCallingCode: phoneObj.countryCallingCode,
            nationalNumber: phoneObj.nationalNumber,
            isValid: phoneObj.isValid(),
            type: phoneObj.getType() || 'UNKNOWN',
            uri: phoneObj.getURI()
        };
    } catch (error) {
        throw new Error(`Cannot get phone number info: ${error.message}`);
    }
}

/**
 * Batch format phone numbers
 * @param {Array} phoneNumbers - Array of phone numbers
 * @param {string} defaultCountry - Default country
 * @returns {Array} Array of formatted numbers with status
 */
function batchFormatPhoneNumbers(phoneNumbers, defaultCountry = 'AU') {
    return phoneNumbers.map(phone => {
        try {
            return {
                original: phone,
                formatted: formatPhoneNumber(phone, defaultCountry),
                valid: true,
                error: null
            };
        } catch (error) {
            return {
                original: phone,
                formatted: null,
                valid: false,
                error: error.message
            };
        }
    });
}

module.exports = {
    formatPhoneNumber,
    validatePhoneNumber,
    getPhoneNumberInfo,
    batchFormatPhoneNumbers
};