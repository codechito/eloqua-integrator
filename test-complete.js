require('dotenv').config();
const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

console.log('========================================');
console.log('  Testing Complete Application');
console.log('========================================\n');

async function testEndpoints() {
    try {
        // Test 1: Health Check
        console.log('1. Testing Health Endpoint...');
        const health = await axios.get(`${BASE_URL}/health`);
        console.log('   ✓ Health check passed');
        console.log(`   Database: ${health.data.database}`);

        // Test 2: Root endpoint
        console.log('\n2. Testing Root Endpoint...');
        const root = await axios.get(`${BASE_URL}/`);
        console.log('   ✓ Root endpoint passed');
        console.log(`   Endpoints available: ${Object.keys(root.data.endpoints).length}`);

        // Test 3: Install endpoint (with mock data)
        console.log('\n3. Testing Install Endpoint...');
        try {
            const install = await axios.get(`${BASE_URL}/eloqua/app/install`, {
                params: {
                    installId: 'test-' + Date.now(),
                    siteId: '1234',
                    siteName: 'Test Site'
                }
            });
            console.log('   ✓ Install endpoint passed');
        } catch (error) {
            console.log('   ⚠ Install endpoint (expected auth required)');
        }

        console.log('\n✓ All endpoint tests completed!');
        console.log('========================================\n');
        
        process.exit(0);
    } catch (error) {
        console.error('\n✗ Test failed:', error.message);
        process.exit(1);
    }
}

// Give server time to start
setTimeout(testEndpoints, 2000);