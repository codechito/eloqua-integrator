const { parsePhoneNumber, isValidPhoneNumber } = require('libphonenumber-js');

// Country name → ISO 3166-1 alpha-2 region code (case-insensitive keys after normalisation)
const COUNTRY_MAP = {
    'AUSTRALIA': 'AU',
    'AU': 'AU',
    'PHILIPPINES': 'PH',
    'PH': 'PH',
    'UNITED STATES': 'US',
    'USA': 'US',
    'US': 'US',
    'UNITED KINGDOM': 'GB',
    'UK': 'GB',
    'GB': 'GB',
    'NEW ZEALAND': 'NZ',
    'NZ': 'NZ',
    'SINGAPORE': 'SG',
    'SG': 'SG',
    'MALAYSIA': 'MY',
    'MY': 'MY',
    'INDIA': 'IN',
    'IN': 'IN',
    'HONG KONG': 'HK',
    'HK': 'HK',
    'THAILAND': 'TH',
    'TH': 'TH',
    'INDONESIA': 'ID',
    'ID': 'ID',
    'VIETNAM': 'VN',
    'VN': 'VN',
    'CHINA': 'CN',
    'CN': 'CN',
    'JAPAN': 'JP',
    'JP': 'JP',
    'SOUTH KOREA': 'KR',
    'KR': 'KR',
    'CANADA': 'CA',
    'CA': 'CA',
};

function resolveRegionCode(country) {
    if (!country) return null;
    const normalized = country.toUpperCase().trim();
    return COUNTRY_MAP[normalized] || (normalized.length === 2 ? normalized : null);
}

/**
 * Format phone number to E.164 format using libphonenumber-js.
 * Throws if the number cannot be parsed or validated.
 * @param {string} phoneNumber
 * @param {string} [country] - Country name or ISO alpha-2 code. Required when number has no + prefix.
 * @returns {string} E.164 formatted number (e.g. +61412345678)
 */
function formatPhoneNumber(phoneNumber, country) {
    if (!phoneNumber) {
        throw new Error('Phone number is required');
    }

    const cleanNumber = phoneNumber.replace(/[\s\-\(\)\.]/g, '');

    try {
        let phoneNumberObj;

        if (cleanNumber.startsWith('+')) {
            phoneNumberObj = parsePhoneNumber(cleanNumber);
        } else {
            const regionCode = resolveRegionCode(country);
            if (!regionCode) {
                throw new Error('Country is required when phone number has no international prefix');
            }
            phoneNumberObj = parsePhoneNumber(cleanNumber, regionCode);
        }

        if (!phoneNumberObj || !phoneNumberObj.isValid()) {
            throw new Error('Phone number is not valid');
        }

        return phoneNumberObj.number; // E.164 with + prefix
    } catch (error) {
        throw new Error(`Invalid phone number: ${phoneNumber}. ${error.message}`);
    }
}

/**
 * Validate phone number.
 * @param {string} phoneNumber
 * @param {string} [country]
 * @returns {boolean}
 */
function validatePhoneNumber(phoneNumber, country) {
    try {
        const cleanNumber = phoneNumber.replace(/[\s\-\(\)\.]/g, '');
        if (cleanNumber.startsWith('+')) {
            return isValidPhoneNumber(cleanNumber);
        }
        const regionCode = resolveRegionCode(country);
        if (!regionCode) return false;
        return isValidPhoneNumber(cleanNumber, regionCode);
    } catch (error) {
        return false;
    }
}

/**
 * Get phone number info.
 * @param {string} phoneNumber
 * @param {string} [country]
 * @returns {object}
 */
function getPhoneNumberInfo(phoneNumber, country) {
    const formatted = formatPhoneNumber(phoneNumber, country);
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
}

/**
 * Batch format phone numbers.
 * @param {Array} phoneNumbers
 * @param {string} [country]
 * @returns {Array}
 */
function batchFormatPhoneNumbers(phoneNumbers, country) {
    return phoneNumbers.map(phone => {
        try {
            return {
                original: phone,
                formatted: formatPhoneNumber(phone, country),
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
