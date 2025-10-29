module.exports = {
    api: {
        baseUrl: 'https://api.transmitsms.com',
        timeout: 30000,
        headers: {
            'Content-Type': 'application/json'
        }
    },
    sms: {
        maxLength: 612, // 4 messages * 153 characters
        singleMessageLength: 160,
        concatenatedMessageLength: 153,
        defaultValidityPeriod: 24 // hours
    },
    endpoints: {
        sendSms: '/send-sms.json',
        getSmsResponses: '/get-sms-responses.json',
        getNumbers: '/get-numbers.json',
        getDeliveryStatus: '/get-delivery-status.json'
    }
};