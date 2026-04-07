require('dotenv').config();
const { listenForNewEmails } = require('./imapClient');

// Validate essential environment variables
const requiredEnv = [
    'IMAP_USER',
    'IMAP_PASS',
    'OPENCLAW_WEBHOOK_URL',
    'OPENCLAW_HOOKS_TOKEN'
];

requiredEnv.forEach(key => {
    if (!process.env[key]) {
        console.error(`❌ CRITICAL ERROR: Environment variable "${key}" is missing.`);
        console.error(`Please check your .env file or server environment.`);
        process.exit(1);
    }
});

console.log('🚀 IMAP Push Service is starting...');
console.log('Mode: Listening for new emails and pushing to OpenClaw.');

// Start listening to the IMAP server via IDLE
listenForNewEmails();
