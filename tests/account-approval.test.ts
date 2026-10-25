import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueApproval, verifyApproval } from '../lib/auth/approval-policy.ts';

test('approval signatures bind the target, admin, expiration and random nonce', () => {
  process.env.ACCOUNT_APPROVAL_SECRET = 'isolated-fixture-signing-secret-over-32-characters';
  const now = Date.now(), token = issueApproval('target', 'admin', now);
  assert.equal(verifyApproval(token, 'admin', now)?.user, 'target');
  assert.equal(verifyApproval(token, 'other-admin', now), null);
  assert.equal(verifyApproval(token, 'admin', now + 86400000), null);
  const [payload, signature] = token.split('.');
  const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), user: 'attacker' })).toString('base64url');
  assert.equal(verifyApproval(`${altered}.${signature}`, 'admin', now), null);
  assert.equal(verifyApproval(token + '.extra', 'admin', now), null);
  assert.equal(verifyApproval('x'.repeat(2049), 'admin', now), null);
  assert.notEqual(issueApproval('target', 'admin', now), token);
});
