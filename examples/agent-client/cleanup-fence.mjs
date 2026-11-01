import { verifyCleanupFenceGate } from '../../scripts/recovery/verify-cleanup-fence.mjs';

/** Verifies a saved explicit recovery response; does not send device commands or start a new session. */
export async function verifyCleanupFenceReport({ deviceId, recoveryRoot, createdAt, responsePath }) {
  if (!responsePath) throw new Error('A saved complete cleanup-fence response is required.');
  const checked = await verifyCleanupFenceGate({ deviceId, recoveryRoot, createdAt, responsePath });
  if (!checked.release?.recoveryResponseSha256) throw new Error('The current owner is not the requested fence recovery.');
  return { releaseConfirmed: true, recoveryKind: 'cleanup_fence', ...checked.release, checkedFiles: checked.checkedFiles };
}
