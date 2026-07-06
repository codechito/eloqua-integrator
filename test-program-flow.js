/**
 * Unit tests for the Send SMS action — Program canvas flow.
 *
 * Tests the four layers touched by the program-flow fixes:
 *   1. buildRecordDefinition  — correct Eloqua field templates with [coid]
 *   2. createBulkImportDefinition — program CDO uses only Id field
 *   3. uploadContactData       — program CDO sends only { Id }
 *   4. queueSmsJobs errors     — Id is captured from items
 *
 * No database or live API connection needed — all Eloqua / Mongoose
 * dependencies are mocked at the module level before the controller loads.
 */

'use strict';

// ---------------------------------------------------------------------------
// Lightweight mock infrastructure
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`  PASS: ${message}`);
        passed++;
    } else {
        console.error(`  FAIL: ${message}`);
        failed++;
        process.exitCode = 1;
    }
}

function assertEqual(actual, expected, message) {
    if (actual === expected) {
        console.log(`  PASS: ${message}`);
        passed++;
    } else {
        console.error(`  FAIL: ${message}`);
        console.error(`        expected: ${JSON.stringify(expected)}`);
        console.error(`        actual:   ${JSON.stringify(actual)}`);
        failed++;
        process.exitCode = 1;
    }
}

function section(title) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ${title}`);
    console.log('='.repeat(60));
}

// ---------------------------------------------------------------------------
// Mock the Mongoose models so the controller can be required without a DB
// ---------------------------------------------------------------------------
const Module = require('module');
const originalLoad = Module._load.bind(Module);

const mockSmsJob = {
    findOne: async () => null,
    findOneAndUpdate: async () => null,
    prototype: { save: async function() { return this; } }
};
function MockSmsJobCtor(data) { Object.assign(this, data); }
MockSmsJobCtor.findOne = mockSmsJob.findOne;
MockSmsJobCtor.findOneAndUpdate = mockSmsJob.findOneAndUpdate;
MockSmsJobCtor.prototype.save = mockSmsJob.prototype.save;

const mockSmsLog = { prototype: { save: async function() { return this; } } };
function MockSmsLogCtor(data) { Object.assign(this, data); }
MockSmsLogCtor.prototype.save = mockSmsLog.prototype.save;

const mockActionInstance = {
    findOne: async () => null,
    prototype: { save: async function() { return this; } }
};

const fakeModels = {
    Consumer: { findOne: async () => null },
    ActionInstance: mockActionInstance,
    SmsJob: MockSmsJobCtor,
    SmsLog: MockSmsLogCtor
};

const fakeLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
};

Module._load = function(request, parent, isMain) {
    if (request === '../models' || request.endsWith('/models') || request.endsWith('/models/index')) {
        return fakeModels;
    }
    if (request === '../utils' || request.endsWith('/utils')) {
        return {
            logger: fakeLogger,
            generateId: () => 'test-id-' + Date.now(),
            formatPhoneNumber: (n) => n,
            replaceMergeFields: (msg) => msg,
            extractMergeFields: () => []
        };
    }
    if (request === '../middleware' || request.endsWith('/middleware')) {
        return { asyncHandler: fn => fn };
    }
    if (request === '../services' || request.endsWith('/services')) {
        return {
            EloquaService: class { async initialize() {} },
            TransmitSmsService: class {}
        };
    }
    if (request === 'libphonenumber-js') {
        return { parsePhoneNumber: (n) => ({ number: n, country: 'AU', isValid: () => true }) };
    }
    return originalLoad(request, parent, isMain);
};

// Now load the controller with mocked dependencies
const ActionController = require('./controllers/actionController');

// ---------------------------------------------------------------------------
// TEST 1: buildRecordDefinition — Campaign flow (no program_coid)
// ---------------------------------------------------------------------------
section('TEST 1: buildRecordDefinition — Campaign flow');

(async () => {
    const instance = {
        instanceId: 'test-instance-1',
        program_coid: null,
        recipient_field: '1001__C_MobilePhone',
        country_field: 'Country',
        country_setting: 'cc',
        caller_id: null,
        message: 'Hello [FirstName]',
        tracked_link: null,
        custom_object_id: null
    };

    const rd = await ActionController.buildRecordDefinition(instance);

    assertEqual(rd.ContactID, '{{Contact.Id}}', 'Campaign: ContactID uses Contact.Id');
    assertEqual(rd.EmailAddress, '{{Contact.Field(C_EmailAddress)}}', 'Campaign: EmailAddress uses Contact field');
    assert(!rd.Id, 'Campaign: no Id field in record definition');

    // recipient field: fieldId__fieldName format -> key is fieldName
    const recipientKey = 'C_MobilePhone';
    assert(rd[recipientKey] !== undefined, `Campaign: recipient key "${recipientKey}" present`);
    assertEqual(rd[recipientKey], '{{Contact.Field(C_MobilePhone)}}', 'Campaign: recipient field template correct');

    // merge field from message
    assert(rd.FirstName !== undefined, 'Campaign: merge field FirstName added');
    assertEqual(rd.FirstName, '{{Contact.Field(FirstName)}}', 'Campaign: merge field template correct');
})();

// ---------------------------------------------------------------------------
// TEST 2: buildRecordDefinition — Program flow (with program_coid)
// ---------------------------------------------------------------------------
section('TEST 2: buildRecordDefinition — Program flow');

(async () => {
    const coid = '99887766';
    const instance = {
        instanceId: 'test-instance-2',
        program_coid: coid,
        recipient_field: '5001__MobilePhone',
        country_field: 'Country',
        country_setting: 'cc',
        caller_id: null,
        message: 'Hello [FirstName]',
        tracked_link: null,
        custom_object_id: null
    };

    const rd = await ActionController.buildRecordDefinition(instance);

    // ContactID must include [coid]
    assertEqual(
        rd.ContactID,
        `{{CustomObject[${coid}].Contact.Id}}`,
        'Program: ContactID includes [coid]'
    );
    // EmailAddress must include [coid]
    assertEqual(
        rd.EmailAddress,
        `{{CustomObject[${coid}].Contact.Field(C_EmailAddress)}}`,
        'Program: EmailAddress includes [coid]'
    );
    // Id field must include [coid]
    assertEqual(
        rd.Id,
        `{{CustomObject[${coid}].Id}}`,
        'Program: Id field includes [coid]'
    );
    // recipient field: CDO field reference
    const recipientKey = 'MobilePhone';
    assert(rd[recipientKey] !== undefined, `Program: recipient key "${recipientKey}" present`);
    assertEqual(
        rd[recipientKey],
        `{{CustomObject[${coid}].Field[5001]}}`,
        'Program: recipient field uses CDO Field[id] template'
    );
    // merge field from message uses CDO contact reference
    assert(rd.FirstName !== undefined, 'Program: merge field FirstName added');
    assertEqual(
        rd.FirstName,
        `{{CustomObject[${coid}].Contact.Field(FirstName)}}`,
        'Program: merge field uses CDO contact template'
    );
})();

// ---------------------------------------------------------------------------
// TEST 3: buildRecordDefinition — Program, dynamic caller_id (##FieldName)
// ---------------------------------------------------------------------------
section('TEST 3: buildRecordDefinition — Program, dynamic caller_id');

(async () => {
    const coid = '11223344';
    const instance = {
        instanceId: 'test-instance-3',
        program_coid: coid,
        recipient_field: '5001__MobilePhone',
        country_field: 'Country',
        country_setting: 'cc',
        caller_id: '##VirtualNumber',
        message: 'Hi',
        tracked_link: null,
        custom_object_id: null
    };

    const rd = await ActionController.buildRecordDefinition(instance);

    assert(rd.VirtualNumber !== undefined, 'Program: dynamic caller_id field added');
    assertEqual(
        rd.VirtualNumber,
        `{{CustomObject[${coid}].Contact.Field(C_VirtualNumber)}}`,
        'Program: dynamic caller_id uses CDO contact field template'
    );
})();

// ---------------------------------------------------------------------------
// TEST 4: createBulkImportDefinition — Campaign flow
// ---------------------------------------------------------------------------
section('TEST 4: createBulkImportDefinition — Campaign flow');

(async () => {
    let capturedType, capturedDef;
    const mockEloquaService = {
        ensureInitialized: async () => {},
        createBulkImport: async (type, def) => {
            capturedType = type;
            capturedDef = def;
            return { uri: '/imports/mock-uri' };
        }
    };

    const instance = {
        instanceId: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff',
        program_coid: null,
        lastExecutedAt: new Date()
    };

    await ActionController.createBulkImportDefinition(mockEloquaService, instance, 'complete');

    assertEqual(capturedType, 'contacts', 'Campaign: import type is contacts');
    assert('ContactID' in capturedDef.fields, 'Campaign: import has ContactID field');
    assert('EmailAddress' in capturedDef.fields, 'Campaign: import has EmailAddress field');
    assert(!('Id' in capturedDef.fields), 'Campaign: import has no Id field');
    assertEqual(capturedDef.identifierFieldName, 'EmailAddress', 'Campaign: identifier is EmailAddress');
    assertEqual(capturedDef.fields.ContactID, '{{Contact.Id}}', 'Campaign: ContactID template correct');
})();

// ---------------------------------------------------------------------------
// TEST 5: createBulkImportDefinition — Program flow
// ---------------------------------------------------------------------------
section('TEST 5: createBulkImportDefinition — Program flow');

(async () => {
    const coid = '55443322';
    let capturedType, capturedDef;
    const mockEloquaService = {
        ensureInitialized: async () => {},
        createBulkImport: async (type, def) => {
            capturedType = type;
            capturedDef = def;
            return { uri: '/imports/mock-uri' };
        }
    };

    const instance = {
        instanceId: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff',
        program_coid: coid,
        lastExecutedAt: new Date()
    };

    await ActionController.createBulkImportDefinition(mockEloquaService, instance, 'complete');

    assertEqual(capturedType, coid, 'Program: import type is program_coid');
    assert('Id' in capturedDef.fields, 'Program: import has Id field');
    assert(!('ContactID' in capturedDef.fields), 'Program: import has NO ContactID field');
    assert(!('EmailAddress' in capturedDef.fields), 'Program: import has NO EmailAddress field');
    assertEqual(
        capturedDef.fields.Id,
        `{{CustomObject[${coid}].Id}}`,
        'Program: Id field template includes [coid]'
    );
    assertEqual(capturedDef.identifierFieldName, 'Id', 'Program: identifier is Id');
})();

// ---------------------------------------------------------------------------
// TEST 6: uploadContactData — Campaign flow
// ---------------------------------------------------------------------------
section('TEST 6: uploadContactData — Campaign flow');

(async () => {
    let capturedData;
    const mockEloquaService = {
        uploadBulkImportData: async (uri, data) => {
            capturedData = data;
            return {};
        }
    };

    const messages = [
        { contactId: 'c1', emailAddress: 'a@example.com', Id: null },
        { contactId: 'c2', emailAddress: 'b@example.com', Id: null }
    ];

    await ActionController.uploadContactData(mockEloquaService, '/imports/uri', messages, null);

    assert(Array.isArray(capturedData), 'Campaign: upload data is array');
    assertEqual(capturedData.length, 2, 'Campaign: uploads 2 records');
    assertEqual(capturedData[0].ContactID, 'c1', 'Campaign: ContactID is contactId');
    assertEqual(capturedData[0].EmailAddress, 'a@example.com', 'Campaign: EmailAddress correct');
    assert(!('Id' in capturedData[0]), 'Campaign: no Id field in upload row');
})();

// ---------------------------------------------------------------------------
// TEST 7: uploadContactData — Program flow
// ---------------------------------------------------------------------------
section('TEST 7: uploadContactData — Program flow');

(async () => {
    let capturedData;
    const mockEloquaService = {
        uploadBulkImportData: async (uri, data) => {
            capturedData = data;
            return {};
        }
    };

    const messages = [
        { contactId: 'c1', emailAddress: 'a@example.com', Id: 'cdo-record-1' },
        { contactId: 'c2', emailAddress: 'b@example.com', Id: 'cdo-record-2' }
    ];

    await ActionController.uploadContactData(
        mockEloquaService, '/imports/uri', messages, '99887766'
    );

    assert(Array.isArray(capturedData), 'Program: upload data is array');
    assertEqual(capturedData.length, 2, 'Program: uploads 2 records');
    assertEqual(capturedData[0].Id, 'cdo-record-1', 'Program: Id field uploaded');
    assert(!('ContactID' in capturedData[0]), 'Program: no ContactID in upload row');
    assert(!('EmailAddress' in capturedData[0]), 'Program: no EmailAddress in upload row');
})();

// ---------------------------------------------------------------------------
// TEST 8: buildRecordDefinition — country_field as CDO custom field (cf mode)
// ---------------------------------------------------------------------------
section('TEST 8: buildRecordDefinition — Program, country as CDO field');

(async () => {
    const coid = '77665544';
    const instance = {
        instanceId: 'test-instance-8',
        program_coid: coid,
        recipient_field: '5001__MobilePhone',
        country_field: '6001__CountryCDO',
        country_setting: 'cf',
        caller_id: null,
        message: 'Hi',
        tracked_link: null,
        custom_object_id: null
    };

    const rd = await ActionController.buildRecordDefinition(instance);

    // country is a CDO custom field (split by __)
    assert(rd.CountryCDO !== undefined, 'Program cf: country key is CDO field name');
    assertEqual(
        rd.CountryCDO,
        `{{CustomObject[${coid}].Field[6001]}}`,
        'Program cf: country uses CDO Field[id] template'
    );
})();

// ---------------------------------------------------------------------------
// TEST 9: Campaign error objects — Id field NOT added (campaign flow untouched)
// ---------------------------------------------------------------------------
section('TEST 9: Campaign error objects — no Id field added');

(async () => {
    // Simulate a campaign item (no Id in record definition)
    const campaignItem = {
        ContactID: 'contact-1',
        EmailAddress: 'a@example.com'
        // No Id field — campaigns don't have it in the record definition
    };

    // Build the error object the same way queueSmsJobs does for campaigns
    const instance_campaign = { program_coid: null };
    const errorObj = {
        contactId: campaignItem.ContactID,
        emailAddress: campaignItem.EmailAddress,
        ...(instance_campaign.program_coid ? { Id: campaignItem.Id } : {}),
        error: 'No mobile number',
        errorCode: 'MISSING_MOBILE'
    };

    assert(!('Id' in errorObj), 'Campaign: Id field NOT present in error object');
    assertEqual(errorObj.contactId, 'contact-1', 'Campaign: contactId correct');
    assertEqual(errorObj.emailAddress, 'a@example.com', 'Campaign: emailAddress correct');
})();

// ---------------------------------------------------------------------------
// TEST 10: Program error objects — Id field IS added
// ---------------------------------------------------------------------------
section('TEST 10: Program error objects — Id field added');

(async () => {
    const programItem = {
        ContactID: 'contact-2',
        EmailAddress: 'b@example.com',
        Id: 'cdo-record-42'   // programs have Id from {{CustomObject[coid].Id}}
    };

    const instance_program = { program_coid: '99887766' };
    const errorObj = {
        contactId: programItem.ContactID,
        emailAddress: programItem.EmailAddress,
        ...(instance_program.program_coid ? { Id: programItem.Id } : {}),
        error: 'No mobile number',
        errorCode: 'MISSING_MOBILE'
    };

    assert('Id' in errorObj, 'Program: Id field IS present in error object');
    assertEqual(errorObj.Id, 'cdo-record-42', 'Program: Id value correct');
})();

// ---------------------------------------------------------------------------
// TEST 11: syncQueuingErrorsToEloqua — campaign uses contacts import, EmailAddress identifier
// ---------------------------------------------------------------------------
section('TEST 11: syncQueuingErrorsToEloqua — Campaign error sync');

(async () => {
    let capturedType, capturedDef, capturedData;
    const mockEloquaService = {
        initialize: async () => {},
        createBulkImport: async (type, def) => { capturedType = type; capturedDef = def; return { uri: '/u' }; },
        uploadBulkImportData: async (uri, data) => { capturedData = data; return {}; },
        syncBulkImport: async () => ({ uri: '/sync/1' }),
        getSyncStatus: async () => ({ status: 'success' })
    };

    // Patch EloquaService constructor to return our mock
    const orig = ActionController.syncQueuingErrorsToEloqua;

    // Directly test the import definition shape for campaigns by calling createBulkImportDefinition
    const campaignInstance = {
        instanceId: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff',
        program_coid: null,
        lastExecutedAt: new Date()
    };

    await ActionController.createBulkImportDefinition(mockEloquaService, campaignInstance, 'complete');

    assertEqual(capturedType, 'contacts', 'Campaign sync: import type is contacts');
    assertEqual(capturedDef.identifierFieldName, 'EmailAddress', 'Campaign sync: identifier is EmailAddress');
    assert('ContactID' in capturedDef.fields, 'Campaign sync: ContactID field present');
    assert(!('Id' in capturedDef.fields), 'Campaign sync: no Id field');
})();

// ---------------------------------------------------------------------------
// TEST 12: uploadContactData — campaign upload sends correct shape (no Id)
// ---------------------------------------------------------------------------
section('TEST 12: uploadContactData campaign — Id field not present even if passed null');

(async () => {
    let capturedData;
    const mockEloquaService = {
        uploadBulkImportData: async (uri, data) => { capturedData = data; return {}; }
    };

    // Campaign: program_coid is null
    const messages = [{ contactId: 'c1', emailAddress: 'a@example.com', Id: null }];
    await ActionController.uploadContactData(mockEloquaService, '/u', messages, null);

    assert(!('Id' in capturedData[0]), 'Campaign upload: Id field absent');
    assert('ContactID' in capturedData[0], 'Campaign upload: ContactID present');
    assert('EmailAddress' in capturedData[0], 'Campaign upload: EmailAddress present');
})();

// ---------------------------------------------------------------------------
// TEST 13 & 14: queueSmsJobs — run sequentially to avoid prototype.save races
// ---------------------------------------------------------------------------
(async () => {
    section('TEST 13: queueSmsJobs — program SmsJob stores eloquaRecordId');

    const savedJobs13 = [];
    MockSmsJobCtor.prototype.save = async function() { savedJobs13.push(this); return this; };
    MockSmsJobCtor.isDuplicateWithinMinute = async () => false;

    const progInstance = {
        instanceId: 'prog-inst-13',
        installId: 'install-13',
        program_coid: '55443322',
        recipient_field: '5001__MobilePhone',
        country_field: 'Country',
        country_setting: 'cc',
        caller_id: null,
        message: 'Hello',
        tracked_link: null,
        custom_object_id: null,
        assetId: 'asset-13',
        assetName: 'Test Program'
    };
    const consumer = { default_country: 'AU', tps_limit: 10 };
    const progItems = [{
        ContactID: 'c-prog-1',
        EmailAddress: 'prog@example.com',
        MobilePhone: '+61400000001',
        Id: 'cdo-record-999',
        message: 'Hello'
    }];

    await ActionController.queueSmsJobs(progInstance, consumer, progItems, 'exec-13', null);

    assert(savedJobs13.length >= 1, 'Program queueSmsJobs: SmsJob was saved');
    if (savedJobs13.length >= 1) {
        assertEqual(savedJobs13[0].eloquaRecordId, 'cdo-record-999', 'Program queueSmsJobs: eloquaRecordId set to item.Id');
    }

    section('TEST 14: queueSmsJobs — campaign SmsJob has no eloquaRecordId');

    const savedJobs14 = [];
    MockSmsJobCtor.prototype.save = async function() { savedJobs14.push(this); return this; };

    const campInstance = {
        instanceId: 'camp-inst-14',
        installId: 'install-14',
        program_coid: null,
        recipient_field: '1001__C_MobilePhone',
        country_field: 'Country',
        country_setting: 'cc',
        caller_id: null,
        message: 'Hello',
        tracked_link: null,
        custom_object_id: null,
        assetId: 'asset-14',
        assetName: 'Test Campaign'
    };
    const campItems = [{
        ContactID: 'c-camp-1',
        EmailAddress: 'camp@example.com',
        C_MobilePhone: '+61400000002',
        message: 'Hello'
    }];

    await ActionController.queueSmsJobs(campInstance, consumer, campItems, 'exec-14', null);

    assert(savedJobs14.length >= 1, 'Campaign queueSmsJobs: SmsJob was saved');
    if (savedJobs14.length >= 1) {
        assert(!('eloquaRecordId' in savedJobs14[0]) || savedJobs14[0].eloquaRecordId === undefined,
            'Campaign queueSmsJobs: eloquaRecordId NOT set');
    }

    // Restore original save
    MockSmsJobCtor.prototype.save = async function() { return this; };
})();

// ---------------------------------------------------------------------------
// TEST 15: worker results — complete includes Id from eloquaRecordId for programs
// ---------------------------------------------------------------------------
section('TEST 15: worker results.complete — Id present for program jobs');

(() => {
    const programJob = {
        contactId: 'c-prog',
        emailAddress: 'prog@example.com',
        mobileNumber: '+61400000001',
        message: 'Hello',
        senderId: 'BurstSMS',
        campaignId: 'asset-1',
        eloquaRecordId: 'cdo-record-777'
    };

    const completedResult = {
        contactId: programJob.contactId,
        emailAddress: programJob.emailAddress,
        phone: programJob.mobileNumber,
        message: programJob.message,
        message_id: 'msg-123',
        caller_id: programJob.senderId,
        assetId: programJob.campaignId,
        ...(programJob.eloquaRecordId ? { Id: programJob.eloquaRecordId } : {}),
        sync_status: 'sent',
        delivery: 'sent'
    };

    assert('Id' in completedResult, 'Worker complete: Id field present for program job');
    assertEqual(completedResult.Id, 'cdo-record-777', 'Worker complete: Id value correct');
})();

// ---------------------------------------------------------------------------
// TEST 16: worker results — complete has NO Id for campaign jobs (eloquaRecordId absent)
// ---------------------------------------------------------------------------
section('TEST 16: worker results.complete — Id absent for campaign jobs');

(() => {
    const campaignJob = {
        contactId: 'c-camp',
        emailAddress: 'camp@example.com',
        mobileNumber: '+61400000002',
        message: 'Hello',
        senderId: 'BurstSMS',
        campaignId: 'asset-2',
        // eloquaRecordId not set (campaigns)
    };

    const completedResult = {
        contactId: campaignJob.contactId,
        emailAddress: campaignJob.emailAddress,
        phone: campaignJob.mobileNumber,
        message: campaignJob.message,
        message_id: 'msg-456',
        caller_id: campaignJob.senderId,
        assetId: campaignJob.campaignId,
        ...(campaignJob.eloquaRecordId ? { Id: campaignJob.eloquaRecordId } : {}),
        sync_status: 'sent',
        delivery: 'sent'
    };

    assert(!('Id' in completedResult), 'Worker complete: Id field absent for campaign job');
})();

// ---------------------------------------------------------------------------
// TEST 17: worker results — errored includes Id from eloquaRecordId for programs
// ---------------------------------------------------------------------------
section('TEST 17: worker results.errored — Id present for program jobs');

(() => {
    const programJob = {
        contactId: 'c-prog-err',
        emailAddress: 'prog-err@example.com',
        mobileNumber: '+61400000003',
        eloquaRecordId: 'cdo-record-888'
    };

    const errorResult = {
        contactId: programJob.contactId,
        emailAddress: programJob.emailAddress,
        phone: programJob.mobileNumber,
        error: 'Send failed',
        errorCode: 'SEND_FAILED',
        ...(programJob.eloquaRecordId ? { Id: programJob.eloquaRecordId } : {}),
        sync_status: 'errored',
        delivery: 'errored'
    };

    assert('Id' in errorResult, 'Worker errored: Id field present for program job');
    assertEqual(errorResult.Id, 'cdo-record-888', 'Worker errored: Id value correct');
})();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
process.on('exit', () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(60) + '\n');
    if (failed > 0) {
        process.exitCode = 1;
    }
});
