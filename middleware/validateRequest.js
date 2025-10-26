const { logger } = require('../utils');

/**
 * Validate required query parameters
 */
function validateQueryParams(...params) {
    return (req, res, next) => {
        const missing = [];

        for (const param of params) {
            if (!req.query[param]) {
                missing.push(param);
            }
        }

        if (missing.length > 0) {
            logger.warn('Missing query parameters', {
                missing,
                path: req.path,
                providedParams: Object.keys(req.query)
            });

            return res.status(400).json({
                error: 'Missing Parameters',
                message: 'Required query parameters are missing',
                missing: missing,
                required: params
            });
        }

        next();
    };
}

/**
 * Validate required body fields
 */
function validateBodyFields(...fields) {
    return (req, res, next) => {
        const missing = [];

        for (const field of fields) {
            // Check nested fields (e.g., 'user.email')
            const value = field.split('.').reduce((obj, key) => obj?.[key], req.body);
            
            if (value === undefined || value === null || value === '') {
                missing.push(field);
            }
        }

        if (missing.length > 0) {
            logger.warn('Missing body fields', {
                missing,
                path: req.path,
                providedFields: Object.keys(req.body)
            });

            return res.status(400).json({
                error: 'Missing Fields',
                message: 'Required body fields are missing',
                missing: missing,
                required: fields
            });
        }

        next();
    };
}

/**
 * Validate email format
 */
function validateEmail(fieldName = 'email') {
    return (req, res, next) => {
        const email = req.body[fieldName] || req.query[fieldName];

        if (!email) {
            return next(); // Field is optional, continue
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!emailRegex.test(email)) {
            logger.warn('Invalid email format', {
                field: fieldName,
                value: email,
                path: req.path
            });

            return res.status(400).json({
                error: 'Invalid Email',
                message: `${fieldName} must be a valid email address`,
                field: fieldName
            });
        }

        next();
    };
}

/**
 * Validate phone number format
 */
function validatePhoneNumber(fieldName = 'phone') {
    return (req, res, next) => {
        const phone = req.body[fieldName] || req.query[fieldName];

        if (!phone) {
            return next(); // Field is optional, continue
        }

        // Remove common formatting characters
        const cleanPhone = phone.replace(/[\s\-\(\)\.]/g, '');

        // Basic phone validation - starts with + or digit, contains 7-15 digits
        const phoneRegex = /^\+?[1-9]\d{6,14}$/;

        if (!phoneRegex.test(cleanPhone)) {
            logger.warn('Invalid phone number format', {
                field: fieldName,
                value: phone,
                path: req.path
            });

            return res.status(400).json({
                error: 'Invalid Phone Number',
                message: `${fieldName} must be a valid phone number`,
                field: fieldName,
                hint: 'Phone should be in format: +1234567890 or 1234567890'
            });
        }

        next();
    };
}

/**
 * Validate UUID format
 */
function validateUUID(fieldName = 'id') {
    return (req, res, next) => {
        const uuid = req.params[fieldName] || req.query[fieldName] || req.body[fieldName];

        if (!uuid) {
            return next(); // Field is optional, continue
        }

        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        if (!uuidRegex.test(uuid)) {
            logger.warn('Invalid UUID format', {
                field: fieldName,
                value: uuid,
                path: req.path
            });

            return res.status(400).json({
                error: 'Invalid ID Format',
                message: `${fieldName} must be a valid UUID`,
                field: fieldName
            });
        }

        next();
    };
}

/**
 * Validate URL format
 */
function validateURL(fieldName = 'url') {
    return (req, res, next) => {
        const url = req.body[fieldName] || req.query[fieldName];

        if (!url) {
            return next(); // Field is optional, continue
        }

        try {
            new URL(url);
            next();
        } catch (error) {
            logger.warn('Invalid URL format', {
                field: fieldName,
                value: url,
                path: req.path
            });

            return res.status(400).json({
                error: 'Invalid URL',
                message: `${fieldName} must be a valid URL`,
                field: fieldName,
                hint: 'URL should start with http:// or https://'
            });
        }
    };
}

/**
 * Validate number range
 */
function validateNumberRange(fieldName, min, max) {
    return (req, res, next) => {
        const value = req.body[fieldName] || req.query[fieldName];

        if (value === undefined || value === null) {
            return next(); // Field is optional, continue
        }

        const num = Number(value);

        if (isNaN(num)) {
            return res.status(400).json({
                error: 'Invalid Number',
                message: `${fieldName} must be a number`,
                field: fieldName
            });
        }

        if (num < min || num > max) {
            logger.warn('Number out of range', {
                field: fieldName,
                value: num,
                min,
                max,
                path: req.path
            });

            return res.status(400).json({
                error: 'Value Out of Range',
                message: `${fieldName} must be between ${min} and ${max}`,
                field: fieldName,
                value: num,
                min,
                max
            });
        }

        next();
    };
}

/**
 * Validate enum values
 */
function validateEnum(fieldName, allowedValues) {
    return (req, res, next) => {
        const value = req.body[fieldName] || req.query[fieldName];

        if (!value) {
            return next(); // Field is optional, continue
        }

        if (!allowedValues.includes(value)) {
            logger.warn('Invalid enum value', {
                field: fieldName,
                value,
                allowed: allowedValues,
                path: req.path
            });

            return res.status(400).json({
                error: 'Invalid Value',
                message: `${fieldName} must be one of: ${allowedValues.join(', ')}`,
                field: fieldName,
                value,
                allowed: allowedValues
            });
        }

        next();
    };
}

/**
 * Sanitize input to prevent XSS attacks
 */
function sanitizeInput(req, res, next) {
    const sanitize = (obj) => {
        if (typeof obj === 'string') {
            // Remove script tags
            let cleaned = obj.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
            
            // Remove event handlers
            cleaned = cleaned.replace(/on\w+\s*=\s*["'][^"']*["']/gi, '');
            
            // Remove javascript: protocol
            cleaned = cleaned.replace(/javascript:/gi, '');
            
            return cleaned;
        }
        
        if (Array.isArray(obj)) {
            return obj.map(item => sanitize(item));
        }
        
        if (typeof obj === 'object' && obj !== null) {
            const sanitized = {};
            for (const key in obj) {
                sanitized[key] = sanitize(obj[key]);
            }
            return sanitized;
        }
        
        return obj;
    };

    // Sanitize body
    if (req.body) {
        req.body = sanitize(req.body);
    }

    // Sanitize query
    if (req.query) {
        req.query = sanitize(req.query);
    }

    // Sanitize params
    if (req.params) {
        req.params = sanitize(req.params);
    }

    next();
}

/**
 * Validate array length
 */
function validateArrayLength(fieldName, minLength = 0, maxLength = Infinity) {
    return (req, res, next) => {
        const array = req.body[fieldName];

        if (!array) {
            return next(); // Field is optional, continue
        }

        if (!Array.isArray(array)) {
            return res.status(400).json({
                error: 'Invalid Type',
                message: `${fieldName} must be an array`,
                field: fieldName
            });
        }

        if (array.length < minLength || array.length > maxLength) {
            logger.warn('Array length out of range', {
                field: fieldName,
                length: array.length,
                minLength,
                maxLength,
                path: req.path
            });

            return res.status(400).json({
                error: 'Invalid Array Length',
                message: `${fieldName} must contain between ${minLength} and ${maxLength} items`,
                field: fieldName,
                currentLength: array.length,
                minLength,
                maxLength
            });
        }

        next();
    };
}

/**
 * Validate string length
 */
function validateStringLength(fieldName, minLength = 0, maxLength = Infinity) {
    return (req, res, next) => {
        const value = req.body[fieldName] || req.query[fieldName];

        if (!value) {
            return next(); // Field is optional, continue
        }

        if (typeof value !== 'string') {
            return res.status(400).json({
                error: 'Invalid Type',
                message: `${fieldName} must be a string`,
                field: fieldName
            });
        }

        if (value.length < minLength || value.length > maxLength) {
            logger.warn('String length out of range', {
                field: fieldName,
                length: value.length,
                minLength,
                maxLength,
                path: req.path
            });

            return res.status(400).json({
                error: 'Invalid String Length',
                message: `${fieldName} must be between ${minLength} and ${maxLength} characters`,
                field: fieldName,
                currentLength: value.length,
                minLength,
                maxLength
            });
        }

        next();
    };
}

/**
 * Validate content type
 */
function validateContentType(...allowedTypes) {
    return (req, res, next) => {
        const contentType = req.get('content-type');

        if (!contentType) {
            return res.status(400).json({
                error: 'Missing Content-Type',
                message: 'Content-Type header is required',
                allowed: allowedTypes
            });
        }

        const isAllowed = allowedTypes.some(type => 
            contentType.toLowerCase().includes(type.toLowerCase())
        );

        if (!isAllowed) {
            logger.warn('Invalid content type', {
                contentType,
                allowed: allowedTypes,
                path: req.path
            });

            return res.status(415).json({
                error: 'Unsupported Media Type',
                message: 'Content-Type not supported',
                contentType,
                allowed: allowedTypes
            });
        }

        next();
    };
}

/**
 * Validate date format (ISO 8601)
 */
function validateDate(fieldName) {
    return (req, res, next) => {
        const dateString = req.body[fieldName] || req.query[fieldName];

        if (!dateString) {
            return next(); // Field is optional, continue
        }

        const date = new Date(dateString);

        if (isNaN(date.getTime())) {
            logger.warn('Invalid date format', {
                field: fieldName,
                value: dateString,
                path: req.path
            });

            return res.status(400).json({
                error: 'Invalid Date',
                message: `${fieldName} must be a valid ISO 8601 date`,
                field: fieldName,
                hint: 'Format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss.sssZ'
            });
        }

        next();
    };
}

module.exports = {
    validateQueryParams,
    validateBodyFields,
    validateEmail,
    validatePhoneNumber,
    validateUUID,
    validateURL,
    validateNumberRange,
    validateEnum,
    sanitizeInput,
    validateArrayLength,
    validateStringLength,
    validateContentType,
    validateDate
};