#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { verifyTouchReceipt } from './pi30141-touch-verifier.mjs';

// Deployment must pass the candidate directory and its Windows receipt explicitly.
// No environment switch or successful end-state-only receipt can bypass this check.
const [rootInput, receiptPath] = process.argv.slice(2);
if (!rootInput || !receiptPath || process.argv.length !== 4) throw new Error('Usage: node scripts/qa/windows-touch-deployment-gate.mjs CANDIDATE_ROOT WINDOWS_RECEIPT.json');
const root = resolve(rootInput);
const buildId = (await readFile(join(root, '.next/BUILD_ID'), 'utf8')).trim();
const receipt = JSON.parse(await readFile(resolve(receiptPath), 'utf8'));
const assetPath = new URL(receipt.build?.assetFingerprint?.url, 'http://localhost').pathname;
if (!/^\/pi-web-assets\/enhancements-[a-f0-9]{16}\.js$/.test(assetPath)) throw new Error('Invalid enhancement resource path');
const bytes = await readFile(join(root, 'public', assetPath));
const sha256 = createHash('sha256').update(bytes).digest('hex');
if (!assetPath.endsWith(`enhancements-${sha256.slice(0,16)}.js`)) throw new Error('Candidate asset name does not match its bytes');
const result = verifyTouchReceipt(receipt, { expectedBuildId: buildId, expectedAssetSha256: sha256 });
console.log(JSON.stringify({ ...result, receiptSha256: createHash('sha256').update(await readFile(resolve(receiptPath))).digest('hex') }));
