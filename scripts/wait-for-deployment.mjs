import {setTimeout as sleep} from 'node:timers/promises';

const id = process.env.SYNC_REQUEST_ID;
const primary = process.env.YANYUAD_PUBLIC_BASE_URL?.replace(/\/$/, '');
const pages = 'https://yanyuad.pages.dev';
if (!id || !primary) throw Error('Missing YANYUAD_PUBLIC_BASE_URL or SYNC_REQUEST_ID');
if (![pages, 'https://ad.fakeyou.eu.org'].includes(primary)) throw Error('Unexpected public base URL');

const origins = [...new Set([primary, pages])];
const deadline = Date.now() + 20 * 60 * 1000;

async function verify(origin) {
  const response = await fetch(`${origin}/status.json?t=${Date.now()}`, {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  const status = await response.json();
  if (status?.brand !== 'YanyuAd' || !Number.isSafeInteger(status.total) || status.total <= 0) {
    throw Error('Invalid status payload');
  }
  const summary = `request_id=${status.request_id} total=${status.total} scheduler=${status.scheduler_enabled}`;
  if (status.request_id !== id || status.scheduler_enabled !== true) throw Error(summary);
  return summary;
}

for (;;) {
  const failures = [];
  let verified = false;
  for (const origin of origins) {
    try {
      const status = await verify(origin);
      if (failures.length) console.warn(failures.join(' | '));
      console.log(`Deployment verified via ${origin}: ${status}`);
      verified = true;
      break;
    } catch (error) {
      const cause = error.cause?.code;
      failures.push(`${origin}: ${error.message}${cause ? ` (${cause})` : ''}`);
    }
  }
  if (verified) break;
  const details = failures.join(' | ');
  if (Date.now() >= deadline) throw Error(`Timed out waiting for deployment: ${details}`);
  console.log(`Waiting for deployment: ${details}`);
  await sleep(Math.min(45000, deadline - Date.now()));
}
