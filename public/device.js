import { post, returnedConfirmation, withConfirmation } from './webauthn.js';

const $ = (id) => document.getElementById(id);

function show(id) {
  for (const section of ['sign-in', 'details', 'done']) $(section).hidden = section !== id;
}

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}

/** "2 minutes ago from 203.0.113.4": a code someone else asked for stands out. */
function requested(at, from) {
  if (!at) return 'unknown';
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  const when = minutes === 0 ? 'just now' : minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  return from ? `${when} from ${from}` : when;
}

async function decide(userCode, decision) {
  showError('');
  try {
    const send = () => post(`/api/device/${decision}`, { userCode });
    // Approving adds a computer to the account: confirmed with a passkey, or by signing in again.
    if (decision === 'approve') await withConfirmation('approve-device', userCode, send, `/device?code=${userCode}`);
    else await send();
    $('done-text').textContent =
      decision === 'approve' ? 'Approved. The connector finishes signing in by itself.' : 'Denied. The connector was not added.';
    show('done');
  } catch (error) {
    if (error?.name !== 'NotAllowedError') showError(error.message);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const userCode = (new URLSearchParams(location.search).get('code') ?? '').toUpperCase();
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode)) return showError('This link has no valid code. Use the link codeflower tunnel login printed.');
  const response = await fetch(`/api/device/${encodeURIComponent(userCode)}`);
  if (response.status === 401) {
    try {
      sessionStorage.setItem('cft_next', location.pathname + location.search);
    } catch {
      // Without storage, the user comes back by opening the link again.
    }
    return show('sign-in');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return showError(result.error ?? 'This code is unknown or expired.');
  if (returnedConfirmation()) $('confirmed').hidden = false;
  $('code').textContent = userCode;
  $('name').textContent = result.name;
  $('region').textContent = result.region === 'eu' ? 'EU datacenters only' : 'Nearest datacenter';
  $('fingerprint').textContent = result.fingerprint;
  $('requested').textContent = requested(result.requestedAt, result.requestedFrom);
  $('approve').addEventListener('click', () => decide(userCode, 'approve'));
  $('deny').addEventListener('click', () => decide(userCode, 'deny'));
  show('details');
});
