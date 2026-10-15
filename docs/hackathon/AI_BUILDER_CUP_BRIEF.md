# Google Cloud AI Builder Cup 2026 — Hackathon Brief

Sources: [aibuildercup.com](https://aibuildercup.com/) (Overview, Themes, Rewards, FAQs), the
intro livestream ([mhDd6qSBMg4](https://www.youtube.com/live/mhDd6qSBMg4)) and the "Ask the Expert"
livestream ([_75UeGNj1GY](https://www.youtube.com/live/_75UeGNj1GY)). Full transcripts are in
[transcripts/](transcripts/). Compiled 16 Oct 2026.

Run by Hack2skill, sponsored by Google Cloud (JAPAC). "Build in JAPAC. Build for the world."

## Hard deadlines

| Date (2026) | What |
|---|---|
| **16 Oct** | Team formation closes (reopened to this date). **No team = submission section stays locked.** |
| **18 Oct** | Prototype submission deadline. Organisers said there will be **no extension**. |
| 19 Oct – 6 Nov | Evaluation. Judges may open the deployed app on **any day** in this window. |
| 7 Nov | Top 50 finalists announced. |
| 4 Dec | Grand Finale (Demo Day), Singapore. Two members travel; flights, stay and meals sponsored, visas self-managed. |

## Eligibility

- Working professionals, entrepreneurs, startups; age 21+; all members based in JAPAC.
- **No students.** One student member disqualifies the whole team, even after shortlisting.
- Teams of **2–4**. Solo participation is not allowed (solo registration then joining a team is fine).
- One submission per team, under one theme. Fresh work built during the hackathon window only.
- IP stays with the team. Participation is free.

## Themes (choose one)

1. BFSI — risk, fraud and financial experiences
2. **Retail & Commerce — intelligent customer and business experiences** (discovery, personalisation,
   conversational shopping, demand planning, inventory, customer insights)
3. Manufacturing — operations and industrial efficiency
4. Media, Content & Digital Experiences
5. Future of Work & Enterprise Productivity
6. Sustainability & Social Impact

DemandFoundry (Project Tesselle) fits **Retail & Commerce**: conversational shopping, personalised
discovery, inventory visibility and turning unmet demand into custom/sourced offers. The theme
alignment must be explained explicitly in the deck.

## Mandatory submission items (missing any one = disqualified)

1. **Pitch deck (PDF)** — vision, problem and who benefits, alignment to the chosen theme,
   feasibility, scalability/production path, user guide for the prototype.
2. **Demo video** — public YouTube / Vimeo / Google Drive link. Site says 3 min; FAQ says
   "under 3 minutes"; the second livestream said "3 to 4 minutes". **Target ≤ 3:00.**
3. **Deployed prototype link** — must be a **Cloud Run or Firebase** URL (use the `run.app` or
   `web.app` URL, not a custom domain). Must stay functional through evaluation; if APIs or
   integrations are down when judges test, the entry is disqualified.
4. **Public GitHub repository.**
5. **Brief description** — must state how the Google stack is used (Gemini, Cloud Run, Firebase,
   Firestore, Agent Platform…).
6. Theme / category selection. Everything in **English**.

## Judging (same for all themes)

| Weight | Criterion | What they said they look for |
|---|---|---|
| **40%** | Technical merit & Gen AI implementation | Meaningful AI use, not "send a prompt, get a reply". Technical implementation, scalability, sustainability. |
| 25% | Problem alignment & impact | Clear tie to the theme; real impact. |
| 25% | Innovation & creativity | Original, differentiated, novel use of Gen AI. |
| 10% | User experience & solution design | Usable, accessible, gets the user to value — not just a flashy UI. |

Special awards (USD 2,000 each): **Best use of Google Cloud AI tools**, Most Impactful Solution,
Social/Jury Choice, **Best UI/UX**. Main prizes USD 10k / 7k / 5k.

## Technology rules and expert guidance

- **Must use Gemini** (or Gemma) for reasoning. Own models alongside Gemini are fine; replacing
  Gemini entirely is not.
- **Must deploy on Cloud Run or Firebase.** Backend pieces elsewhere are tolerated, but the URL
  judges click must be Cloud Run/Firebase.
- "Agent Platform" (Gemini Enterprise Agent Platform — formerly Vertex AI) is expected: the expert
  said to use agent runtime, **Memory Bank**, sessions, agent identity or similar. **ADK 2.0**
  (Python or TypeScript) counts as Agent Platform and is recommended but not scored by itself.
- Google's suggested starter stack: **Gemini 3.8 Flash + ADK + Cloud Run + Firestore**
  (Cloud SQL / BigQuery / AlloyDB when the use case needs them).
- RAG: Firestore vector search is fine at prototype scale; AlloyDB AI + ScaNN for very large,
  low-latency vector sets.
- Grounding: if the agent answers only from your own data through tools, strong guardrails are
  enough; otherwise add Google Search grounding. Document data sources and guardrails.
- Use evals to show outputs are correct, and say so in the submission.

## Do / don't (from the "Ask the Expert" session)

- **Never commit secrets.** Credentials, API keys, env values or `gcloud deploy` commands with
  secrets in the repo or video = disqualification. Use Secret Manager / env vars.
- Prefer **no login wall**. If sign-in is essential, give test credentials in the docs.
- Give judges **sample inputs/questions that you know work**, the dataset, and any limits
  (e.g. "max 5 questions"). Stated limits help rather than hurt.
- Clearly labelled synthetic or simulated data is acceptable.
- Cloud Run: scale-to-zero is fine; raise the request timeout to cover the slowest agent run.
  Optionally raise min instances during the evaluation window.
- Engineering wins (latency under N seconds, multi-tool orchestration, eval results) should be
  mentioned in the video/deck — but never claim what isn't true.
- After the deadline only push **non-feature critical fixes**; never break the live app.
- Video: clear, loud audio; the product must match the app judges can open. Opening with the live
  product then walking through architecture was the expert's personal suggestion.
- Top reasons strong prototypes lose points: doubtful real-world feasibility, staying too basic,
  and judges not seeing the value clearly.

## Contacts

support+aibuildercup@hack2skill.com · +91 98703 30830 · Discord https://discord.gg/x5GRzJbKpa ·
Dashboard: https://hack2skill.com/event/aibuildercup2026/registration
