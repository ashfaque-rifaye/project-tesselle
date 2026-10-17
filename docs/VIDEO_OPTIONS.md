# Use-case videos - options explored

Goal: 2-3 short videos that show Tesselle working in real situations, made from the app's own visuals.

## Use cases worth filming

1. **"It has to fit the shelf"** - desk organiser, 18 cm limit, nothing in stock fits, a Chennai maker quotes,
   a 20 cm counteroffer is blocked. (Already scripted as the in-app guided demo.)
2. **"Buy it today"** - a phone accessory or charger that must match a device: real listings, best match, buy link.
3. **"Seen it, want it"** - a Ray-Ban Meta capture in a shop, spoken question, spoken answer on the phone app.

## Ways to make them

| Option | What it gives | Cost | Fit |
|---|---|---|---|
| **App's self-running demo + Playwright recording** (what we have) | Real UI, real agents, real search; we already compose it with Gemini TTS narration and captions | Free (Gemini calls on credits) | Best for truth. Needs one demo script per use case (about 1-2 h each). |
| **Veo on Vertex AI** (Veo 3.x text-to-video / image-to-video) | Cinematic 8 s B-roll: a shopper with smart glasses, a maker's workshop, a parcel arriving | Billed to Vertex AI (credits); roughly tens of US cents per second | Great for intro, outro and "real life" moments between UI shots; label as AI-generated. |
| **Remotion** (React to MP4, open source) | Animated explainer scenes built from our actual React components and styles | Free | Polished motion graphics from the real design system; renders locally. |
| **Canva Pro AI** (your account) | Templates, Magic Media clips, quick edits with brand kit | Included | Good for social cut-downs; manual assembly. |
| **Google Vids** (Workspace) | AI storyboard, stock footage, voice-over around imported screen recordings | Workspace plan | Quick narrated edits; manual. |
| **LTX Studio** | Storyboard-to-video generation | Free tier needs your sign-in | Optional for stylised scenes. |

## Recommendation

For each use case: record the real app with the self-running demo (truthful core), add 2-3 Veo B-roll shots for the
real-world moments, assemble with our ffmpeg composer (or Remotion for animated titles), and narrate with Gemini TTS.
All generation stays on Google Cloud credits; nothing is faked in the product footage.
