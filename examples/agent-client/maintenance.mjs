import { verifyMaintenanceRelease } from '../../scripts/recovery/verify-maintenance.mjs';

// Explicit local verification after manual maintenance; this never sends an agent RPC.
// The caller supplies the original device, trusted recovery root, start time and saved CLI response.
export async function verifyMaintenanceReport({ deviceId, recoveryRoot, createdAt, responsePath }) {
  if (typeof responsePath !== 'string' || !responsePath) throw new Error('Provide the saved complete maintenance response.');
  const evidence = await verifyMaintenanceRelease({ deviceId, recoveryRoot, createdAt, responsePath });
  return { releaseConfirmed: true, ...evidence };
}
