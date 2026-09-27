# HirePilot

An AI interview coach for any job seeker, in any field.

1. **Your interview.** Paste or upload the job description, your CV, and your interviewers' public profiles (e.g. from LinkedIn).
2. **Prep plan.** See how well you fit, the strengths to lead with, the gaps to get ahead of, the stories to prepare (in STAR form), what each interviewer is likely to focus on, tricky topics, questions to ask, and a countdown to the day.
3. **Questions.** Get tailored mock questions (motivation, behavioural, role-specific, situational, culture, curveball), each with why it's asked, what a good answer shows, and a model answer built from *your* CV.
4. **Mock interview.** The interviewer reads each question aloud and you answer out loud. The AI listens to your recording and scores **content**, **structure**, **confidence** and **communication** out of 10. The app also measures your pace, filler words and long pauses, then gives you a stronger version of your own answer.
5. **Progress.** Track your scores across sessions and review past answers.

It runs as a single web page (`index.html`) with no build step, plus a small Cloudflare Worker that holds the AI key. Your documents and history stay in your browser's local storage.

## Try it

Open `index.html` in Chrome or Edge and choose **Fill in a sample**. With no Worker set, the app runs in **demo mode** with sample output, so you can try every screen.

## Go live

1. Deploy the Worker by following [`worker/README.md`](worker/README.md). It takes about 10 minutes and is free on Cloudflare; you pay only for the AI usage on OpenRouter.
2. Publish the page with GitHub Pages: **Settings → Pages → Deploy from branch → `main` / root**. On a free GitHub plan the repository must be public.
3. In the app, open **⚙ Settings** and paste the Worker address.

## How it works

| Step | What happens | Model (via OpenRouter) |
|---|---|---|
| Prep plan | JD + CV + profiles → JSON plan | `anthropic/claude-sonnet-5` |
| Questions | JD + CV + profiles → questions with model answers | `anthropic/claude-sonnet-5` |
| Rating | 16 kHz WAV recording + browser transcript + delivery metrics → scores and feedback | `google/gemini-3.8-flash` (listens to the audio, so it can judge tone and confidence) |

- **Speech to text:** the browser's Web Speech API gives a live transcript (Chrome, Edge and Safari). Where it isn't available, the rating model transcribes the audio itself.
- **Delivery metrics** are computed in the browser: words per minute, filler words (um, like, you know…), and pauses over 2 seconds.
- **Text to speech:** the browser reads questions aloud in the chosen English accent (US, UK, AU, SG, IN, HK, CA, NZ).
- **Files:** PDF text is extracted with pdf.js and Word files with mammoth, both loaded from cdnjs only when needed. Scanned PDFs need to be pasted as text.
- **Prompts** live in the Worker, not in the page. The page sends structured fields, so the key can't be used as a general chatbot.

## Privacy

Nothing is stored on a server. When you ask for a plan, questions or a rating, the text (and, for ratings, the recording) goes through your Worker to the model provider, and the Worker keeps nothing. Use **Settings → Export my data** to back up and **Delete all data** to wipe. Only use interviewers' public professional information.

## Roadmap ideas

- Follow-up questions: the interviewer probes your answer the way a real one would
- Video mode: eye contact and posture feedback from the webcam
- Company research from a URL, and salary benchmarks by city
- More languages for answers (Cantonese, Mandarin, Malay…)
- Accounts and sync across devices
- Mobile app wrapper (PWA)
