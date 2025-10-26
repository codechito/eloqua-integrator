module.exports = {
    oauth: {
        clientId: process.env.ELOQUA_CLIENT_ID,
        clientSecret: process.env.ELOQUA_CLIENT_SECRET,
        redirectUri: process.env.ELOQUA_REDIRECT_URI,
        authorizationUrl: 'https://login.eloqua.com/auth/oauth2/authorize',
        tokenUrl: 'https://login.eloqua.com/auth/oauth2/token',
        scope: 'full'
    },
    api: {
        baseUrl: 'https://secure.p{pod}.eloqua.com',
        restVersion: '2.0',
        bulkVersion: '2.0'
    },
    appcloud: {
        serviceName: 'TransmitSMS',
        version: '1.0.0'
    }
};