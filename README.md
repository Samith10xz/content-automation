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
- Publishing to Facebook, Instagram, LinkedIn, TikTok, X
- WhatsApp approval, client logins, the drag-and-drop workflow builder

## Run locally

    cp .env.example .env      # leave DB_NAME empty to use an in-memory SQLite database
    node --env-file=.env server.js
    npm test

## Configuration

See `.env.example`. API keys for Claude and Slack are entered in the app under Settings and stored encrypted.
