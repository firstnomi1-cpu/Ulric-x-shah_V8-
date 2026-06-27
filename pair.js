/**
 * Ulric-X MD FINAL CLEAN - Multi-User Pairing Manager
 *
 * This file uses the EXACT same Baileys config that worked in the user's
 * single-user index.js (Shah Empire MD). The only change: extended to
 * support multiple users, each with their own session folder.
 *
 * KEY: Minimal Baileys config. No browser override, no markOnlineOnConnect,
 * no generateHighQualityLinkPreview. Just like the working reference.
 *
 * The user reported that this config generated REAL pair codes AND sent
 * REAL push notifications. The only issue was login not completing —
 * which we fix by keeping the socket alive longer (5 min heartbeat).
 */
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const chalk = require('chalk');
const baileys = require('@whiskeysockets/baileys');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = baileys;

const config = require('./config');
const store  = require('./lib/store');
const status = require('./lib/status');

// Active connections: jid -> { sock, status, lastSeen }
const connections = new Map();
// Pending pairing sessions: jid -> { sock, heartbeat, expiresAt }
const pendingPairs = new Map();
// Heartbeat intervals for connected users
const heartbeats = new Map();

/**
 * Generate pair code for a phone number.
 * Uses EXACT same Baileys config as the working single-user reference.
 */
async function generatePairCode(phoneNumber) {
  const clean = String(phoneNumber).replace(/\D/g, '');

  if (clean.length < 7 || clean.length > 15) {
    throw new Error('Invalid phone number length (need 7-15 digits)');
  }
  if (clean.startsWith('0')) {
    throw new Error('Remove leading 0, use country code (e.g. 923xxx)');
  }

  const jid = clean + '@s.whatsapp.net';
  const sessionPath = path.join(config.SESSIONS_DIR, jid);

  // Already paired?
  if (fs.existsSync(path.join(sessionPath, 'creds.json'))) {
    console.log(chalk.blue(`[PAIR] ${jid} already paired, reconnecting...`));
    status.setStatus(jid, 'connected');
    startConnection(jid).catch(e => console.error(e.message));
    throw new Error('Already paired. Reconnecting. Send .menu to your WhatsApp.');
  }

  // Duplicate check
  if (status.isPairingInProgress(jid)) {
    const s = status.getStatus(jid);
    if (s.code) {
      return { code: s.code, jid, expiresAt: s.expiresAt, existing: true };
    }
    throw new Error('Pairing already in progress. Please wait.');
  }

  // Limit check
  if (store.getUsers().length >= config.MAX_PAIR_USERS) {
    throw new Error('Pairing limit reached.');
  }

  status.setStatus(jid, 'connecting');

  try {
    fs.mkdirSync(sessionPath, { recursive: true });

    // ═══════════════════════════════════════════════════════════════
    // EXACT same config as working single-user reference:
    //   - version, logger, auth, printQRInTerminal: false
    //   - connectTimeoutMs: 30000
    //   - defaultQueryTimeoutMs: 30000
    //   - keepAliveIntervalMs: 30000
    // NO browser override, NO markOnlineOnConnect, NO generateHighQualityLinkPreview
    // ═══════════════════════════════════════════════════════════════
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: state,
      printQRInTerminal: false,
      connectTimeoutMs: 30000,
      defaultQueryTimeoutMs: 30000,
      keepAliveIntervalMs: 30000,
    });

    // Heartbeat (same as reference: 60s, sendPresenceUpdate 'available')
    const heartbeat = setInterval(() => {
      try {
        if (sock.ws && sock.ws.readyState === 1) {
          sock.sendPresenceUpdate('available');
        }
      } catch (e) {}
    }, 60000);

    let everConnected = false;
    let pairCode = null;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        everConnected = true;
        connections.set(jid, { sock, status: 'open', lastSeen: Date.now() });
        console.log(chalk.green(`[PAIR] ✅ CONNECTED: ${jid}`));
        status.setStatus(jid, 'connected');

        // Move from pending to permanent
        const pending = pendingPairs.get(jid);
        if (pending) {
          heartbeats.set(jid, pending.heartbeat);
          pendingPairs.delete(jid);
        } else {
          heartbeats.set(jid, heartbeat);
        }

        // Save user
        store.addUser(jid, {
          pairedAt: Date.now(),
          country: getCountryFromNumber(clean)
        });

        // Broadcast notification
        try { await onPair(jid, sock); } catch (e) {}
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(chalk.yellow(`[PAIR] Closed ${jid} (code=${statusCode}). Reconnect: ${shouldReconnect}`));

        try { clearInterval(heartbeat); } catch (e) {}
        const hb = heartbeats.get(jid);
        if (hb) { clearInterval(hb); heartbeats.delete(jid); }

        if (everConnected) {
          // Was connected → auto reconnect
          connections.set(jid, { sock, status: 'reconnecting', lastSeen: Date.now() });
          setTimeout(() => startConnection(jid).catch(e => console.error(e.message)), 5000);
        } else if (!pairCode) {
          // Closed before pair code → fail
          status.setStatus(jid, 'failed', { error: `Connection closed (code ${statusCode})` });
          pendingPairs.delete(jid);
          try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (e) {}
        }
        // If pairCode exists but connection closed → keep session alive
        // (user may still enter code; WhatsApp will retry)
      }
    });

    // Message handler
    const handler = require('./handler');
    sock.ev.on('messages.upsert', async ({ messages }) => {
      try { await handler.onMessage(sock, messages[0]); } catch (e) {}
    });

    sock.ev.on('group-participants.update', async (ev) => {
      try { await handler.onGroupUpdate(sock, ev); } catch (e) {}
    });

    // ═══════════════════════════════════════════════════════════════
    // Wait 5 seconds (same as reference: setTimeout 5000)
    // Then request pair code
    // ═══════════════════════════════════════════════════════════════
    await new Promise(r => setTimeout(r, 5000));

    if (state.creds.registered) {
      throw new Error('Already registered.');
    }

    status.setStatus(jid, 'requesting');

    // Request pair code
    const code = await sock.requestPairingCode(clean);
    const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
    pairCode = formatted;

    console.log(chalk.green(`\n========================================`));
    console.log(chalk.green(`   YOUR PAIRING CODE: ${formatted}`));
    console.log(chalk.green(`   For: ${clean}`));
    console.log(chalk.green(`========================================\n`));

    const expiresAt = Date.now() + 5 * 60 * 1000;
    status.setStatus(jid, 'code_generated', { code: formatted, expiresAt });

    // Keep socket alive for 5 minutes
    pendingPairs.set(jid, { sock, heartbeat, expiresAt });

    // Auto cleanup after 5 min
    setTimeout(() => {
      if (pendingPairs.has(jid) && !connections.has(jid)) {
        console.log(chalk.yellow(`[PAIR] Expired ${jid}`));
        try { clearInterval(heartbeat); } catch (e) {}
        try { sock.end(); } catch (e) {}
        pendingPairs.delete(jid);
        if (!store.isPaired(jid)) {
          status.setStatus(jid, 'expired');
          try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (e) {}
        }
      }
    }, 5 * 60 * 1000);

    return { code: formatted, rawCode: formatted.replace(/-/g, ''), jid, expiresAt };

  } catch (error) {
    console.error(chalk.red(`[PAIR] Error ${jid}: ${error.message}`));
    status.setStatus(jid, 'failed', { error: error.message });
    throw error;
  }
}

/**
 * Start connection for already-paired user (on boot or reconnect).
 * Uses SAME minimal config.
 */
async function startConnection(jid) {
  const sessionPath = path.join(config.SESSIONS_DIR, jid);
  if (!fs.existsSync(path.join(sessionPath, 'creds.json'))) return null;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: state,
      printQRInTerminal: false,
      connectTimeoutMs: 30000,
      defaultQueryTimeoutMs: 30000,
      keepAliveIntervalMs: 30000,
    });

    connections.set(jid, { sock, status: 'connecting', lastSeen: Date.now() });

    const heartbeat = setInterval(() => {
      try {
        if (sock.ws && sock.ws.readyState === 1) {
          sock.sendPresenceUpdate('available');
        }
      } catch (e) {}
    }, 60000);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        connections.set(jid, { sock, status: 'open', lastSeen: Date.now() });
        heartbeats.set(jid, heartbeat);
        console.log(chalk.green(`[CONN] ✅ ${jid}`));
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        const hb = heartbeats.get(jid);
        if (hb) { clearInterval(hb); heartbeats.delete(jid); }

        if (shouldReconnect) {
          connections.set(jid, { sock, status: 'reconnecting', lastSeen: Date.now() });
          setTimeout(() => startConnection(jid).catch(e => console.error(e.message)), 5000);
        } else {
          unpairUser(jid, true);
        }
      }
    });

    const handler = require('./handler');
    sock.ev.on('messages.upsert', async ({ messages }) => {
      try { await handler.onMessage(sock, messages[0]); } catch (e) {}
    });

    sock.ev.on('group-participants.update', async (ev) => {
      try { await handler.onGroupUpdate(sock, ev); } catch (e) {}
    });

    return sock;
  } catch (e) {
    console.error(chalk.red(`[CONN] Failed ${jid}: ${e.message}`));
    return null;
  }
}

async function onPair(jid, sock) {
  if (!config.BCAST_ON_PAIR) return;
  const text = config.BCAST_TEXT_ON_PAIR(jid);
  try { await sock.sendMessage(config.BOT_OWNER_JID, { text }); } catch (e) {}
  try {
    const ownerConn = connections.get(config.BOT_OWNER_JID);
    const ownerSock = ownerConn?.sock || sock;
    const groups = await ownerSock.groupFetchAllWhitelist?.().catch(() => []) || [];
    for (const g of groups.slice(0, 5)) {
      try { await ownerSock.sendMessage(g.id, { text }); } catch (e) {}
    }
  } catch (e) {}
}

function unpairUser(jid, deleteSession = true) {
  const conn = connections.get(jid);
  if (conn?.sock) { try { conn.sock.end(); } catch (e) {} }
  const pending = pendingPairs.get(jid);
  if (pending) { try { clearInterval(pending.heartbeat); } catch (e) {} try { pending.sock.end(); } catch (e) {} pendingPairs.delete(jid); }
  const hb = heartbeats.get(jid);
  if (hb) { clearInterval(hb); heartbeats.delete(jid); }

  connections.delete(jid);
  status.clearStatus(jid);
  store.removeUser(jid);

  if (deleteSession) {
    try { fs.rmSync(path.join(config.SESSIONS_DIR, jid), { recursive: true, force: true }); } catch (e) {}
  }
  return true;
}

async function autoLoadAllPaired(onProgress) {
  const entries = fs.existsSync(config.SESSIONS_DIR)
    ? fs.readdirSync(config.SESSIONS_DIR, { withFileTypes: true })
    : [];
  const dirs = entries
    .filter(d => d.isDirectory() && d.name.endsWith('@s.whatsapp.net'))
    .map(d => d.name)
    .filter(jid => fs.existsSync(path.join(config.SESSIONS_DIR, jid, 'creds.json')));

  console.log(chalk.cyan(`[AUTOLOAD] ${dirs.length} session(s)`));

  for (let i = 0; i < dirs.length; i++) {
    const jid = dirs[i];
    try {
      console.log(chalk.blue(`[AUTOLOAD] ${i+1}/${dirs.length} ${jid}`));
      await startConnection(jid);
      if (onProgress) onProgress(i + 1, dirs.length, jid);
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.error(chalk.red(`[AUTOLOAD] Failed ${jid}: ${e.message}`));
    }
  }
  console.log(chalk.green(`[AUTOLOAD] Done. ${connections.size} active.`));
}

async function broadcastAll(text) {
  const targets = [];
  for (const [jid, info] of connections.entries()) {
    if (info.status !== 'open') continue;
    try {
      await info.sock.sendMessage(jid, { text });
      targets.push(jid);
    } catch (e) {}
  }
  return targets;
}

async function broadcastOwnerGroups(text) {
  const ownerConn = connections.get(config.BOT_OWNER_JID);
  if (!ownerConn || ownerConn.status !== 'open') return [];
  const targets = [];
  const groups = await ownerConn.sock.groupFetchAllWhitelist?.().catch(() => []) || [];
  for (const g of groups) {
    try { await ownerConn.sock.sendMessage(g.id, { text }); targets.push(g.id); } catch (e) {}
  }
  return targets;
}

function getCountryFromNumber(num) {
  const { getCountry } = require('./lib/utils');
  return getCountry(num);
}

function getConnection(jid) { return connections.get(jid); }
function getAllConnections() { return Array.from(connections.values()); }

function gracefulShutdown() {
  console.log(chalk.yellow('[SHUTDOWN] Closing all...'));
  for (const [jid, info] of connections.entries()) {
    try { info.sock.end(); } catch (e) {}
  }
  for (const [jid, p] of pendingPairs.entries()) {
    try { clearInterval(p.heartbeat); } catch (e) {}
    try { p.sock.end(); } catch (e) {}
  }
  for (const [jid, hb] of heartbeats.entries()) {
    try { clearInterval(hb); } catch (e) {}
  }
}

process.on('SIGINT', () => { gracefulShutdown(); process.exit(0); });
process.on('SIGTERM', () => { gracefulShutdown(); process.exit(0); });

module.exports = {
  generatePairCode,
  startConnection,
  unpairUser,
  getConnection,
  getAllConnections,
  autoLoadAllPaired,
  broadcastAll,
  broadcastOwnerGroups
};
