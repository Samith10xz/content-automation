# Content Pipeline

Brief → Claude writes the post → review in the dashboard or Slack → approved.
Node.js 22, MySQL, no build step. Runs on Hostinger Cloud hosting (entry file `server.js`).

## What works

- Owner sign-in, brands (colours, tone of voice, Slack channel), briefs
- Claude writes a headline, image prompt, one caption per platform, hashtags and a call to action
- Review: approve, request changes (up to 3 rounds), reject. In the dashboard and in Slack
- Job queue in MySQL with retries; a cron call every minute picks up interrupted work

## Not built yet

- Image generation and brand overlay
- Publishing to LinkedIn, TikTok, X; AI image generation; Canva import
- WhatsApp approval, client logins, the drag-and-drop workflow builder

## Run locally

    cp .env.example .env      # leave DB_NAME empty to use an in-memory SQLite database
    node --env-file=.env server.js
    npm test

## Configuration

See `.env.example`. API keys for Claude and Slack are entered in the app under Settings and stored encrypted.

## Publishing (Facebook and Instagram)

1. Settings → Facebook and Instagram: Meta app ID and secret. Add the redirect URI shown there to the Meta app.
2. Each brand page → Connect Facebook and Instagram → choose the Page.
3. Posts with Instagram need a JPG image (Canva: Share → Download → JPG, 1080×1080 or 1080×1350) before approval.
4. Approving publishes now, or at the brief's publish time. Results and links appear on the post and in the Slack thread.

A Meta app in Development mode publishes posts only people with a role on the app can see. Switch the app to Live
(using /privacy and /data-deletion) for public posts. LinkedIn, TikTok and X are recorded as skipped.

## Requests from Slack and Gemini images

- Settings → Gemini images: API key from Google AI Studio. Every post without an image gets one from Gemini
  (4:5 JPG with the headline and, if uploaded on the brand page, the logo).
- Brand page → Slack request channel ID: each message in that channel becomes a brief for the brand.
  The draft goes to the brand's approval channel; the requester gets replies in their thread.
- Feedback on the draft: text changes go to Claude; changes to the picture edit the Gemini image.
  A design uploaded by hand is never overwritten.
- Slack app needs Event Subscriptions (`/api/slack/events`, events `message.channels`, `message.groups`)
  and the scopes `channels:history`, `groups:history`.
