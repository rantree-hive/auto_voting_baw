/**
 * Hive @buildawhale Burn Post Voter
 * ==================================
 * Uses @hiveio/dhive + dotenv (Node.js)
 *
 * Supports unlimited accounts configured via .env or GitHub Secrets.
 * Each account can independently vote on:
 *   - The burn post + burn comments  (ACCOUNT_N_VOTE_POST=true)
 *   - Burn comments only             (ACCOUNT_N_VOTE_POST=false)
 *
 * Both modes:
 *   - Check VP before the run — skip account if below MIN_VOTING_POWER
 *   - Re-check VP before EVERY individual vote — stop immediately if it drops
 *
 * Setup:
 *   npm install @hiveio/dhive dotenv node-cron
 *
 * Run modes:
 *   node hive_burn_voter.js              → cron scheduler (23:50 UTC daily)
 *   node hive_burn_voter.js --run-once   → run immediately and exit (GitHub Actions)
 *
 * Adding accounts:
 *   In .env or GitHub Secrets, add numbered sets:
 *     ACCOUNT_1_USERNAME, ACCOUNT_1_POSTING_KEY, ACCOUNT_1_VOTE_POST
 *     ACCOUNT_2_USERNAME, ACCOUNT_2_POSTING_KEY, ACCOUNT_2_VOTE_POST
 *     ACCOUNT_3_USERNAME, ACCOUNT_3_POSTING_KEY, ACCOUNT_3_VOTE_POST
 *     ... and so on
 */

'use strict';

require('dotenv').config();
const dhive = require('@hiveio/dhive');
const cron  = require('node-cron');

// ─────────────────────────── GLOBAL CONFIG ────────────────────────────────────

const TARGET_AUTHOR          = process.env.TARGET_AUTHOR           || 'buildawhale';
const MIN_VOTING_POWER       = parseInt(process.env.MIN_VOTING_POWER       || '8000', 10); // 8000 = 80%
const VOTE_WEIGHT            = parseInt(process.env.VOTE_WEIGHT            || '10000', 10);
const HOURS_BACK             = parseInt(process.env.HOURS_BACK             || '24', 10);
const DELAY_BETWEEN_VOTES    = parseInt(process.env.DELAY_BETWEEN_VOTES    || '3000', 10);
const DELAY_BETWEEN_ACCOUNTS = parseInt(process.env.DELAY_BETWEEN_ACCOUNTS || '5000', 10);

const CRON_SCHEDULE = '50 23 * * *'; // every day at 23:50 UTC

const NODES = [
  'https://api.hive.blog',
  'https://api.deathwing.me',
  'https://hive-api.arcange.eu',
  'https://anyx.io',
];

// ──────────────────────── LOAD ACCOUNTS DYNAMICALLY ──────────────────────────
// Reads ACCOUNT_1_*, ACCOUNT_2_*, ACCOUNT_3_* ... from env until it finds
// a gap. Stops at the first missing USERNAME.

function loadAccounts() {
  const accounts = [];
  let i = 1;

  while (true) {
    const username   = process.env[`ACCOUNT_${i}_USERNAME`];
    const postingKey = process.env[`ACCOUNT_${i}_POSTING_KEY`];

    // Stop when we hit a gap
    if (!username || !postingKey) break;

    // ACCOUNT_N_VOTE_POST defaults to true if not set
    const votePost = (process.env[`ACCOUNT_${i}_VOTE_POST`] || 'true').toLowerCase() !== 'false';

    accounts.push({
      index:      i,
      label:      `Account ${i}`,
      username,
      postingKey,
      votePost,   // true = votes on post + comments / false = comments only
    });

    i++;
  }

  return accounts;
}

// ──────────────────────────── CLIENT ──────────────────────────────────────────

const client = new dhive.Client(NODES);

// ──────────────────────────── HELPERS ─────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Calculate current VP (0–10000) from raw account data.
 * Hive regenerates VP at 20% per day (1 unit per 1.728 seconds).
 */
function calcCurrentVP(account) {
  const lastVoteMs  = new Date(account.last_vote_time + 'Z').getTime();
  const elapsedSec  = (Date.now() - lastVoteMs) / 1000;
  const regenerated = elapsedSec * (10000 / 432000); // 432000s = 5 days full regen
  return Math.min(10000, account.voting_power + regenerated);
}

/**
 * Fetch live VP (0–10000) for a username directly from the chain.
 */
async function getLiveVP(username) {
  const [account] = await client.database.getAccounts([username]);
  if (!account) throw new Error(`Account @${username} not found.`);
  return { account, vp: calcCurrentVP(account) };
}

/**
 * Find the most recent top-level burn post by TARGET_AUTHOR
 * published within the last HOURS_BACK hours.
 */
async function findLatestBurnPost() {
  const cutoff = Date.now() - HOURS_BACK * 60 * 60 * 1000;

  const posts = await client.database.getDiscussions('blog', {
    tag:   TARGET_AUTHOR,
    limit: 10,
  });

  for (const post of posts) {
    if (post.parent_author !== '') continue; // skip comments
    const postMs = new Date(post.created + 'Z').getTime();
    if (postMs >= cutoff) return post;
  }

  return null;
}

/**
 * Fetch all replies on a post authored by TARGET_AUTHOR.
 */
async function findBurnComments(post) {
  const replies = await client.database.call('get_content_replies', [
    post.author,
    post.permlink,
  ]);
  return replies.filter(r => r.author === TARGET_AUTHOR);
}

/**
 * Cast a single vote for a given account.
 * Re-checks VP before every vote.
 * Returns false if VP is too low — caller should stop the loop.
 */
async function voteOn(acc, content, label) {
  // Re-check VP live before every vote
  const { vp } = await getLiveVP(acc.username);
  const vpPct  = (vp / 100).toFixed(2);

  if (vp < MIN_VOTING_POWER) {
    log(`  🛑 [${acc.label}] VP dropped to ${vpPct}% (min: ${MIN_VOTING_POWER / 100}%) — stopping.`);
    return false;
  }

  log(`  ⚡ [${acc.label}] VP ${vpPct}% — voting on ${label}`);

  // Skip if already voted
  const alreadyVoted = content.active_votes.some(v => v.voter === acc.username);
  if (alreadyVoted) {
    log(`  ⚠️  [${acc.label}] Already voted on ${label} — skipping.`);
    return true;
  }

  // Cast the vote
  try {
    const key = dhive.PrivateKey.fromString(acc.postingKey);
    await client.broadcast.vote(
      {
        voter:    acc.username,
        author:   content.author,
        permlink: content.permlink,
        weight:   VOTE_WEIGHT,
      },
      key
    );
    log(`  ✅  [${acc.label}] Voted on ${label} (@${content.author}/${content.permlink})`);
  } catch (err) {
    log(`  ❌  [${acc.label}] Failed to vote on ${label}: ${err.message}`);
  }

  return true;
}

/**
 * Run the full voting routine for a single account.
 * burnPost and burnComments are fetched once and passed in.
 */
async function runForAccount(acc, burnPost, burnComments) {
  log(`─────────────────────────────────────────`);
  log(`👤 [${acc.label}] @${acc.username} | mode: ${acc.votePost ? 'post + comments' : 'comments only'}`);

  // Initial VP check for this account
  const { vp: initialVP } = await getLiveVP(acc.username);
  const initialPct = (initialVP / 100).toFixed(2);
  log(`  ⚡ VP: ${initialPct}% (threshold: ${MIN_VOTING_POWER / 100}%)`);

  if (initialVP < MIN_VOTING_POWER) {
    log(`  🛑 VP too low — skipping this account.`);
    return;
  }

  // ── Vote on main burn post (only if ACCOUNT_N_VOTE_POST=true) ─────────────
  if (acc.votePost) {
    log(`  🗳️  Voting on burn post…`);
    const fullPost = await client.database.call('get_content', [
      burnPost.author,
      burnPost.permlink,
    ]);

    const continueAfterPost = await voteOn(acc, fullPost, 'burn post');
    if (!continueAfterPost) return;

    await sleep(DELAY_BETWEEN_VOTES);
  } else {
    log(`  ℹ️  Skipping main post (comments only mode).`);
  }

  // ── Vote on burn comments ─────────────────────────────────────────────────
  if (burnComments.length === 0) {
    log(`  ℹ️  No burn comments to vote on.`);
    return;
  }

  log(`  💬 Voting on ${burnComments.length} burn comment(s)…`);

  for (const comment of burnComments) {
    const fullComment = await client.database.call('get_content', [
      comment.author,
      comment.permlink,
    ]);

    const shouldContinue = await voteOn(acc, fullComment, 'burn comment');
    if (!shouldContinue) {
      log(`  🛑 [${acc.label}] Stopped mid-comments due to low VP.`);
      break;
    }

    await sleep(DELAY_BETWEEN_VOTES);
  }

  log(`  🎉 [${acc.label}] Done.`);
}

// ──────────────────────────── MAIN JOB ────────────────────────────────────────

async function runJob() {
  log('═══════════════════════════════════════════');
  log('Starting @buildawhale burn post voter job…');

  // Load accounts dynamically from env
  const accounts = loadAccounts();

  if (accounts.length === 0) {
    log('❌ No accounts configured. Add ACCOUNT_1_USERNAME and ACCOUNT_1_POSTING_KEY to your .env or GitHub Secrets.');
    return;
  }

  log(`📋 Accounts loaded: ${accounts.length}`);
  accounts.forEach(a => {
    log(`   • ${a.label}: @${a.username} [${a.votePost ? 'post + comments' : 'comments only'}]`);
  });

  // Fetch burn post and comments once — shared across all accounts
  log(`🔍 Looking for @${TARGET_AUTHOR}'s latest burn post (last ${HOURS_BACK}h)…`);
  const burnPost = await findLatestBurnPost();

  if (!burnPost) {
    log(`⚠️  No burn post found in the last ${HOURS_BACK} hours.`);
    return;
  }

  log(`📄 Found: "${burnPost.title}" (${burnPost.permlink})`);

  log(`💬 Fetching @${TARGET_AUTHOR} burn comments…`);
  const burnComments = await findBurnComments(burnPost);
  log(`   Found ${burnComments.length} burn comment(s).`);

  // Process each account sequentially
  for (let i = 0; i < accounts.length; i++) {
    await runForAccount(accounts[i], burnPost, burnComments);

    // Delay between accounts (skip after the last one)
    if (i < accounts.length - 1) {
      log(`⏳ Waiting ${DELAY_BETWEEN_ACCOUNTS}ms before next account…`);
      await sleep(DELAY_BETWEEN_ACCOUNTS);
    }
  }

  log('═══════════════════════════════════════════');
  log(`✅ All ${accounts.length} account(s) processed.`);
}

// ──────────────────────────── ENTRYPOINT ──────────────────────────────────────

const runOnce = process.argv.includes('--run-once');

if (runOnce) {
  log('▶️  --run-once mode (GitHub Actions)');
  runJob()
    .then(() => process.exit(0))
    .catch(err => {
      log(`💥 Fatal error: ${err.message}`);
      process.exit(1);
    });
} else {
  log(`🕐 Scheduler started. Cron: "${CRON_SCHEDULE}" (UTC)`);
  log(`   Target       : @${TARGET_AUTHOR}`);
  log(`   Min VP       : ${MIN_VOTING_POWER / 100}%`);
  log(`   Vote weight  : ${VOTE_WEIGHT / 100}%`);

  cron.schedule(CRON_SCHEDULE, () => {
    runJob().catch(err => log(`💥 Unhandled error: ${err.message}`));
  }, { timezone: 'UTC' });
}
