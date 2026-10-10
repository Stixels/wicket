# Feedback Loop

A drop-in help and feedback chat for any web app. Users write one message. An assistant answers from your docs, and every conversation shows up in your team's Discord, where a reply goes straight back to the user in the app.

- **One script tag** adds a chat button to your app. It captures the page, app version and recent console errors, so reports arrive with context.
- **Answers from your docs.** It indexes any GitHub repo of Markdown (GitBook Git Sync, Docusaurus, Mintlify, ...) and links the exact section.
- **Discord as the inbox.** Each conversation becomes a forum post. Reply in the post to answer the user in the app, and the assistant steps aside.
- **Hands off to a person** when the user asks, is frustrated, or the docs don't cover it, and pings a role you choose.
- **Cheap to run.** One Node process with SQLite. The assistant is optional: without an API key, every chat goes straight to the team.

Coming next: filing bugs, ideas and docs gaps as Linear issues in Triage, and telling users when their issue ships.

## Run the demo (no keys needed)

```bash
npm install
npm run demo        # open http://localhost:4317
```

The demo indexes the Escape Director docs, uses a scripted assistant and simulates Discord. To simulate a team reply, run `curl -XPOST localhost:4317/__staff -H 'content-type: application/json' -d '{"body":"Hi!"}'`.

## Add it to your app

```html
<script src="https://YOUR-FEEDBACK-LOOP-URL/widget.js" defer></script>
<script>
  window.addEventListener("load", () =>
    FeedbackLoop.init({
      user: { id: currentUser.id, name: currentUser.name, email: currentUser.email },
      context: { appVersion: APP_VERSION, venue: currentVenue.name },
      // title, greeting, accentColor, hideLauncher are optional
    }),
  );
</script>
```

You can also call `FeedbackLoop.open()`, `FeedbackLoop.setContext({ roomId })` and `FeedbackLoop.setUser({...})` at any time.

## Set up Discord

1. Go to https://discord.com/developers/applications and create a **New Application**. Under **Bot**, copy the token and turn on **Message Content Intent**.
2. Under **OAuth2 → URL Generator**, pick the `bot` scope with these permissions: View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Add Reactions and Manage Threads. Open the URL and add the bot to your server.
3. Create a **Forum** channel (for example `#support-inbox`). Right-click it, choose **Copy Channel ID** (with Developer Mode on), and set `DISCORD_CHANNEL_ID`.
4. Optional: set `DISCORD_HANDOFF_MENTION=<@&ROLE_ID>` to ping a role when the assistant asks for a person.

## Deploy on Railway

1. Create a service from this repo. It builds from the `Dockerfile`.
2. Add a **Volume** mounted at `/data`. SQLite lives there.
3. Copy `.env.example` into the service variables and fill them in.
4. Generate a domain and use it in the script tag above.

Keep it to one replica. SQLite and the Discord connection expect a single instance.

## Configuration

See [`.env.example`](.env.example). The main settings:

| Variable | What it does |
|---|---|
| `ANTHROPIC_API_KEY` | Turns on the assistant. Leave empty to send every chat to the team. |
| `AGENT_MODEL`, `AGENT_EFFORT` | Model and effort for the assistant (defaults: `claude-opus-5-5`, `low`). |
| `DOCS_GITHUB_REPO`, `DOCS_BASE_URL` | Markdown docs repo to index, and the public site its links should point to. Reindexed every `DOCS_REINDEX_HOURS`. |
| `RELAY`, `DISCORD_*` | Where conversations show up for the team. |
| `ALLOWED_ORIGINS` | Sites allowed to embed the widget. |

## How it fits together

```
widget.js ──▶ Hono API ──▶ ConversationService ──▶ Agent (Claude + tools: search_docs, handoff_to_human)
                 ▲               │                         │
         SSE live updates        ├──▶ SQLite (conversations, messages, transcript, FTS5 docs index)
                                 └──▶ Relay adapter (Discord) ◀── team replies
```

Each external tool sits behind an adapter interface in `src/adapters/types.ts` (`KnowledgeSource`, `Relay`), so Slack, other docs sources or trackers plug in without touching the core.

## Development

```bash
npm test            # unit + API tests (scripted model, fake relay)
npm run typecheck
npm run dev         # needs a .env
```
