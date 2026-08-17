/**
 * Shared helpers for the tests in this folder.
 * Checks are counted and summarized at the end.
 */

let passed = 0;
let failed = 0;
const failures = [];
let currentSection = '';

/** Compare expected and actual, print PASS or FAIL. */
function check(name, expected, actual) {
    const e = JSON.stringify(expected);
    const a = JSON.stringify(actual);
    if (e === a) {
        passed++;
        console.log(`  PASS  ${name}`);
    } else {
        failed++;
        console.log(`  FAIL  ${name}`);
        console.log(`         section: ${currentSection}`);
        console.log(`         expected: ${e}`);
        console.log(`         actual: ${a}`);
        failures.push({ section: currentSection, name });
    }
}

/** Print a section title. */
function section(title) {
    currentSection = title;
    console.log(`\n=== ${title} ===`);
}

/** Print the summary and set the exit code. */
function summary() {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failures.length) {
        console.log('Failures:');
        for (const f of failures) console.log(`  - [${f.section}] ${f.name}`);
        process.exitCode = 1;
    } else {
        console.log('All passed');
    }
}

module.exports = { check, section, summary };
