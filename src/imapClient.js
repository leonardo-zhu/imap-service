const { ImapFlow } = require('imapflow');
const simpleParser = require('mailparser').simpleParser;
const logger = require('./logger');

// Registry of active IMAP clients keyed by account label.
const clientRegistry = new Map();
// Track the last seen message count per account to prevent missing emails during reconnection gaps.
const lastKnownCount = new Map();

const createImapClient = (account) => {
    return new ImapFlow({
        host: account.host,
        port: account.port,
        secure: true,
        auth: {
            user: account.user,
            pass: account.pass,
        },
        logger: false,
        clientInfo: { name: 'OpenClaw IMAP sync' },
    });
};

/**
 * Helper to fetch messages by sequence range and push to OpenClaw.
 */
const fetchAndPush = async (client, fromSeq, toSeq, label) => {
    try {
        for await (let message of client.fetch({ seq: `${fromSeq}:${toSeq}` }, { source: true })) {
            if (message.source) {
                const parsed = await simpleParser(message.source);
                const emailData = {
                    account: label,
                    uid: message.uid,
                    seq: message.seq,
                    subject: parsed.subject,
                    from: parsed.from?.text,
                    date: parsed.date,
                    text: parsed.text,
                };
                
                logger.info(`Pushing email [${emailData.subject}] to OpenClaw...`, label, '🚀');
                
                const response = await fetch(`${process.env.OPENCLAW_WEBHOOK_URL}/mail`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${process.env.OPENCLAW_HOOKS_TOKEN}`,
                    },
                    body: JSON.stringify(emailData),
                });

                if (!response.ok) {
                    try {
                        const errorJson = await response.json();
                        logger.error(`Webhook push failed (Status ${response.status}): ${errorJson.error}`, label);
                    } catch (e) {
                        logger.error(`Webhook push failed (Status ${response.status})`, label);
                    }
                } else {
                    logger.success(`Webhook pushed successfully.`, label);
                }
            }
        }
    } catch (err) {
        logger.error(`Error processing messages ${fromSeq}:${toSeq}: ${err.message}`, label);
    }
};

/**
 * Mark a message as read (\Seen) by its UID.
 */
const markAsRead = async (label, uid) => {
    const client = clientRegistry.get(label);
    if (!client) {
        throw new Error(`No active IMAP connection found for account: ${label}`);
    }
    await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true });
    logger.info(`Marked message UID ${uid} as read.`, label, '📖');
};

const listenForNewEmails = async (account) => {
    const label = account.label ?? account.user;
    const client = createImapClient(account);

    client.on('error', err => {
        logger.error(`IMAP Error: ${err.message}`, label);
    });

    client.on('close', () => {
        clientRegistry.delete(label);
        logger.warn(`IMAP connection closed. Reconnecting in 5 seconds...`, label);
        setTimeout(() => listenForNewEmails(account), 5000);
    });

    try {
        await client.connect();
        
        // Open the mailbox and get current status
        const box = await client.mailboxOpen('INBOX');
        const currentCount = box.exists;

        // Register for mark-as-read operations
        clientRegistry.set(label, client);
        logger.info(`Connected and listening for new emails...`, label, '📬');

        // Check if any messages arrived while we were disconnected (only if we've been connected before)
        if (lastKnownCount.has(label)) {
            const prev = lastKnownCount.get(label);
            if (currentCount > prev) {
                logger.info(`Found ${currentCount - prev} missed emails. Syncing gap ${prev + 1} to ${currentCount}...`, label, '🔄');
                await fetchAndPush(client, prev + 1, currentCount, label);
            }
        }
        
        // Update the known count
        lastKnownCount.set(label, currentCount);

        // Listen for real-time events
        client.on('exists', async data => {
            const { prevCount, count } = data;
            if (count > prevCount) {
                logger.info(`New email arrived! (${count - prevCount} new)`, label, '🔔');
                await fetchAndPush(client, prevCount + 1, count, label);
            }
            // Always update lastKnownCount in sync with the mailbox state
            lastKnownCount.set(label, count);
        });
    } catch (err) {
        logger.error(`Failed to connect: ${err.message}`, label);
        setTimeout(() => listenForNewEmails(account), 5000);
    }
};

module.exports = { listenForNewEmails, markAsRead };
