/**
 * Tests for tracked link fixes in actionController.enrichItems and saveConfiguration
 *
 * Tests:
 *  1. Valid tracked_link URL → correct tracked_link_url on each item
 *  2. Empty string tracked_link → tracked_link_url is null (no crash)
 *  3. Null/undefined tracked_link → tracked_link_url is null
 *  4. Whitespace-only tracked_link → treated as null (trimming fix)
 *  5. tracked_link with merge fields → values URL-encoded
 *  6. tracked_link with merge field containing special chars → URL-encoded correctly
 *  7. Message has [tracked-link] but tracked_link is empty → Slack alert fires (logged)
 *  8. tracked_link with leading/trailing whitespace → trimmed correctly
 *  9. saveConfiguration normalization: empty string → undefined (won't overwrite DB value)
 * 10. saveConfiguration normalization: valid URL → preserved as-is
 * 11. saveConfiguration normalization: whitespace URL → treated as undefined
 */

require('dotenv').config();

let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        console.log(`  ✓ ${label}`);
        passed++;
    } else {
        console.error(`  ✗ FAIL: ${label}`);
        failed++;
    }
}

// ─── Inline a minimal version of enrichItems for unit testing ─────────────────
// We extract just the tracked-link logic to test it independently of DB/Eloqua.

function simulateEnrichItems(items, instance) {
    const warnings = [];

    if (instance.message?.includes('[tracked-link]') && !instance.tracked_link?.trim()) {
        warnings.push('tracked_link_misconfiguration');
    }

    return {
        warnings,
        items: items.map(item => {
            let processedTrackedLink = null;
            const trimmedTrackedLink = instance.tracked_link?.trim() || null;

            if (trimmedTrackedLink) {
                processedTrackedLink = trimmedTrackedLink;
                const linkMergeFields = trimmedTrackedLink.match(/\[([^\]]+)\]/g);
                if (linkMergeFields) {
                    for (const field of linkMergeFields) {
                        const inner = field.replace(/[\[\]]/g, '');
                        const pipeIdx = inner.indexOf('|');
                        const fieldName = pipeIdx === -1 ? inner : inner.substring(0, pipeIdx);
                        const rawValue = item[fieldName] || item[fieldName.replace('C_', '')] || '';
                        processedTrackedLink = processedTrackedLink.replace(field, encodeURIComponent(rawValue));
                    }
                }
            }

            return { ...item, tracked_link_url: processedTrackedLink };
        })
    };
}

// ─── Simulate saveConfiguration tracked_link normalization ────────────────────

function normalizeTrackedLink(instanceData) {
    if (typeof instanceData.tracked_link === 'string') {
        instanceData.tracked_link = instanceData.tracked_link.trim() || undefined;
    }
    return instanceData;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log('\n========================================');
console.log('  Tracked Link Fix Tests');
console.log('========================================\n');

const baseItem = { ContactID: '1', C_FirstName: 'John', C_City: 'New York', C_OrderID: 'ORD 001' };

// 1. Valid tracked_link
console.log('1. Valid tracked_link URL:');
{
    const { items } = simulateEnrichItems([baseItem], {
        message: 'Click here: [tracked-link]',
        tracked_link: 'https://example.com/promo'
    });
    assert(items[0].tracked_link_url === 'https://example.com/promo', 'tracked_link_url matches stored URL');
}

// 2. Empty string tracked_link
console.log('\n2. Empty string tracked_link:');
{
    const { items, warnings } = simulateEnrichItems([baseItem], {
        message: 'Click here: [tracked-link]',
        tracked_link: ''
    });
    assert(items[0].tracked_link_url === null, 'tracked_link_url is null for empty string');
    assert(warnings.includes('tracked_link_misconfiguration'), 'Slack warning fires for empty string');
}

// 3. Null tracked_link
console.log('\n3. Null tracked_link:');
{
    const { items, warnings } = simulateEnrichItems([baseItem], {
        message: 'Click here: [tracked-link]',
        tracked_link: null
    });
    assert(items[0].tracked_link_url === null, 'tracked_link_url is null for null value');
    assert(warnings.includes('tracked_link_misconfiguration'), 'Slack warning fires for null');
}

// 4. Whitespace-only tracked_link (trimming fix)
console.log('\n4. Whitespace-only tracked_link:');
{
    const { items, warnings } = simulateEnrichItems([baseItem], {
        message: 'Click here: [tracked-link]',
        tracked_link: '   '
    });
    assert(items[0].tracked_link_url === null, 'whitespace-only tracked_link treated as null after trim');
    assert(warnings.includes('tracked_link_misconfiguration'), 'Slack warning fires for whitespace-only');
}

// 5. tracked_link with merge fields — URL-encoded
console.log('\n5. tracked_link with merge fields (URL-encoded):');
{
    const { items } = simulateEnrichItems([baseItem], {
        message: 'Click here: [tracked-link]',
        tracked_link: 'https://example.com/?name=[C_FirstName]'
    });
    assert(items[0].tracked_link_url === 'https://example.com/?name=John', 'simple merge field replaced');
}

// 6. Merge field with special characters → URL-encoded
console.log('\n6. Merge field with special chars URL-encoded:');
{
    const { items } = simulateEnrichItems([baseItem], {
        message: 'Click: [tracked-link]',
        tracked_link: 'https://example.com/?city=[C_City]&order=[C_OrderID]'
    });
    const url = items[0].tracked_link_url;
    assert(url === 'https://example.com/?city=New%20York&order=ORD%20001',
        `special chars URL-encoded correctly: ${url}`);
}

// 7. Message without [tracked-link] — no warning even if tracked_link is empty
console.log('\n7. No [tracked-link] in message — no warning:');
{
    const { items, warnings } = simulateEnrichItems([baseItem], {
        message: 'Hello John, no link here',
        tracked_link: ''
    });
    assert(items[0].tracked_link_url === null, 'tracked_link_url is null');
    assert(!warnings.includes('tracked_link_misconfiguration'), 'No warning when message has no [tracked-link]');
}

// 8. tracked_link with leading/trailing whitespace — trimmed and used
console.log('\n8. tracked_link with surrounding whitespace:');
{
    const { items } = simulateEnrichItems([baseItem], {
        message: 'Click: [tracked-link]',
        tracked_link: '  https://example.com/page  '
    });
    assert(items[0].tracked_link_url === 'https://example.com/page', 'URL trimmed correctly');
}

// 9. saveConfiguration normalization: empty string → undefined
console.log('\n9. saveConfiguration: empty string → undefined:');
{
    const data = normalizeTrackedLink({ tracked_link: '' });
    assert(data.tracked_link === undefined, 'empty string normalized to undefined');
}

// 10. saveConfiguration normalization: valid URL → preserved
console.log('\n10. saveConfiguration: valid URL preserved:');
{
    const data = normalizeTrackedLink({ tracked_link: 'https://example.com' });
    assert(data.tracked_link === 'https://example.com', 'valid URL preserved as-is');
}

// 11. saveConfiguration normalization: whitespace-only → undefined
console.log('\n11. saveConfiguration: whitespace-only → undefined:');
{
    const data = normalizeTrackedLink({ tracked_link: '   ' });
    assert(data.tracked_link === undefined, 'whitespace-only normalized to undefined');
}

// 12. saveConfiguration normalization: URL with surrounding spaces → trimmed
console.log('\n12. saveConfiguration: URL with surrounding spaces → trimmed:');
{
    const data = normalizeTrackedLink({ tracked_link: '  https://example.com  ' });
    assert(data.tracked_link === 'https://example.com', 'URL trimmed on save');
}

// 13. saveConfiguration normalization: no tracked_link key → untouched
console.log('\n13. saveConfiguration: missing tracked_link key → untouched:');
{
    const data = normalizeTrackedLink({ message: 'Hello' });
    assert(!('tracked_link' in data), 'missing key left untouched (Object.assign won\'t overwrite DB value)');
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n========================================');
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

if (failed > 0) {
    process.exit(1);
}
