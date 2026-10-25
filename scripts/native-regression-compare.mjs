import assert from 'node:assert/strict';
import fs from 'node:fs';

const [baselinePath, currentPath] = process.argv.slice(2);
if (!baselinePath || !currentPath) {
  console.error('usage: node scripts/native-regression-compare.mjs <baseline.json> <current.json>');
  process.exit(2);
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const baseline = read(baselinePath);
const current = read(currentPath);

const summary = (payload) => Object.fromEntries(Object.entries(payload.cases).map(([key, value]) => [key,
  value && value.hits
    ? `${value.hits.length} hits${value.done ? '' : ' (incomplete)'}`
    : value && value.startError
      ? `startError: ${value.startError}`
      : value && value.timeout ? 'timeout' : 'basic']));

console.log('baseline:', baseline.addon, baseline.addonBytes, 'bytes');
console.log('current :', current.addon, current.addonBytes, 'bytes');
console.table(summary(baseline));
console.table(summary(current));

try {
  assert.deepStrictEqual(current.cases, baseline.cases);
  console.log('RESULT: cases are byte-for-byte identical after JSON normalization');
} catch (error) {
  console.error('RESULT: DIFFERENT');
  console.error(error.message.slice(0, 8000));
  process.exit(1);
}
