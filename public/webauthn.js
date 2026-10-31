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
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
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
