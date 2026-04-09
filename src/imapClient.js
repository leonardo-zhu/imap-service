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
        // Periodically break/restart IDLE to reduce stale long-lived connections.
        maxIdleTime: 10 * 60 * 1000,
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
    let heartbeatTimer = null;
    let nextExistsSource = null;
    let heartbeatStopped = false;

    const stopHeartbeat = () => {
        heartbeatStopped = true;
        if (heartbeatTimer) {
            clearTimeout(heartbeatTimer);
            heartbeatTimer = null;
        }
        nextExistsSource = null;
    };

    client.on('error', err => {
        logger.error(`IMAP Error: ${err.message}`, label);
    });

    client.on('close', () => {
        stopHeartbeat();
        clientRegistry.delete(label);
        logger.warn(`IMAP connection closed. Reconnecting in 5 seconds...`, label);
        setTimeout(() => listenForNewEmails(account), 5000);
    });

    try {
        await client.connect();
        heartbeatStopped = false;
        
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
                const source = nextExistsSource || 'realtime';
                nextExistsSource = null;
                const icon = source === 'heartbeat' ? '💓' : '🔔';
                logger.info(`New email arrived! (${count - prevCount} new, source: ${source})`, label, icon);
                await fetchAndPush(client, prevCount + 1, count, label);
            }
            // Always update lastKnownCount in sync with the mailbox state
            lastKnownCount.set(label, count);
        });

        // Heartbeat reconciliation: some servers may miss real-time EXISTS updates.
        const heartbeatLoop = async () => {
            try {
                // If the connection is not usable (e.g., closed), stop scheduling heartbeats to avoid log spam.
                if (heartbeatStopped || !client.usable) {
                    return;
                }

                // Mark the next EXISTS update as heartbeat-sourced.
                // This is time-bounded so we don't mislabel a later realtime EXISTS if no update happens now.
                nextExistsSource = 'heartbeat';
                const clearTagTimer = setTimeout(() => {
                    if (nextExistsSource === 'heartbeat') {
                        nextExistsSource = null;
                    }
                }, 5000);

                try {
                    await client.status('INBOX', { messages: true });
                } finally {
                    clearTimeout(clearTagTimer);
                    if (nextExistsSource === 'heartbeat') {
                        nextExistsSource = null;
                    }
                }
            } catch (err) {
                // "Connection not available" is expected if the socket has been closed; suppress repeated warnings.
                if (err.message !== 'Connection not available') {
                    logger.warn(`Heartbeat status check failed: ${err.message}`, label);
                }
                nextExistsSource = null;
            } finally {
                // Schedule next run only after this one finishes to avoid overlap.
                if (!heartbeatStopped && client.usable) {
                    heartbeatTimer = setTimeout(heartbeatLoop, 60 * 1000);
                }
            }
        };

        heartbeatTimer = setTimeout(heartbeatLoop, 60 * 1000);
    } catch (err) {
        stopHeartbeat();
        logger.error(`Failed to connect: ${err.message}`, label);
        setTimeout(() => listenForNewEmails(account), 5000);
    }
};

module.exports = { listenForNewEmails, markAsRead };
