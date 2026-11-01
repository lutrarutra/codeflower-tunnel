import { answer, post, registerPasskey, returnedConfirmation, signInWithPasskey, withConfirmation } from './webauthn.js';

const $ = (id) => document.getElementById(id);

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}

function showNotice(message) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
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
  return answer(await fetch(path, { method }));
}

/** Sandboxes it runs, as "online · 2 sandboxes"; connectors that do not report them say only "online". */
function presence(connector) {
  if (!connector.online) return 'offline';
  if (connector.sandboxes === undefined) return 'online';
  return `online · ${connector.sandboxes} ${connector.sandboxes === 1 ? 'sandbox' : 'sandboxes'}`;
}

/** Shown in full: online with sandboxes, or online without saying how many. */
const active = (connector) => connector.online && connector.sandboxes !== 0;

/** Last seen, newest first: a connected one is seen now. */
const seen = (connector) => (connector.online ? Infinity : (connector.lastSeenAt ?? 0));

function connectorItem(connector) {
  const title = span(connector.name);
  if (connector.region === 'eu') title.append(span('EU only', 'badge eu'));
  title.append(span(presence(connector), connector.online ? 'badge online' : 'badge'));
  const details = span(
    `key ${connector.fingerprint} · ${connector.online ? 'connected' : 'last seen'} ${date(connector.lastSeenAt)}`,
    'muted'
  );
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
      await withConfirmation('delete-connector', connector.id, () => request(`/api/connectors/${encodeURIComponent(connector.id)}`, 'DELETE')).catch(
        (error) => error?.name !== 'NotAllowedError' && showError(error.message)
      );
      await renderConnectors();
    },
    'danger'
  );
  actions.append(open, revoke);
  return item(left, actions);
}

async function renderConnectors() {
  const list = $('connectors');
  const idle = $('idle');
  const connectors = (await request('/api/connectors', 'GET')).sort((a, b) => seen(b) - seen(a));
  const shown = connectors.filter(active);
  const collapsed = connectors.filter((connector) => !active(connector));
  list.replaceChildren(...shown.map(connectorItem));
  $('idle-connectors').replaceChildren(...collapsed.map(connectorItem));
  idle.hidden = collapsed.length === 0;
  $('idle-summary').textContent = `${collapsed.length} without sandboxes online`;
  if (connectors.length === 0) {
    list.append(item(span('None yet. Run codeflower tunnel login on the machine with your sandboxes.', 'muted')));
  } else if (shown.length === 0) {
    list.append(item(span('No sandboxes are online.', 'muted')));
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
            await withConfirmation('delete-passkey', key.id, () => request(`/api/passkeys/${encodeURIComponent(key.id)}`, 'DELETE')).catch(
              (error) => error?.name !== 'NotAllowedError' && showError(error.message)
            );
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
  // Nothing runs by itself on the way back: the user does it again.
  if (returnedConfirmation()) showNotice('Confirmed. Do it again within two minutes to finish.');
  $('passkey-login').addEventListener('click', guarded(async () => (await signInWithPasskey(), render())));
  $('passkey-create').addEventListener('click', guarded(async () => (await registerPasskey(), render())));
  $('passkey-add').addEventListener(
    'click',
    guarded(async () => {
      const me = await request('/api/me', 'GET');
      await withConfirmation('add-passkey', me.user.id, registerPasskey);
      await render();
    })
  );
  $('logout').addEventListener('click', guarded(async () => (await post('/auth/logout'), render())));
  $('logout-everywhere').addEventListener(
    'click',
    guarded(async () => {
      const me = await request('/api/me', 'GET');
      await withConfirmation('sign-out-everywhere', me.user.id, () => post('/api/me/sign-out-everywhere'));
      showNotice('Every other browser is signed out.');
    })
  );
  $('delete-account').addEventListener(
    'click',
    guarded(async () => {
      if (!confirm('Delete your account, its sign-in methods and all connectors? This cannot be undone.')) return;
      const me = await request('/api/me', 'GET');
      await withConfirmation('delete-account', me.user.id, () => request('/api/me', 'DELETE'));
      await render();
    })
  );
  render().catch((error) => showError(error.message));
});
