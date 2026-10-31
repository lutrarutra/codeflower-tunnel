# Security

## Reporting

Please report vulnerabilities privately through GitHub's
[security advisories](https://github.com/lutrarutra/codeflower-tunnel/security/advisories/new),
not in public issues.

## What the tunnel protects, and what it does not

- **Content**: end-to-end encrypted between browser and connector. The tunnel, its operator and
  Cloudflare see only ciphertext.
- **Metadata**: the tunnel sees accounts, connector names, IP addresses, and when and how much
  traffic flows.
- **Signing in** to the tunnel lets a browser reach a connector, but reading anything requires
  the keys from pairing that browser with the connector.
- **The bootstrap page is a residual risk.** A compromised tunnel could serve a page that leaks
  keys. Its published hash and `codeflower tunnel verify` narrow this risk but cannot remove it in a browser;
  the local `codeflower client` page stays the fully trusted way in.
- **A paired device that is stolen** can control your agents, i.e. run code inside your
  sandboxes. Revoke it with `codeflower tunnel revoke`, or cut all remote access with
  `codeflower tunnel off`. `tunnel.hardened: true` limits each paired browser to chosen workers
  and confines the connector process.

The design and threat model are in the workspace's `docs/architecture.md`.
