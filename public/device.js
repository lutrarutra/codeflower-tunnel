import { post } from './webauthn.js';

const $ = (id) => document.getElementById(id);

function show(id) {
  for (const section of ['sign-in', 'details', 'done']) $(section).hidden = section !== id;
}

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}

async function decide(userCode, decision) {
  showError('');
  try {
    await post(`/api/device/${decision}`, { userCode });
    $('done-text').textContent =
      decision === 'approve' ? 'Approved. The connector finishes signing in by itself.' : 'Denied. The connector was not added.';
    show('done');
  } catch (error) {
    showError(error.message);
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
  $('code').textContent = userCode;
  $('name').textContent = result.name;
  $('region').textContent = result.region === 'eu' ? 'EU datacenters only' : 'Nearest datacenter';
  $('fingerprint').textContent = result.fingerprint;
  $('approve').addEventListener('click', () => decide(userCode, 'approve'));
  $('deny').addEventListener('click', () => decide(userCode, 'deny'));
  show('details');
});
