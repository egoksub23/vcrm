# Rotating the encryption key

Halo encrypts the secrets it stores for you: WhatsApp, Gmail, Microsoft 365,
Messenger, Instagram, TikTok and Jira tokens, AI provider keys, webhook secrets
the web widget's identity secret, the Doc Sign sealing certificates and the answers to
Doc Sign form fields that a form marks **sensitive** (`sign_answers.value_enc`, an ID
number or bank account typed into a form). They are encrypted with AES-256-GCM using
a key from the server's environment, and the key can be rotated without anyone
reconnecting a channel.

## How it works

| Variable | What it is |
| --- | --- |
| `ENCRYPTION_KEY` | The original key (64 hex characters). Always readable. |
| `ENCRYPTION_KEYS` | More keys, written `id:hexkey` and separated by commas. An id is 1-32 letters, digits, `_` or `-`. |
| `ENCRYPTION_KEY_ID` | The id new secrets are written with. |

- With only `ENCRYPTION_KEY` set, nothing changes. New secrets keep the original
  format, so an older build can still read them.
- With `ENCRYPTION_KEY_ID` set, new secrets are stored as `v2:<id>:...`, naming
  the key they were written with. Every key in the ring stays readable, so
  rotating never makes a stored secret unreadable.
- Secrets stored earlier stay under the old key until they are rewritten. The
  **Stored secrets** card in the Platform console shows how many are on each
  key and rewrites them with **Re-encrypt now**.

The values are never shown anywhere: the card and its API return counts and key
ids only.

## Rotate a key

1. Generate a key:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. On every app instance, add it to the environment and keep the old key:

   ```bash
   ENCRYPTION_KEY=<the existing key, unchanged>
   ENCRYPTION_KEYS=2026a:<the new key>
   ENCRYPTION_KEY_ID=2026a
   ```

   Restart the app (these are read at runtime, no rebuild). **Every instance
   must have the new key before any of them starts writing with it**, or an
   instance without it cannot read what another wrote.

3. Open Platform, **Stored secrets**. It should say new secrets are written with
   key `2026a`. Press **Re-encrypt now** until it says everything is on the
   current key. If time runs out it says so; run it again.

4. Check the result line shows `0 unreadable`. An unreadable value is one no
   loaded key can decrypt; it is left untouched, and the customer re-enters it
   in Settings.

## Retire the old key

Only after step 4 above:

1. Remove `ENCRYPTION_KEY` from the environment, keeping `ENCRYPTION_KEYS` and
   `ENCRYPTION_KEY_ID`. Restart.
2. Open the card again and check nothing reports an error.

Keep the old key somewhere safe for as long as you keep database backups from
before the re-encrypt: those backups still hold secrets under the old key.

### If the old key leaked

Re-encrypting protects what is stored from now on. It does not protect copies of
the database taken while the old key was current. If the key itself leaked, also
treat the secrets as exposed: have customers reconnect their channels (which
issues fresh tokens), and rotate AI provider keys and webhook secrets.

## Roll back

While the old key is still configured, set `ENCRYPTION_KEY_ID=legacy` and press
**Re-encrypt now**: everything moves back to the original key and format.

Do not deploy a build older than this feature while any `v2:` value exists. It
cannot read them.

## Not included

Each workspace's secrets share the one key ring. Deriving a separate key per
workspace would limit what a single leaked key reveals, but the master key would
still reveal everything, so it is not done.
