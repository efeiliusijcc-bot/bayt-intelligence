import crypto from 'node:crypto';
import os from 'node:os';

export const agentId = `local-ego-${os.hostname().replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`;

export function localPageInput(page) {
  const m = page.manifest;
  if (m?.page !== page.page || m.selectedCount !== page.count || m.cvIdSetSha256 !== page.cvIdSetSha256 ||
    !m.verification?.exactMatch || m.verification.zipCrcFailures !== 0 || m.verification.pdfEntries !== m.selectedCount)
    throw Error('LOCAL_PAGE_EVIDENCE_INVALID');
  return { page: page.page, selectedCount: m.selectedCount, cvIdSetSha256: m.cvIdSetSha256,
    excelSha256: m.files.excel.sha256, excelSizeBytes: m.files.excel.sizeBytes,
    pdfSha256: m.files.pdfArchive.sha256, pdfSizeBytes: m.files.pdfArchive.sizeBytes,
    pdfEntries: m.verification.pdfEntries, zipCrcOk: true };
}

export function verificationId(marker) {
  return crypto.createHash('sha256').update(JSON.stringify([marker.jobId, marker.at, marker.code, marker.rayId])).digest('hex');
}

export async function controlRequest(route, body, leaseToken) {
  const url = (process.env.BAYT_CONTROL_URL || '').replace(/\/$/, '');
  const token = process.env.BAYT_CONTROL_AGENT_TOKEN || '';
  if (!/^https:\/\//.test(url) || token.length < 32) throw Error('QUEUE_CONFIG_REQUIRED');
  const response = await fetch(`${url}/api/v1/collector/agent${route}`, {
    method: 'POST', signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      ...(leaseToken ? { 'x-collector-lease': leaseToken } : {}) }, body: JSON.stringify(body),
  });
  if (!response.ok) {
    // Do not echo response bodies: a proxy could reflect request credentials.
    const data = await response.json().catch(() => null);
    const code = /^[A-Z0-9_]+$/.test(data?.error?.code || '') ? data.error.code : 'REQUEST_FAILED';
    throw Error(`CONTROL_HTTP_${response.status}_${code}`);
  }
  return response.status === 204 ? null : response.json();
}
