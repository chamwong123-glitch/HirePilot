# AI coach proxy

`coach-worker.js` is a Cloudflare Worker that sits between the app and OpenRouter. It keeps the OpenRouter key out of the web page, writes the coaching prompts, picks the model for each task, and only accepts requests from the app's own site.

| Task | Model |
|---|---|
| Prep plan | `anthropic/claude-sonnet-5` |
| Mock questions and model answers | `anthropic/claude-sonnet-5` |
| Rating a recorded answer | `google/gemini-3.8-flash` |

To change a model, edit `MODELS` at the top of the file and deploy again. To change what the coach says, edit the prompt functions (`planPrompt`, `questionsPrompt`, `ratePrompt`). The page doesn't need changing.

## One-time setup

### 1. A dedicated OpenRouter key with a spending limit

1. Sign in at openrouter.ai, go to **Settings → API Keys**, and choose **Create Key**.
2. Name it `HirePilot` and set a **credit limit** (e.g. $5). This limit is the hard cap on what the site can spend.
3. Copy the key. You will paste it into Cloudflare in step 3, and nowhere else.

### 2. Create the Worker

1. Go to dash.cloudflare.com → **Workers & Pages → Create → Create Worker**, name it `hirepilot-coach`, and click **Deploy**.
2. Click **Edit code**, replace everything with the contents of `coach-worker.js`, and click **Deploy**.

### 3. Add the key as a secret

1. In the Worker, open **Settings → Variables and Secrets → Add**.
2. Set the type to **Secret**, the name to `OPENROUTER_API_KEY_HIREPILOT`, and paste the key as the value.
3. Click **Deploy**.

### 4. Connect the app

Copy the Worker's address (`https://hirepilot-coach.<your-name>.workers.dev/`) and paste it into the app under **⚙ Settings**.

## Notes

- **Allowed sites.** The Worker only answers `https://chamwong123-glitch.github.io`. To test locally or from another domain, add a plain variable `ALLOWED_ORIGINS`, e.g. `http://127.0.0.1:8765`. If you publish under a different GitHub account or domain, change `SITE` at the top of the file.
- **Nothing is stored.** The Worker passes documents and recordings straight to OpenRouter and keeps nothing.
- **Limits.** Documents are capped at 20,000 characters, interviewer profiles at 6,000, up to 6 interviewers, and recordings at about 3.5 minutes.
- **Optional per-visitor limit.** Attach a Rate Limiting binding named `LIMITER` and the Worker will enforce it. Without one, the OpenRouter credit limit is the cap.
- **Rough cost.** A prep plan plus 10 questions is a few cents on Sonnet, and rating one spoken answer on Gemini Flash costs a fraction of a cent.
