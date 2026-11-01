// Passkeys with the browser's own JSON helpers (no third-party script).

function supported() {
  return (
    typeof PublicKeyCredential !== 'undefined' &&
    typeof PublicKeyCredential.parseCreationOptionsFromJSON === 'function' &&
    typeof PublicKeyCredential.parseRequestOptionsFromJSON === 'function'
  );
}

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? '{}' : JSON.stringify(body)
  });
  return answer(response);
}

/** The JSON of a response; an error with the tunnel's `error` code otherwise. */
async function answer(response) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.message ?? result.error ?? `Request failed (${response.status})`);
    error.code = result.error;
    throw error;
  }
  return result;
}

/** Creates a passkey: for the signed-in account, or a new account when signed out. */
export async function registerPasskey() {
  if (!supported()) throw new Error('This browser cannot create passkeys here. Update it or use GitHub or Google.');
  const options = await post('/auth/passkey/register/options');
  const credential = await navigator.credentials.create({
    publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options)
  });
  await post('/auth/passkey/register/verify', credential.toJSON());
}

export async function signInWithPasskey() {
  if (!supported()) throw new Error('This browser cannot use passkeys here. Update it or use GitHub or Google.');
  const options = await post('/auth/passkey/login/options');
  const credential = await navigator.credentials.get({
    publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options)
  });
  await post('/auth/passkey/login/verify', credential.toJSON());
}

export { post };

/**
 * Runs an action that may need the user to confirm it just now: deleting the
 * account or a computer, approving one, adding or removing a passkey. The
 * session alone does not do: code on this origin (the pages paired computers
 * serve under /m/) has it too. Confirms with a passkey of the account, or by
 * signing in again with GitHub or Google, which leaves the page: it comes
 * back to `next` saying so (see returnedConfirmation), and the user runs the
 * action again within two minutes.
 */
export async function withConfirmation(action, target, run, next = '/') {
  try {
    return await run();
  } catch (error) {
    if (error.code !== 'confirm_required') throw error;
  }
  const how = await post('/auth/confirm/options', { action, target });
  if (how.method === 'passkey') {
    if (!supported()) throw new Error('This browser cannot use passkeys here. Update it to confirm this.');
    const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(how.options) });
    await post('/auth/confirm/verify', credential.toJSON());
    return run();
  }
  const provider = how.providers?.[0];
  if (!provider) throw new Error('Add a passkey, or link GitHub or Google, to confirm this.');
  location.assign(`/auth/${provider}/confirm?${new URLSearchParams({ action, target, next })}`);
  return new Promise(() => {});
}

/** Whether the page came back from confirming by signing in again; the address loses it. */
export function returnedConfirmation() {
  const query = new URLSearchParams(location.search);
  if (!query.has('confirmed')) return false;
  query.delete('confirmed');
  const rest = query.toString();
  history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}`);
  return true;
}

export { answer };
