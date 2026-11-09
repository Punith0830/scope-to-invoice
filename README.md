# Scope-to-Invoice

A local hackathon app that compares a synthetic written agreement with completed-work notes, shows the evidence for each suggested charge, and verifies a PayPal sandbox draft after the reviewer confirms the selected charges.

## Run locally

Use Node.js 24. The app uses native HTTP, fetch, and SQLite. There are no package dependencies to install.

1. Open PowerShell in this app folder. If `.env` is missing, run `Copy-Item .env.example .env`.
2. Create a key in Google AI Studio and set `GEMINI_API_KEY` in `.env`. The app uses Gemini 3.1 Flash-Lite, which has a free tier. If you already use OpenAI, set `OPENAI_API_KEY` instead and leave `GEMINI_API_KEY` blank. The OpenAI option defaults to `gpt-4o-mini`.
3. Set `PAYPAL_SANDBOX_CLIENT_ID` and `PAYPAL_SANDBOX_CLIENT_SECRET` from your PayPal Developer Dashboard **Sandbox** app. Set `PAYPAL_SANDBOX_BUYER_EMAIL` to your sandbox personal account email.
4. Run the command below. Open the local URL the app prints.

```powershell
node --env-file=.env server.mjs
```

Keep `.env` and `demo.sqlite` local. The app binds to loopback and serves only its public files. Use synthetic records. The comparison sends the two records to Google when a Gemini key is set, or to OpenAI when only an OpenAI key is set. The PayPal request includes the confirmed item names and amounts, sandbox buyer email, and invoice reference.

## Verify the demo

1. Click **Compare records** with the supplied workshop and social graphics example.
2. Review the cited agreement and work notes. The workshop and summary should be eligible at USD 600. The social graphics should be excluded because there is no agreed price.
3. Confirm the supported charge. The app creates a sandbox draft and reads it back. The verified outcome requires the expected draft ID, invoice reference, DRAFT status, exact line items and total.
4. Compare the returned ID with the invoice in the sandbox account before recording the demo.

This build supports fixed USD fees, with one priced deliverable or bundle per agreement line and a separate excerpt documenting completion. The server checks that both excerpts occur in the records and derives amounts from the cited agreement line. The reviewer checks whether the excerpts support the actual proposed item. The API serves the stored comparison snapshot, so edited or unresolved amounts cannot be substituted into the PayPal payload.

The demo keeps one create attempt in a local SQLite file. A pending or uncertain attempt survives restart and holds further creates. For a known draft ID, **Verify existing draft** only reads that invoice. Use the invoice reference to reconcile an unknown outcome in the PayPal sandbox dashboard. After reconciliation, preserve the old SQLite file and use a fresh app copy or a fresh state file for a new demo session. The flow ends at sandbox draft creation and verification.

## Local checks

```powershell
node --test app.test.mjs
```

The automated checks use the local HTTP server and controlled provider responses. To verify your own credentials and setup, run the demo with the configured providers.

[Google AI Studio API keys](https://aistudio.google.com/api-keys) · [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing?frmapp=yes) · [PayPal sandbox invoicing quickstart](https://developer.paypal.com/api/invoicing) · [Devpost requirements](https://paypalaihackathon.devpost.com/#what-to-submit)
