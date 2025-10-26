require('dotenv').config();
const {
    formatPhoneNumber,
    validatePhoneNumber,
    extractMergeFields,
    calculateSmsSegments,
    formatDate,
    generateId
} = require('./utils');

console.log('========================================');
console.log('  Testing Utility Functions');
console.log('========================================\n');

// Test phone formatter
console.log('1. Testing Phone Formatter:');
try {
    const formatted = formatPhoneNumber('0412345678', 'Australia');
    console.log(`   ✓ Format: 0412345678 → ${formatted}`);
    
    const isValid = validatePhoneNumber('+61412345678', 'Australia');
    console.log(`   ✓ Valid: +61412345678 → ${isValid}`);
} catch (error) {
    console.error('   ✗ Phone formatter error:', error.message);
}

// Test merge fields
console.log('\n2. Testing Merge Fields:');
const message = 'Hello [C_FirstName], your code is {{CustomObject<123>.Field<456>}}. Click [tracked-link]';
const fields = extractMergeFields(message);
console.log(`   ✓ Extracted ${fields.length} merge fields:`, fields.map(f => f.placeholder));

// Test SMS segments
console.log('\n3. Testing SMS Segments:');
const shortMsg = 'Hello world';
const longMsg = 'A'.repeat(200);
console.log(`   ✓ Short message (${shortMsg.length} chars):`, calculateSmsSegments(shortMsg));
console.log(`   ✓ Long message (${longMsg.length} chars):`, calculateSmsSegments(longMsg));

// Test date formatter
console.log('\n4. Testing Date Formatter:');
const now = new Date();
console.log(`   ✓ Formatted: ${formatDate(now)}`);
console.log(`   ✓ Custom format: ${formatDate(now, 'DD/MM/YYYY')}`);

// Test ID generation
console.log('\n5. Testing ID Generation:');
console.log(`   ✓ UUID: ${generateId()}`);

console.log('\n✓ All utility tests completed!');
console.log('========================================\n');