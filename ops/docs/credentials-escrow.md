# Credentials escrow (ops-kit) — the keys that no database backup covers

A database restore brings the data back. It does **not** bring back the
mobile app's signing keys, the push-notification keys, the store and cloud
service accounts or the logins that own them. Losing a signing key means no
update to a published app can ever ship again; losing a cloud console login
means days of recovery. Those items live in consoles and on whichever laptop
exported them last — this register and the escrow bundle are how they
survive a person leaving, a laptop dying, or the server burning.

## 1. How it works

```
<repo>/.escrow/            staging area on the app server (git-ignored, chmod 700)
ops/bin/escrow.sh check    every required item (ops/escrow.manifest) present?
ops/bin/escrow.sh seal     AES-256 bundle → <BACKUP_DIR>/escrow/escrow-<host>-<date>.tar.enc
backup.sh <tier> backup    re-seals nightly and carries the bundle off-box with everything else
healthcheck.sh             `escrow` check: FAIL when no bundle exists or the newest is > 100 days old
ops/bin/escrow.sh open     DR / drill: decrypt into <repo>/restored-escrow/
```
Encrypted with `BACKUP_DATA_PASSPHRASE` (or `BACKUP_CONFIG_PASSPHRASE`). The
passphrases are never inside the bundle (`seal` refuses if it finds one).

## 2. Two-custodian rule (every secret in this document)

| Rule | Why |
|---|---|
| Every vault entry is shared with **two named people**. | One person leaving, losing a phone or being unreachable must not lock the organisation out. |
| The three backup passphrases are also printed into a **sealed, dated envelope in the company safe**; opening it is logged. | The vault may be unavailable in the same incident that destroys the server. |
| 2FA **recovery codes** for every account in §3 live in that account's vault entry. | 2FA on a lost phone is the most common way to lose a developer account. |
| Accounts are owned by **role mailboxes on the company domain**, never personal addresses. | Ownership must survive any individual. |
| On a custodian leaving: rotate every password and re-seal within 5 working days. Keys (keystores, .p8) are not rotated unless compromised. | Keys are bound to the published app; passwords are not. |

## 3. Register — EDIT FOR THIS PROJECT

Delete rows the project does not have; add its own. Every row must also be
described in `.escrow/accounts/accounts.md` with the vault entry name, the two
custodians and where the 2FA recovery codes are.

### 3a. Keys (files) → `.escrow/`

| Item | File | How to export |
|---|---|---|
| Android upload keystore + passwords | `mobile/credentials.json`, `mobile/*.jks` | `eas credentials --platform android` → *Download credentials to credentials.json* (Expo); or the keystore your CI signs with |
| Apple APNs key | `mobile/AuthKey_<KEYID>.p8` | developer.apple.com → Keys (downloadable once) or `eas credentials --platform ios` |
| App Store Connect API key | `mobile/AuthKey_<KEYID>.p8` + `mobile/asc-api-key.txt` (Key ID, Issuer ID) | App Store Connect → Users and Access → Integrations |
| Google Play API service account | `mobile/play-service-account.json` | Google Cloud → IAM → Service accounts → Keys |
| Firebase Cloud Messaging V1 key | `cloud/fcm-v1-service-account.json` | Firebase → Project settings → Service accounts |
| Any other service-account key (object storage, DNS API, mail API, payment gateway …) | `cloud/<name>.json` | the provider's console |

### 3b. Accounts (register only; passwords stay in the vault)

Expo/EAS org · Apple Developer Program (renewal date!) · Google Play Console ·
Firebase project · GitHub org/repo (+ the server's deploy key) · error/crash
reporting · domain registrar + DNS · TLS CA account · the SMTP/alert mailbox
· NAS admin + backup account · every integration partner's shared key ·
server root/deploy login + provider console.

### 3c. Never in the escrow
The three backup passphrases (vault + envelope only); application data.

## 4. Procedure

1. **Once:** `ops/bin/escrow.sh init` → export every §3a item → write `accounts/accounts.md` → `escrow.sh check` (no MISSING) → `escrow.sh seal`.
2. The nightly backup re-seals automatically; the watchdog turns red when the newest bundle is > 100 days old — **re-run `check` + `seal` at least quarterly** and after any key/account change.
3. **Quarterly drill:** `escrow.sh open <newest>` with the passphrase from the **vault**; `check` passes against the decrypted folder; delete `restored-escrow/`. Yearly, open the envelope instead of the vault, then re-seal a fresh envelope.
4. **DR:** after `restore-config` and the database restore, open the newest bundle only if the cloud accounts themselves were lost; re-upload keys to the build service from the decrypted files.

## 5. Ownership

| Role | Person |
|---|---|
| Custodian A | |
| Custodian B | |
| Envelope holder (outside IT) | |
| Register last reviewed | |
