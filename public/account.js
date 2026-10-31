import { post, registerPasskey, signInWithPasskey } from './webauthn.js';

const $ = (id) => document.getElementById(id);

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}

function item(...children) {
  const li = document.createElement('li');
  li.append(...children);
  return li;
}

function span(text, className) {
  const element = document.createElement('span');
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(label, onClick, className) {
  const element = document.createElement('button');
  element.textContent = label;
  if (className) element.className = className;
  element.addEventListener('click', onClick);
  return element;
}

const date = (ms) => (ms ? new Date(ms).toLocaleString() : 'never');

/** After signing in, go back to a device approval that asked for it. */
function resumeNext() {
  let next;
  try {
    next = sessionStorage.getItem('cft_next');
    sessionStorage.removeItem('cft_next');
  } catch {
    return false;
  }
  if (next && (next.startsWith('/device?') || next === '/p')) {
    location.assign(next);
    return true;
  }
  return false;
}

async function request(path, method) {
  const response = await fetch(path, { method });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
  return result;
}

async function renderConnectors() {
  const list = $('connectors');
  const connectors = await request('/api/connectors', 'GET');
  list.replaceChildren();
  if (connectors.length === 0) {
    list.append(item(span('None yet. Run codeflower tunnel login on the machine with your sandboxes.', 'muted')));
    return;
  }
  for (const connector of connectors) {
    const title = span(connector.name);
    if (connector.region === 'eu') title.append(span('EU only', 'badge eu'));
    title.append(span(connector.online ? 'online' : 'offline', connector.online ? 'badge online' : 'badge'));
    const details = span(`key ${connector.fingerprint} · last seen ${date(connector.lastSeenAt)}`, 'muted');
    const left = document.createElement('div');
    left.append(title, document.createElement('br'), details);
    const open = document.createElement('a');
    open.className = 'button';
    open.href = `/m/${encodeURIComponent(connector.id)}/`;
    open.textContent = 'Open';
    const actions = document.createElement('div');
    actions.className = 'row';
    const revoke = button(
      'Revoke',
      async () => {
        if (!confirm(`Revoke ${connector.name}? It must sign in again, and paired browsers must pair again.`)) return;
        await request(`/api/connectors/${encodeURIComponent(connector.id)}`, 'DELETE').catch((error) => showError(error.message));
        await renderConnectors();
      },
      'danger'
    );
    actions.append(open, revoke);
    list.append(item(left, actions));
  }
}

async function render() {
  const me = await request('/api/me', 'GET');
  $('github').hidden = !me.providers.github;
  $('google').hidden = !me.providers.google;
  $('signed-out').hidden = Boolean(me.user);
  $('signed-in').hidden = !me.user;
  if (!me.user) return;
  if (resumeNext()) return;

  $('name').textContent = me.user.displayName;
  const linked = new Set(me.identities.map((identity) => identity.provider));
  $('link-github').hidden = !me.providers.github || linked.has('github');
  $('link-google').hidden = !me.providers.google || linked.has('google');

  const methods = $('methods');
  methods.replaceChildren(
    ...me.identities.map((identity) => item(span(identity.provider === 'github' ? 'GitHub' : 'Google'), span(`linked ${date(identity.createdAt)}`, 'muted'))),
    ...me.passkeys.map((key) =>
      item(
        span(`Passkey added ${date(key.createdAt)}`),
        button(
          'Remove',
          async () => {
            if (me.passkeys.length + me.identities.length <= 1) return showError('This is your only way to sign in. Add another first.');
            await request(`/api/passkeys/${encodeURIComponent(key.id)}`, 'DELETE').catch((error) => showError(error.message));
            await render();
          },
          'danger'
        )
      )
    )
  );
  await renderConnectors();
}

function guarded(action) {
  return async () => {
    showError('');
    try {
      await action();
    } catch (error) {
      if (error?.name !== 'NotAllowedError') showError(error.message ?? String(error));
    }
  };
}

document.addEventListener('DOMContentLoaded', () => {
  const error = new URLSearchParams(location.search).get('error');
  if (error) {
    showError(error);
    history.replaceState(null, '', '/');
  }
  $('passkey-login').addEventListener('click', guarded(async () => (await signInWithPasskey(), render())));
  $('passkey-create').addEventListener('click', guarded(async () => (await registerPasskey(), render())));
  $('passkey-add').addEventListener('click', guarded(async () => (await registerPasskey(), render())));
  $('logout').addEventListener('click', guarded(async () => (await post('/auth/logout'), render())));
  $('delete-account').addEventListener(
    'click',
    guarded(async () => {
      if (!confirm('Delete your account, its sign-in methods and all connectors? This cannot be undone.')) return;
      await request('/api/me', 'DELETE');
      await render();
    })
  );
  render().catch((error) => showError(error.message));
});
