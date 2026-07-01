# Apple root certificates (required for verifying iOS purchases)

The backend verifies every Apple in-app purchase by checking its signature against
Apple's public root certificate. Without the cert here, the server **refuses to grant
Apple purchases** (fail-closed) — this is deliberate: it's what stops forged/free purchases.

## What to add (one file)

Download **Apple Root CA - G3** and drop it in this folder:

1. Go to https://www.apple.com/certificateauthority/
2. Under "Apple Root Certificates", download **Apple Root CA - G3 Root** (`AppleRootCA-G3.cer`).
3. Put that `AppleRootCA-G3.cer` file in this `apple-certs/` folder.
4. Commit/push it to the backend repo so Render has it. (Public cert — safe to commit.)

That single cert is enough for StoreKit 2 transaction verification. You may optionally
also add `AppleRootCA-G2.cer` from the same page.

## Related Render environment variables

- `APPLE_VERIFY` — leave unset or `full` for production (verifies, fails closed).
  Only set to `decodeonly` for sandbox bring-up, and never in production.
- `APPLE_ENVIRONMENT` — `sandbox` (default) while testing; set to `production` when live.
- `APPLE_APP_APPLE_ID` — your numeric App Store app id (default 6784852955).
- `APPLE_ROOT_CERT_DIR` — optional; defaults to this folder.

## Important

Until this cert is in place, **switch the iOS app to Manual release** in App Store Connect
so it can't go live before purchase verification works — otherwise approved-and-released
users could be charged by Apple but not receive their credits.
