const auth = require('./auth');
const errorHandler = require('./errorHandler');
const requestLogger = require('./requestLogger');
const validateRequest = require('./validateRequest');
const sessionAuth = require('./sessionAuth');
const handleReauth = require('./handleReauth');

module.exports = {
    // Auth middleware
    verifyInstallation: auth.verifyInstallation,
    verifyOAuthToken: auth.verifyOAuthToken,
    verifyTransmitSmsCredentials: auth.verifyTransmitSmsCredentials,
    verifyWebhookSignature: auth.verifyWebhookSignature,
    rateLimit: auth.rateLimit,
    
    // Session-based auth for AJAX
    sessionAuth,
    
    // Re-authorization handler
    handleReauth,
    
    // Error handling
    errorHandler: errorHandler.errorHandler,
    notFoundHandler: errorHandler.notFoundHandler,
    asyncHandler: errorHandler.asyncHandler,
    formatValidationErrors: errorHandler.formatValidationErrors,
    
    // Request logger
    requestLogger,
    
    // Validation
    validateQueryParams: validateRequest.validateQueryParams,
    validateBodyFields: validateRequest.validateBodyFields,
    validateEmail: validateRequest.validateEmail,
    validatePhoneNumber: validateRequest.validatePhoneNumber,
    sanitizeInput: validateRequest.sanitizeInput
};