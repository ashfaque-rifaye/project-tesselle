# Outreach channels: email, AI phone calls, WhatsApp

Tesselle's outreach agent contacts makers and sellers for the customer. Each recipient gets its own
channel, chosen on the **Reach out** step (mix and match):

| Channel | What happens | Needs |
|---|---|---|
| **Email** | Sent from the connected Gmail inbox with privacy-checked photos attached. Replies (to the `TSL-xxxxxx` reference) are read from the inbox, turned into quotes and checked against the brief. The same inbox also feeds **Order history** (store order emails). | Gmail app password |
| **AI call** | The call agent phones the business: says it is an AI assistant calling for a customer, asks whether they can make it, each must-have, the price with delivery and the lead time. The transcript becomes a quote the fit checker verifies. | Twilio account + number |
| **WhatsApp** | On a phone, the share sheet sends the message *and* photos to WhatsApp; on a computer, WhatsApp opens with the message. | Nothing |

WhatsApp can't be sent fully automatically: Meta only lets a verified WhatsApp Business account start
conversations with businesses, using pre-approved templates.

## Privacy

- Only the brief is shared, never the customer's name, phone number or street address. Outgoing text is also
  scrubbed for email addresses and phone numbers.
- Photos are re-encoded, which removes camera data and GPS. Gemini then finds faces, people, documents, screens,
  addresses and number plates, and those regions are blurred. If the privacy scan fails, the photo is not sent.
- Email and calls use the owner's own inbox and phone line. A device can only use them after the
  **owner key** is entered there (menu → Connections), so visitors to the public demo can't send from them.

## One-time setup (about 10 minutes)

Run this script, then paste the owner key it prints into **menu → Connections** in Tesselle on each of your devices:

```
powershell -ExecutionPolicy Bypass -File tools\setup_channels.ps1
```

The script stores everything in Secret Manager in `tesselle-demandfoundry` and lets only the Cloud Run service
account read it. Nothing goes into the repo or the image, and no redeploy is needed.

### Email (free)
1. Turn on 2-Step Verification for the Google account (myaccount.google.com → Security).
2. Create an app password at myaccount.google.com/apppasswords. Name it "Tesselle"; it's 16 characters.
3. Enter the address and app password in the script.

Gmail's sending limit for personal accounts is about 500 emails a day. IMAP is on by default.

### AI phone calls: what's needed, and free-tier options

Tesselle's call agent uses **Twilio Programmable Voice**. Twilio handles the phone line, speech recognition
and the Google voice; Gemini decides what to say each turn. Webhooks are `/api/calls/{id}/voice|turn|status`
on Cloud Run, and every request is checked against Twilio's signature.

To connect it:
1. Sign up at twilio.com. A trial comes with free credit.
2. Get a phone number in the console (Phone Numbers → Buy a number; a US number works for calls to India).
3. Copy the **Account SID** and **Auth token** (console home → Account info).
4. Run the setup script and enter the SID, token and number.

Free-tier limits to know about:
- **Twilio trial:** calls only go to *verified* numbers (up to 5; your own number is verified automatically),
  and a short trial notice plays first. That's enough to demo the call agent calling your own phone, with you
  playing the maker. Calling real businesses needs an upgraded (pay-as-you-go) account. Trial rules:
  https://www.twilio.com/docs/usage/trials
- **Alternatives** if Twilio doesn't suit: Plivo and Vonage (trial credit, verified numbers only), Exotel (an
  Indian provider with Indian numbers; KYC needed), or hosted voice-agent platforms such as Vapi, Retell AI or
  ElevenLabs Agents (free credit). Those still need a telephony number and would replace the Gemini call logic,
  so Twilio is the simplest fit.
