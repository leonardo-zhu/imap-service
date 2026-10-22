const { ImapFlow } = require('imapflow');
const simpleParser = require('mailparser').simpleParser;
const logger = require('./logger');

// Registry of active IMAP clients keyed by account label and user email.
const clientRegistry = new Map();
// Track the last seen message count per account to prevent missing emails during reconnection gaps.
const lastKnownCount = new Map();
// Current reconnect delay per account; doubles on consecutive failures and resets after a successful connect.
const reconnectDelay = new Map();
// Recently pushed messages per account ("uidValidity:uid"), so a duplicate connection or gap sync never pushes the same mail twice.
const pushedMessages = new Map();

const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;
const MAX_TRACKED_MESSAGES = 5000;

/**
 * Claim a message for pushing. Returns a key, or null if it was already pushed.
 */
const claimMessage = (label, client, uid) => {
    const key = `${client.mailbox?.uidValidity ?? ''}:${uid}`;
    let seen = pushedMessages.get(label);
    if (!seen) {
        seen = new Set();
        pushedMessages.set(label, seen);
    }
    if (seen.has(key)) return null;
    seen.add(key);
    if (seen.size > MAX_TRACKED_MESSAGES) {
        seen.delete(seen.values().next().value);
    }
    return key;
};

const releaseMessage = (label, key) => {
    pushedMessages.get(label)?.delete(key);
};

/**
 * Get active IMAP client by account label or user email (case-insensitive).
 */
const getImapClient = (accountKey) => {
    if (!accountKey) return null;
    if (clientRegistry.has(accountKey)) return clientRegistry.get(accountKey);
    const lowerKey = accountKey.toLowerCase();
    if (clientRegistry.has(lowerKey)) return clientRegistry.get(lowerKey);
    return null;
};

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
                const claimKey = claimMessage(label, client, message.uid);
                if (!claimKey) {
                    logger.warn(`Skipping UID ${message.uid}: already pushed.`, label);
                    continue;
                }
                try {
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
                        releaseMessage(label, claimKey);
                        try {
                            const errorJson = await response.json();
                            logger.error(`Webhook push failed (Status ${response.status}): ${errorJson.error}`, label);
                        } catch (e) {
                            logger.error(`Webhook push failed (Status ${response.status})`, label);
                        }
                    } else {
                        logger.success(`Webhook pushed successfully.`, label);
                    }
                } catch (err) {
                    releaseMessage(label, claimKey);
                    throw err;
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
const markAsRead = async (accountKey, uid) => {
    const client = getImapClient(accountKey);
    if (!client) {
        throw new Error(`No active IMAP connection found for account: ${accountKey}`);
    }
    await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true });
    logger.info(`Marked message UID ${uid} as read.`, accountKey, '📖');
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

    // Each attempt schedules exactly one successor. A failed connect() makes imapflow emit 'close' as well as
    // reject, so both paths funnel through here; otherwise every failure would fork another reconnect chain.
    let reconnectScheduled = false;
    const scheduleReconnect = () => {
        if (reconnectScheduled) return;
        reconnectScheduled = true;
        const delay = reconnectDelay.get(label) ?? RECONNECT_BASE_MS;
        reconnectDelay.set(label, Math.min(delay * 2, RECONNECT_MAX_MS));
        logger.warn(`Reconnecting in ${Math.round(delay / 1000)} seconds...`, label);
        setTimeout(() => listenForNewEmails(account), delay);
    };

    // Only drop registry entries that still point at this client, so a stale close never unregisters its replacement.
    const unregisterClient = key => {
        if (!key) return;
        for (const k of [key, key.toLowerCase()]) {
            if (clientRegistry.get(k) === client) clientRegistry.delete(k);
        }
    };

    client.on('error', err => {
        logger.error(`IMAP Error: ${err.message}`, label);
    });

    client.on('close', () => {
        stopHeartbeat();
        unregisterClient(label);
        unregisterClient(account.user);
        logger.warn(`IMAP connection closed.`, label);
        scheduleReconnect();
    });

    try {
        await client.connect();
        heartbeatStopped = false;

        // Open the mailbox and get current status
        const box = await client.mailboxOpen('INBOX');
        const currentCount = box.exists;
        reconnectDelay.delete(label);

        // Register for mark-as-read operations
        if (label) {
            clientRegistry.set(label, client);
            clientRegistry.set(label.toLowerCase(), client);
        }
        if (account.user) {
            clientRegistry.set(account.user, client);
            clientRegistry.set(account.user.toLowerCase(), client);
        }
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
        // Make sure a half-open connection (e.g. connected but mailboxOpen failed) doesn't linger next to the retry.
        client.close();
        scheduleReconnect();
    }
};

module.exports = { listenForNewEmails, markAsRead };
