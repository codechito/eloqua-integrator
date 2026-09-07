/**
 * EQ-15 — failed sends must be reported to Eloqua as errored, not complete.
 *
 * The sync direction is integrator -> Eloqua: an outbound Bulk API call. Everything the
 * fix touches is decided before that call leaves us, so a recording mock in place of
 * EloquaService exercises the whole path without a server, without Eloqua and without a
 * database. What a mock cannot prove is that Eloqua accepts status "errored" - that is an
 * API contract question, answered by syncQueuingErrorsToEloqua having sent exactly that
 * value for validation errors in production for months.
 *
 * Run: npm run test:errored-status
 */

const path = require('path');

// ---------------------------------------------------------------------------
// Recording mock, installed before actionController is loaded so its
// require('../services') resolves to this instead of the real Eloqua client.
// ---------------------------------------------------------------------------

const calls = [];
let failOnImportType = null;

class MockEloquaService {
    constructor(installId, siteId) {
        this.installId = installId;
        this.siteId = siteId;
        calls.push({ call: 'constructor', installId, siteId });
    }

    async initialize() {
        calls.push({ call: 'initialize' });
    }

    async createBulkImport(importType, definition) {
        const uri = `/contacts/imports/${calls.filter(c => c.call === 'createBulkImport').length + 1}`;
        calls.push({ call: 'createBulkImport', importType, definition, uri });

        if (failOnImportType && definition.syncActions[0].status === failOnImportType) {
            throw new Error(`Eloqua rejected the ${failOnImportType} import`);
        }
        return { uri, ...definition };
    }

    async uploadBulkImportData(importUri, data) {
        calls.push({ call: 'uploadBulkImportData', importUri, data });
        return { uri: importUri };
    }

    async syncBulkImport(importUri) {
        const uri = `${importUri}/sync`;
        calls.push({ call: 'syncBulkImport', importUri, uri });
        return { uri, status: 'pending' };
    }

    async checkSyncStatus(syncUri) {
        calls.push({ call: 'checkSyncStatus', syncUri });
        return { status: 'success', syncUri };
    }
}

const servicesPath = require.resolve('./services');
require.cache[servicesPath] = {
    id: servicesPath,
    filename: servicesPath,
    loaded: true,
    exports: {
        EloquaService: MockEloquaService,
        TransmitSmsService: class {}
    }
};

// Quiet the logger so assertions are the only output.
const utilsPath = require.resolve('./utils');
const realUtils = require(utilsPath);
for (const level of ['info', 'warn', 'error', 'debug']) {
    realUtils.logger[level] = () => {};
}

const ActionController = require('./controllers/actionController');

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

// actual is passed as a thunk so that a missing import - which is exactly what the
// pre-fix code produces - is reported as a failed assertion rather than crashing the run.
function check(label, actualFn, expected) {
    let actual;
    try {
        actual = typeof actualFn === 'function' ? actualFn() : actualFn;
    } catch (error) {
        console.log(`  ✗ ${label}\n      threw: ${error.message}`);
        failed++;
        return;
    }
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        console.log(`  ✓ ${label}`);
        passed++;
    } else {
        console.log(`  ✗ ${label}\n      expected: ${e}\n      actual:   ${a}`);
        failed++;
    }
}

function reset() {
    calls.length = 0;
    failOnImportType = null;
}

const consumer = { installId: 'install-eq15', SiteId: '99999' };
const instance = {
    instanceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    program_coid: null,
    lastExecutedAt: null
};

const contact = (n, extra = {}) => ({
    contactId: `c${n}`,
    emailAddress: `c${n}@example.com`,
    Id: `cdo${n}`,
    ...extra
});

const imports = () => calls.filter(c => c.call === 'createBulkImport');
const statuses = () => imports().map(c => c.definition.syncActions[0].status);
const uploads = () => calls.filter(c => c.call === 'uploadBulkImportData');

console.log('\n' + '='.repeat(66));
console.log('  EQ-15 — errored status reported back to Eloqua');
console.log('='.repeat(66));

async function run() {
    // -----------------------------------------------------------------------
    console.log('\nTEST 1: mixed batch produces one complete and one errored import');
    console.log('-'.repeat(66));
    reset();
    await ActionController.syncResultsToEloqua(consumer, instance, {
        complete: [contact(1), contact(2)],
        errored: [contact(3)]
    });

    check('two imports created', () => imports().length, 2);
    check('statuses are complete then errored', () => statuses(), ['complete', 'errored']);
    check('complete import carries the 2 delivered contacts', () => uploads()[0].data.map(d => d.ContactID), ['c1', 'c2']);
    check('errored import carries only the failed contact', () => uploads()[1].data.map(d => d.ContactID), ['c3']);
    check('each import synced', () => calls.filter(c => c.call === 'syncBulkImport').length, 2);
    check('each sync awaited to completion', () => calls.filter(c => c.call === 'checkSyncStatus').length, 2);
    check('the two imports are distinct', () => imports()[0].uri !== imports()[1].uri, true);

    // -----------------------------------------------------------------------
    console.log('\nTEST 2: all-failed batch is reported errored (the regression)');
    console.log('-'.repeat(66));
    reset();
    await ActionController.syncResultsToEloqua(consumer, instance, {
        complete: [],
        errored: [contact(4), contact(5)]
    });

    check('one import only', () => imports().length, 1);
    check('status is errored, not complete', () => statuses(), ['errored']);
    check('carries both failed contacts', () => uploads()[0].data.map(d => d.ContactID), ['c4', 'c5']);

    // -----------------------------------------------------------------------
    console.log('\nTEST 3: all-delivered batch still reports complete (no regression)');
    console.log('-'.repeat(66));
    reset();
    await ActionController.syncResultsToEloqua(consumer, instance, {
        complete: [contact(6)],
        errored: []
    });

    check('one import only', () => imports().length, 1);
    check('status is complete', () => statuses(), ['complete']);
    check('no empty errored import is defined', () => imports().every(c => c.definition.syncActions[0].status !== 'errored'), true);

    // -----------------------------------------------------------------------
    console.log('\nTEST 4: nothing to sync makes no Eloqua calls');
    console.log('-'.repeat(66));
    reset();
    await ActionController.syncResultsToEloqua(consumer, instance, {
        complete: [],
        errored: []
    });

    check('no imports defined', () => imports().length, 0);
    check('no uploads attempted', () => uploads().length, 0);

    // -----------------------------------------------------------------------
    console.log('\nTEST 5: a failing errored batch surfaces instead of being swallowed');
    console.log('-'.repeat(66));
    reset();
    failOnImportType = 'errored';
    let threw = null;
    try {
        await ActionController.syncResultsToEloqua(consumer, instance, {
            complete: [contact(7)],
            errored: [contact(8)]
        });
    } catch (error) {
        threw = error.message;
    }

    check('the error propagates to the caller', () => threw, 'Eloqua rejected the errored import');
    check('the complete batch had already been synced', () => calls.filter(c => c.call === 'syncBulkImport').length, 1);

    // -----------------------------------------------------------------------
    console.log('\nTEST 6: a failing complete batch does not strand the errored one silently');
    console.log('-'.repeat(66));
    reset();
    failOnImportType = 'complete';
    threw = null;
    try {
        await ActionController.syncResultsToEloqua(consumer, instance, {
            complete: [contact(9)],
            errored: [contact(10)]
        });
    } catch (error) {
        threw = error.message;
    }

    check('the error propagates rather than being logged and dropped', () => threw, 'Eloqua rejected the complete import');

    // -----------------------------------------------------------------------
    console.log('\nTEST 7: program CDO instances keep their Id identifier on both imports');
    console.log('-'.repeat(66));
    reset();
    const cdoInstance = { ...instance, program_coid: '4242' };
    await ActionController.syncResultsToEloqua(consumer, cdoInstance, {
        complete: [contact(11)],
        errored: [contact(12)]
    });

    check('both imports target the CDO endpoint', () => imports().map(c => c.importType), ['4242', '4242']);
    check('both identify records by Id', () => imports().map(c => c.definition.identifierFieldName), ['Id', 'Id']);
    check('both statuses still differ', () => statuses(), ['complete', 'errored']);
    check('CDO uploads send Id only', () => uploads().map(u => Object.keys(u.data[0])), [['Id'], ['Id']]);

    // -----------------------------------------------------------------------
    console.log('\nTEST 8: syncAction destination stays the dash-stripped action instance');
    console.log('-'.repeat(66));
    reset();
    await ActionController.syncResultsToEloqua(consumer, instance, {
        complete: [contact(13)],
        errored: [contact(14)]
    });

    const expectedDestination = '{{ActionInstance(aaaaaaaabbbbccccddddeeeeeeeeeeee)}}';
    check('both imports point at the same action instance', () => imports().map(c => c.definition.syncActions[0].destination),
        [expectedDestination, expectedDestination]);
    check('action is setStatus on both', () => imports().map(c => c.definition.syncActions[0].action),
        ['setStatus', 'setStatus']);

    // -----------------------------------------------------------------------
    console.log('\n' + '='.repeat(66));
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log('='.repeat(66) + '\n');
    process.exit(failed === 0 ? 0 : 1);
}

run().catch(error => {
    console.error('\nTest harness error:', error);
    process.exit(1);
});
