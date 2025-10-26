const fs = require('fs');
const path = require('path');
const moment = require('moment');

class Logger {
    constructor() {
        this.logsDir = path.join(__dirname, '..', 'logs');
        this.ensureLogsDirectory();
    }

    ensureLogsDirectory() {
        if (!fs.existsSync(this.logsDir)) {
            fs.mkdirSync(this.logsDir, { recursive: true });
        }
    }

    getLogFileName(type = 'app') {
        const date = moment().format('YYYY-MM-DD');
        return path.join(this.logsDir, `${type}-${date}.log`);
    }

    formatMessage(level, message, meta = {}) {
        const timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
        const metaStr = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
        return `[${timestamp}] [${level.toUpperCase()}] ${message} ${metaStr}\n`;
    }

    writeToFile(filename, message) {
        try {
            fs.appendFileSync(filename, message);
        } catch (error) {
            console.error('Error writing to log file:', error.message);
        }
    }

    log(level, message, meta = {}) {
        const formattedMessage = this.formatMessage(level, message, meta);
        
        // Write to file
        this.writeToFile(this.getLogFileName('app'), formattedMessage);
        
        // Also console log in development
        if (process.env.NODE_ENV !== 'production') {
            const consoleMessage = `${level.toUpperCase()}: ${message}`;
            switch (level) {
                case 'error':
                    console.error(consoleMessage, meta);
                    break;
                case 'warn':
                    console.warn(consoleMessage, meta);
                    break;
                case 'info':
                    console.info(consoleMessage, meta);
                    break;
                default:
                    console.log(consoleMessage, meta);
            }
        }
    }

    info(message, meta = {}) {
        this.log('info', message, meta);
    }

    warn(message, meta = {}) {
        this.log('warn', message, meta);
    }

    error(message, meta = {}) {
        this.log('error', message, meta);
        // Also write to error-specific log
        const formattedMessage = this.formatMessage('error', message, meta);
        this.writeToFile(this.getLogFileName('error'), formattedMessage);
    }

    debug(message, meta = {}) {
        if (process.env.NODE_ENV === 'development') {
            this.log('debug', message, meta);
        }
    }

    // Log SMS activities
    sms(action, data = {}) {
        const message = `SMS ${action}`;
        const formattedMessage = this.formatMessage('sms', message, data);
        this.writeToFile(this.getLogFileName('sms'), formattedMessage);
        
        if (process.env.NODE_ENV === 'development') {
            console.log(`SMS: ${action}`, data);
        }
    }

    // Log API calls
    api(endpoint, method, status, data = {}) {
        const message = `API ${method} ${endpoint} - Status: ${status}`;
        const formattedMessage = this.formatMessage('api', message, data);
        this.writeToFile(this.getLogFileName('api'), formattedMessage);
    }

    // Log webhook activities
    webhook(type, data = {}) {
        const message = `Webhook ${type}`;
        const formattedMessage = this.formatMessage('webhook', message, data);
        this.writeToFile(this.getLogFileName('webhook'), formattedMessage);
        
        if (process.env.NODE_ENV === 'development') {
            console.log(`Webhook: ${type}`, data);
        }
    }
}

// Create singleton instance
const logger = new Logger();

// Export the instance
module.exports = logger;