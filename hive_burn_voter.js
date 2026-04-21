/**
 * Hive @buildawhale Burn Post Voter
 * ==================================
 * Uses @hiveio/dhive + dotenv (Node.js)
 *
 * What it does:
 *   1. Checks VP before the run — aborts if below MIN_VOTING_POWER
 *   2. Finds today's @buildawhale burn post
 *   3. Re-checks VP before EVERY individual vote — stops immediately if it
 *      drops below threshold mid-run (same logic as rantree-hive/auto_voting_baw)
 *   4. Votes on the burn post + all @buildawhale burn comments on that post
 *
 * Setup:
 *   npm install @hiveio/dhive dotenv node-cron
 *
 * Run modes:
 *   node hive_burn_voter.js              → cron scheduler (23:50 UTC daily)
 *   node hive_burn_voter.js --run-once   → run immediately and exit (GitHub Actions)
 *
 * Credentials:
 *   Local  → create a .env file (see .env.example)
 *   GitHub → set HIVE_USERNAME and HIVE_POSTING_KEY as repo secrets
 */

'use strict';

require('dotenv').config();
const dhive = require('@hiveio/dhive');
const cron  = require('node-cron');

// ─────────────────────────── CONFIG ───────────────────────────────────────────

const CONFIG = {
  username:   process.env.HIVE_USERNAME    || 'your-hive-username',
  postingKey: process.env.HIVE_POSTING_KEY || '5Jxxx...',

  targetAuthor: process.env.TARGET_AUTHOR  || 'buildawhale',

  // VP values stored as 0–10000 on chain (8000 = 80%)
  minVotingPower: parseInt(process.env.MIN_VOTING_POWER  || '8000', 10),
  voteWeight:     parseInt(process.env.VOTE_WEIGHT       || '10000', 10),

  // How far back (in hours) to look for today's burn post
  hoursBack: parseInt(process.env.HOURS_BACK || '24', 10),

  // Delays in ms between votes
  delayBetweenVotes: parseInt(process.env.DELAY_BETWEEN_VOTES || '3000', 10),

  cronSchedule: '50 23 * * *', // every day at 23:50 UTC

  nodes: [
    'https://api.hive.blog',
    'https://api.deathwing.me',
    'https://hive-api.arcange.eu',
    'https://anyx.io',
  ],
};

// ──────────────────────────── CLIENT ──────────────────────────────────────────

const client     = new dhive.Client(CONFIG.nodes);
const postingKey = dhive.PrivateKey.fromString(CONFIG.postingKey);

// ──────────────────────────── HELPERS ─────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Calculate CURRENT voting power (0–10000) for an account object.
 * Hive regenerates VP at 20% per day (1 unit per 1.728 seconds).
 */
function calcCurrentVP(account) {
  const lastVoteMs  = new Date(account.last_vote_time + 'Z').getTime();
  const elapsedSec  = (Date.now() - lastVoteMs) / 1000;
  const regenerated = elapsedSec * (10000 / 432000); // 432000s = 5 days full regen
  return Math.min(10000, account.voting_power + regenerated);
}

/**
 * Fetch fresh account data and return current VP (0–10000).
 * Called before every vote so the check is always up to date.
 */
async function getLiveVP(username) {
  const [account] = await client.database.getAccounts([username]);
  if (!account) throw new Error(`Account @${username} not found.`);
  return { account, vp: calcCurrentVP(account) };
}

/**
 * Find the most recent top-level post by targetAuthor within the last hoursBack hours.
 */
async function findLatestBurnPost() {
  const cutoff = Date.now() - CONFIG.hoursBack * 60 * 60 * 1000;

  const posts = await client.database.getDiscussions('blog', {
    tag:   CONFIG.targetAuthor,
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
 * Fetch all replies on a post authored by targetAuthor.
 */
async function findBurnComments(post) {
  const replies = await client.database.call('get_content_replies', [
    post.author,
    post.permlink,
  ]);
  return replies.filter(r => r.author === CONFIG.targetAuthor);
}

/**
 * Attempt to vote on a single piece of content.
 * Re-checks VP immediately before voting — returns false if VP is too low
 * so the caller can stop the loop.
 */
async function voteOn(content, label) {
  // ── Re-check VP before every single vote ──────────────────────────────────
  const { vp } = await getLiveVP(CONFIG.username);
  const vpPct  = (vp / 100).toFixed(2);

  if (vp < CONFIG.minVotingPower) {
    log(`🛑 VP dropped to ${vpPct}% (min: ${CONFIG.minVotingPower / 100}%) — stopping all votes.`);
    return false; // signal caller to stop
  }

  log(`  ⚡ VP is ${vpPct}% — proceeding to vote on ${label}`);

  // ── Skip if already voted ──────────────────────────────────────────────────
  const alreadyVoted = content.active_votes.some(v => v.voter === CONFIG.username);
  if (alreadyVoted) {
    log(`  ⚠️  Already voted on ${label} — skipping.`);
    return true; // not a stop condition, just skip
  }

  // ── Cast vote ─────────────────────────────────────────────────────────────
  try {
    await client.broadcast.vote(
      {
        voter:    CONFIG.username,
        author:   content.author,
        permlink: content.permlink,
        weight:   CONFIG.voteWeight,
      },
      postingKey
    );
    log(`  ✅  Voted on ${label} (@${content.author}/${content.permlink})`);
  } catch (err) {
    log(`  ❌  Failed to vote on ${label}: ${err.message}`);
  }

  return true; // continue
}

// ──────────────────────────── MAIN JOB ────────────────────────────────────────

async function runJob() {
  log('═══════════════════════════════════════════');
  log('Starting @buildawhale burn post voter job…');

  // 1. Initial VP check — abort early if already below threshold
  const { vp: initialVP } = await getLiveVP(CONFIG.username);
  const initialPct = (initialVP / 100).toFixed(2);
  log(`⚡ Current VP: ${initialPct}% (threshold: ${CONFIG.minVotingPower / 100}%)`);

  if (initialVP < CONFIG.minVotingPower) {
    log(`🛑 VP too low to start. Skipping today's run.`);
    return;
  }

  // 2. Find the burn post
  log(`🔍 Looking for @${CONFIG.targetAuthor}'s latest burn post (last ${CONFIG.hoursBack}h)…`);
  const burnPost = await findLatestBurnPost();

  if (!burnPost) {
    log(`⚠️  No burn post found in the last ${CONFIG.hoursBack} hours.`);
    return;
  }

  log(`📄 Found: "${burnPost.title}" (${burnPost.permlink})`);

  // 3. Vote on the burn post (VP re-checked inside voteOn)
  log('🗳️  Voting on burn post…');
  const fullPost = await client.database.call('get_content', [
    burnPost.author,
    burnPost.permlink,
  ]);

  const continueAfterPost = await voteOn(fullPost, 'burn post');
  if (!continueAfterPost) {
    log('🛑 Stopped after burn post vote due to low VP.');
    return;
  }

  await sleep(CONFIG.delayBetweenVotes);

  // 4. Find and vote on burn comments — stops loop if VP drops mid-run
  log(`💬 Looking for @${CONFIG.targetAuthor} comments on the burn post…`);
  const burnComments = await findBurnComments(burnPost);

  if (burnComments.length === 0) {
    log('  ℹ️  No burn comments found.');
  } else {
    log(`  Found ${burnComments.length} burn comment(s). Voting…`);

    for (const comment of burnComments) {
      const fullComment = await client.database.call('get_content', [
        comment.author,
        comment.permlink,
      ]);

      const shouldContinue = await voteOn(fullComment, 'burn comment');

      if (!shouldContinue) {
        log('🛑 Stopped mid-comments due to VP dropping below threshold.');
        break; // ← key behaviour: stops the loop immediately
      }

      await sleep(CONFIG.delayBetweenVotes);
    }
  }

  log('🎉 Job complete!');
  log('═══════════════════════════════════════════');
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
  log(`🕐 Scheduler started. Cron: "${CONFIG.cronSchedule}" (UTC)`);
  log(`   Account    : @${CONFIG.username}`);
  log(`   Min VP     : ${CONFIG.minVotingPower / 100}%`);
  log(`   Vote weight: ${CONFIG.voteWeight / 100}%`);

  cron.schedule(CONFIG.cronSchedule, () => {
    runJob().catch(err => log(`💥 Unhandled error: ${err.message}`));
  }, { timezone: 'UTC' });
}
