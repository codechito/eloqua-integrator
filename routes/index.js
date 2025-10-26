const appRoutes = require('./app');
const actionRoutes = require('./action');
const decisionRoutes = require('./decision');
const feederRoutes = require('./feeder');
const webhookRoutes = require('./webhooks');

module.exports = {
    appRoutes,
    actionRoutes,
    decisionRoutes,
    feederRoutes,
    webhookRoutes
};