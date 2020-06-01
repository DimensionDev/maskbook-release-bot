// handler.js
const { serverless } = require('@probot/serverless-lambda')
const appFn = require('./lib/index')
module.exports.probot = serverless(appFn)
