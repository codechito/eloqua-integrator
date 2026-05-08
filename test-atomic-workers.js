require('dotenv').config();
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const SmsJob = require('./models/SmsJob');
const SmsLog = require('./models/SmsLog');

// ─── helpers ────────────────────────────────────────────────────────────────

function pass(label) { console.log(`  PASS  ${label}`); }
function fail(label, detail) { console.error(`  FAIL  ${label}${detail ? ': ' + detail : ''}`); process.exitCode = 1; }
function section(title) { console.log(`\n${'─'.repeat(55)}\n  ${title}\n${'─'.repeat(55)}`); }

// Simulates one worker instance atomically claiming up to `limit` pending jobs
// — the same logic used in smsWorker.processPendingJobs()
async function claimSmsJobs(limit, installId) {
    const claimed = [];
    for (let i = 0; i < limit; i++) {
        const job = await SmsJob.findOneAndUpdate(
            { installId, status: 'pending', scheduledAt: { $lte: new Date() } },
            { $set: { status: 'processing', processingStartedAt: new Date() } },
            { new: true, sort: { scheduledAt: 1 } }
        );
        if (!job) break;
        claimed.push(job.jobId);
    }
    return claimed;
}

// Simulates one worker instance atomically claiming up to `limit` expired decision logs
// — the same logic used in decisionCleanupWorker.processExpiredDecisions()
async function claimDecisionLogs(limit, installId) {
    const now = new Date();
    const claimed = [];
    for (let i = 0; i < limit; i++) {
        const log = await SmsLog.findOneAndUpdate(
            {
                installId,
                decisionStatus: 'pending',
                decisionDeadline: { $lt: now },
                decisionInstanceId: { $ne: null, $exists: true }
            },
            { $set: { decisionStatus: 'processing' } },
            { new: true, sort: { decisionDeadline: 1 } }
        );
        if (!log) break;
        claimed.push(log._id.toString());
    }
    return claimed;
}

// ─── test helpers ────────────────────────────────────────────────────────────

async function createPendingSmsJobs(count, installId) {
    const jobs = [];
    for (let i = 0; i < count; i++) {
        jobs.push({
            jobId: uuidv4(),
            installId,
            instanceId: 'inst-' + installId,
            executionId: 'exec-' + installId,
            contactId: 'contact-' + i,
            mobileNumber: '+61400000000',
            message: 'Test message ' + i,
            status: 'pending',
            scheduledAt: new Date(Date.now() - 1000)
        });
    }
    await SmsJob.insertMany(jobs);
    return jobs.map(j => j.jobId);
}

async function createExpiredDecisionLogs(count, installId) {
    const logs = [];
    for (let i = 0; i < count; i++) {
        logs.push({
            installId,
            instanceId: 'inst-' + installId,
            contactId: 'contact-' + i,
            mobileNumber: '+61400000000',
            message: 'Test message ' + i,
            status: 'sent',
            decisionInstanceId: 'decision-inst-' + installId,
            decisionStatus: 'pending',
            decisionDeadline: new Date(Date.now() - 60000) // 1 minute ago (expired)
        });
    }
    await SmsLog.insertMany(logs);
    return logs.map(l => l.contactId);
}

async function cleanup(installId) {
    await SmsJob.deleteMany({ installId });
    await SmsLog.deleteMany({ installId });
}

// ─── tests ───────────────────────────────────────────────────────────────────

async function testSmsJobAtomicClaiming() {
    section('SmsJob: Atomic claiming (no duplicates across 2 instances)');

    const installId = 'test-atomic-' + uuidv4().slice(0, 8);
    const JOB_COUNT = 8;

    await createPendingSmsJobs(JOB_COUNT, installId);

    // Simulate two instances claiming jobs concurrently
    const [instance1, instance2] = await Promise.all([
        claimSmsJobs(JOB_COUNT, installId),
        claimSmsJobs(JOB_COUNT, installId)
    ]);

    const totalClaimed = instance1.length + instance2.length;
    const duplicates = instance1.filter(id => instance2.includes(id));

    console.log(`  Instance 1 claimed: ${instance1.length} jobs`);
    console.log(`  Instance 2 claimed: ${instance2.length} jobs`);
    console.log(`  Total claimed: ${totalClaimed} / ${JOB_COUNT}`);
    console.log(`  Duplicates: ${duplicates.length}`);

    if (duplicates.length === 0) {
        pass('No job claimed by both instances');
    } else {
        fail('No job claimed by both instances', `${duplicates.length} duplicate(s): ${duplicates.join(', ')}`);
    }

    if (totalClaimed === JOB_COUNT) {
        pass(`All ${JOB_COUNT} jobs claimed exactly once`);
    } else {
        fail(`All ${JOB_COUNT} jobs claimed exactly once`, `got ${totalClaimed}`);
    }

    await cleanup(installId);
}

async function testSmsJobStaleRecovery() {
    section('SmsJob: Stale job recovery (stuck processing → back to pending)');

    const installId = 'test-stale-' + uuidv4().slice(0, 8);

    // Create a job that has been 'processing' for 6 minutes (beyond 5-min threshold)
    const staleJob = await SmsJob.create({
        jobId: uuidv4(),
        installId,
        instanceId: 'inst-' + installId,
        executionId: 'exec-' + installId,
        contactId: 'contact-stale',
        mobileNumber: '+61400000000',
        message: 'Stale job',
        status: 'processing',
        processingStartedAt: new Date(Date.now() - 6 * 60 * 1000)
    });

    // Create a recent 'processing' job (within threshold — should NOT be reset)
    const recentJob = await SmsJob.create({
        jobId: uuidv4(),
        installId,
        instanceId: 'inst-' + installId,
        executionId: 'exec-' + installId,
        contactId: 'contact-recent',
        mobileNumber: '+61400000000',
        message: 'Recent job',
        status: 'processing',
        processingStartedAt: new Date(Date.now() - 60 * 1000) // 1 minute ago
    });

    // Run stale recovery (same logic as smsWorker.recoverStaleJobs)
    const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
    const result = await SmsJob.updateMany(
        { status: 'processing', processingStartedAt: { $lt: staleThreshold } },
        { $set: { status: 'pending' } }
    );

    console.log(`  Recovered: ${result.modifiedCount} job(s)`);

    const recoveredJob = await SmsJob.findOne({ jobId: staleJob.jobId });
    const untouchedJob = await SmsJob.findOne({ jobId: recentJob.jobId });

    if (recoveredJob.status === 'pending') {
        pass('Stale job reset to pending');
    } else {
        fail('Stale job reset to pending', `status is still '${recoveredJob.status}'`);
    }

    if (untouchedJob.status === 'processing') {
        pass('Recent processing job not touched');
    } else {
        fail('Recent processing job not touched', `status changed to '${untouchedJob.status}'`);
    }

    await cleanup(installId);
}

async function testDecisionLogAtomicClaiming() {
    section('SmsLog: Atomic decision claiming (no duplicates across 2 instances)');

    const installId = 'test-dec-atomic-' + uuidv4().slice(0, 8);
    const LOG_COUNT = 6;

    await createExpiredDecisionLogs(LOG_COUNT, installId);

    // Simulate two instances claiming expired logs concurrently
    const [instance1, instance2] = await Promise.all([
        claimDecisionLogs(LOG_COUNT, installId),
        claimDecisionLogs(LOG_COUNT, installId)
    ]);

    const totalClaimed = instance1.length + instance2.length;
    const duplicates = instance1.filter(id => instance2.includes(id));

    console.log(`  Instance 1 claimed: ${instance1.length} logs`);
    console.log(`  Instance 2 claimed: ${instance2.length} logs`);
    console.log(`  Total claimed: ${totalClaimed} / ${LOG_COUNT}`);
    console.log(`  Duplicates: ${duplicates.length}`);

    if (duplicates.length === 0) {
        pass('No log claimed by both instances');
    } else {
        fail('No log claimed by both instances', `${duplicates.length} duplicate(s)`);
    }

    if (totalClaimed === LOG_COUNT) {
        pass(`All ${LOG_COUNT} logs claimed exactly once`);
    } else {
        fail(`All ${LOG_COUNT} logs claimed exactly once`, `got ${totalClaimed}`);
    }

    await cleanup(installId);
}

async function testDecisionLogStaleRecovery() {
    section('SmsLog: Stale decision recovery (stuck processing → back to pending)');

    const installId = 'test-dec-stale-' + uuidv4().slice(0, 8);

    const now = new Date();

    // Use raw collection inserts to bypass Mongoose's automatic updatedAt — otherwise
    // Mongoose overwrites updatedAt with the current time on create, breaking the test.

    // Stale: processing for 6 minutes
    const staleResult = await SmsLog.collection.insertOne({
        installId,
        contactId: 'contact-stale',
        mobileNumber: '+61400000000',
        message: 'Stale log',
        status: 'sent',
        decisionInstanceId: 'decision-inst-stale',
        decisionStatus: 'processing',
        decisionDeadline: new Date(now - 10 * 60 * 1000),
        createdAt: new Date(now - 6 * 60 * 1000),
        updatedAt: new Date(now - 6 * 60 * 1000)
    });
    const staleId = staleResult.insertedId;

    // Recent: processing for 1 minute — should NOT be reset
    const recentResult = await SmsLog.collection.insertOne({
        installId,
        contactId: 'contact-recent',
        mobileNumber: '+61400000000',
        message: 'Recent log',
        status: 'sent',
        decisionInstanceId: 'decision-inst-recent',
        decisionStatus: 'processing',
        decisionDeadline: new Date(now - 10 * 60 * 1000),
        createdAt: new Date(now - 60 * 1000),
        updatedAt: new Date(now - 60 * 1000)
    });
    const recentId = recentResult.insertedId;

    // Run stale recovery (same logic as decisionCleanupWorker.recoverStaleDecisions)
    const staleThreshold = new Date(now - 5 * 60 * 1000);
    const result = await SmsLog.updateMany(
        { decisionStatus: 'processing', updatedAt: { $lt: staleThreshold } },
        { $set: { decisionStatus: 'pending' } }
    );

    console.log(`  Recovered: ${result.modifiedCount} log(s)`);

    const recoveredLog = await SmsLog.findById(staleId);
    const untouchedLog = await SmsLog.findById(recentId);

    if (recoveredLog.decisionStatus === 'pending') {
        pass('Stale decision log reset to pending');
    } else {
        fail('Stale decision log reset to pending', `status is '${recoveredLog.decisionStatus}'`);
    }

    if (untouchedLog.decisionStatus === 'processing') {
        pass('Recent processing log not touched');
    } else {
        fail('Recent processing log not touched', `status changed to '${untouchedLog.decisionStatus}'`);
    }

    await cleanup(installId);
}

async function testCheckAndCompleteExecution() {
    section('SmsJob: checkAndCompleteExecution waits for in-flight jobs');

    const installId = 'test-inflight-' + uuidv4().slice(0, 8);
    const instanceId = 'inst-' + installId;
    const executionId = 'exec-' + installId;

    // Create 3 jobs: 1 sent, 1 processing (in-flight on another instance), 1 pending
    await SmsJob.create({
        jobId: uuidv4(), installId, instanceId, executionId,
        contactId: 'c1', mobileNumber: '+61400000000', message: 'msg',
        status: 'sent', scheduledAt: new Date()
    });
    await SmsJob.create({
        jobId: uuidv4(), installId, instanceId, executionId,
        contactId: 'c2', mobileNumber: '+61400000000', message: 'msg',
        status: 'processing', scheduledAt: new Date(), processingStartedAt: new Date()
    });
    await SmsJob.create({
        jobId: uuidv4(), installId, instanceId, executionId,
        contactId: 'c3', mobileNumber: '+61400000000', message: 'msg',
        status: 'pending', scheduledAt: new Date(Date.now() + 60000) // future
    });

    // Simulate checkAndCompleteExecution logic
    const countInFlight = await SmsJob.countDocuments({
        installId, instanceId, executionId,
        status: { $in: ['pending', 'processing'] }
    });

    if (countInFlight > 0) {
        pass(`Correctly detects ${countInFlight} jobs still in-flight — Eloqua sync deferred`);
    } else {
        fail('Should detect in-flight jobs', 'returned 0, would have synced Eloqua prematurely');
    }

    // Now complete all remaining jobs
    await SmsJob.updateMany({ installId, instanceId, executionId }, { $set: { status: 'sent' } });

    const countAfter = await SmsJob.countDocuments({
        installId, instanceId, executionId,
        status: { $in: ['pending', 'processing'] }
    });

    if (countAfter === 0) {
        pass('After completion: no in-flight jobs — Eloqua sync would proceed');
    } else {
        fail('After completion: should be 0 in-flight', `got ${countAfter}`);
    }

    await cleanup(installId);
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
    console.log('========================================');
    console.log('  Atomic Worker Tests');
    console.log('========================================');

    await mongoose.connect(process.env.MONGODB_URI);
    console.log('  Connected to MongoDB\n');

    try {
        await testSmsJobAtomicClaiming();
        await testSmsJobStaleRecovery();
        await testDecisionLogAtomicClaiming();
        await testDecisionLogStaleRecovery();
        await testCheckAndCompleteExecution();
    } finally {
        await mongoose.disconnect();
    }

    console.log('\n========================================');
    if (process.exitCode === 1) {
        console.log('  Some tests FAILED');
    } else {
        console.log('  All tests PASSED');
    }
    console.log('========================================\n');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
