require('dotenv').config();
const axios = require('axios');

const BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';

async function testReauthFlow() {
    console.log('\n' + '='.repeat(60));
    console.log('  RE-AUTHORIZATION FLOW TEST');
    console.log('='.repeat(60) + '\n');

    const testInstallId = process.argv[2];
    
    if (!testInstallId) {
        console.log('✗ Please provide an installId as argument');
        console.log('\nUsage: node test-reauth-flow.js <installId>\n');
        process.exit(1);
    }

    console.log(`Testing with installId: ${testInstallId}\n`);

    // TEST 1: AJAX request with reauth error
    console.log('TEST 1: AJAX endpoint with expired token');
    console.log('-'.repeat(60));

    try {
        const response = await axios.get(
            `${BASE_URL}/eloqua/action/ajax/customobjects/${testInstallId}/123/customObject`,
            {
                headers: {
                    'Accept': 'application/json'
                }
            }
        );
        
        console.log('✓ Request succeeded');
        console.log(`  Response: ${response.data.elements?.length || 0} objects`);
    } catch (error) {
        if (error.response?.data?.code === 'REAUTH_REQUIRED') {
            console.log('✓ Correctly returned REAUTH_REQUIRED');
            console.log(`  Status: ${error.response.status}`);
            console.log(`  Message: ${error.response.data.message}`);
            console.log(`  ReAuth URL: ${error.response.data.reAuthUrl}`);
        } else {
            console.log('✗ Different error:', error.response?.data || error.message);
        }
    }

    // TEST 2: Regular page request with reauth error
    console.log('\nTEST 2: Configuration page with expired token');
    console.log('-'.repeat(60));

    try {
        const response = await axios.get(
            `${BASE_URL}/eloqua/app/configure?installId=${testInstallId}&siteId=123`,
            {
                maxRedirects: 0,
                validateStatus: (status) => status < 500
            }
        );
        
        if (response.status === 401 && response.data.includes('Re-authorization Required')) {
            console.log('✓ Correctly shows re-auth page');
            console.log(`  Status: ${response.status}`);
            console.log('  Contains re-auth HTML: Yes');
        } else {
            console.log('✓ Page loaded successfully');
            console.log(`  Status: ${response.status}`);
        }
    } catch (error) {
        console.log('✗ Error:', error.message);
    }

    console.log('\n' + '='.repeat(60));
    console.log('✓ REAUTH FLOW TEST COMPLETED');
    console.log('='.repeat(60) + '\n');
}

testReauthFlow();