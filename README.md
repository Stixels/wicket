# Wicket

A drop-in help and feedback chat for any web app, plus a Discord community and support inbox behind it. Users write one message. An assistant answers from your docs, and every conversation shows up in your team's Discord, where a reply goes straight back to the user in the app.

- **One script tag** adds a chat button to your app. It captures the page, app version and recent console errors, so reports arrive with context.
- **Answers from your docs.** It indexes any GitHub repo of Markdown (GitBook Git Sync, Docusaurus, Mintlify, ...) and links the exact section.
- **Discord as the inbox and community.** Each in-app conversation becomes a private forum post that your team answers from Discord. The same assistant also answers new questions in your public `#help` forum.
- **Hands off to a person** when the user asks, is frustrated, or the docs don't cover it, and pings a role you choose.
- **Cheap to run.** One Node process with SQLite. The assistant runs through the Vercel AI Gateway or Anthropic directly, and it's optional: without a key, every chat goes straight to the team.

Coming next: filing bugs, ideas and docs gaps as Linear issues in Triage, and telling users when their issue ships.

## Run the demo (no keys needed)

```bash
npm install
npm run demo        # open http://localhost:4317
```

The demo indexes the Escape Director docs, uses a scripted assistant and simulates Discord. To simulate a team reply, run `curl -XPOST localhost:4317/__staff -H 'content-type: application/json' -d '{"body":"Hi!"}'`.

## Add it to your app

```html
<script src="https://YOUR-SERVER/widget.js" defer></script>
<script>
  window.addEventListener("load", () =>
    Wicket.init({
      user: { id: currentUser.id, name: currentUser.name, email: currentUser.email },
      context: { appVersion: APP_VERSION, venue: currentVenue.name },
      title: "Escape Director Support",
      theme: { accentColor: "#e8590c" },
    }),
  );
</script>
```

You can also call `Wicket.open()`, `Wicket.close()`, `Wicket.setContext({ roomId })`, `Wicket.setUser({...})` and `Wicket.setTheme({...})` at any time.

### Customizing

| Option | Default | What it does |
|---|---|---|
| `title`, `subtitle` | "Help & feedback" | Header text. |
| `greeting` | friendly default | First message in a new conversation. |
| `suggestions` | 3 quick starts | Buttons shown before the first message. Pass `[]` to hide them. |
| `placeholder` | "Write a message…" | Text in the empty input. |
| `logoUrl` | sparkle icon | Square image for the header and the assistant's avatar. |
| `launcherLabel` | none | Text next to the launcher icon, e.g. "Help". |
| `hideLauncher` | `false` | Hide the floating button and open the panel from your own button. |
| `showBranding` | `true` | The small "Powered by" line. |
| `theme.accentColor` | `#4f46e5` | Brand color. Text on it switches between white and dark automatically. |
| `theme.mode` | `"auto"` | `"light"`, `"dark"`, or follow the visitor's system. |
| `theme.radius` | `20` | Corner radius in px. |
| `theme.fontFamily` | system font | Any CSS font stack your page loads. |
| `theme.position` | `"right"` | `"left"` or `"right"`. |
| `theme.offset` | `{ x: 20, y: 20 }` | Distance from the screen edges. |
| `theme.zIndex` | very high | Stacking order. |
| `theme.cssVars` | none | Override any internal variable, e.g. `{ "--wk-bg": "#fffaf5" }`. |

The widget renders in a shadow DOM, so your app's CSS can't break it and its CSS can't leak into your app. On phones it opens full screen.

## Set up Discord (community + support inbox)

1. Go to https://discord.com/developers/applications and create a **New Application**. Under **Bot**, copy the token and turn on **Message Content Intent**.
2. Under **OAuth2 → URL Generator**, pick the `bot` scope with these permissions: Manage Roles, Manage Channels, Move Members, View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Manage Threads, Read Message History and Add Reactions. Open the URL and add the bot to your server.
3. Turn on Developer Mode (User Settings → Advanced). Right-click your server and choose **Copy Server ID**.
4. Set `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID` in the service variables. On every boot the service makes sure the server has a **Team** role and these channels, creating only what's missing:

   | Category | Channels | Who sees it |
   |---|---|---|
   | Start here | `#welcome`, `#announcements` | Everyone; only the team posts |
   | Community | `#general`, `#help` (forum), `#ideas` (forum), `#show-and-tell`, `➕ Start a call` and `🎧 Talk to support` (voice) | Everyone |
   | Team | `#support-inbox` (forum), `#team-chat` | Team role only |

   Channels that already exist with the same name are reused as they are, and nothing is ever deleted. To use an existing staff role, set `DISCORD_TEAM_ROLE` to its name. You can also run it by hand with `npm run discord:setup`.
5. Give your teammates the **Team** role.

How it behaves:
- **In-app conversations** become posts in `#support-inbox`. Reply in a post to answer the user in the app. The assistant stops replying once someone from the team does. When the assistant asks for a person, it pings the Team role and tags the post **Needs a person**.
- **Voice:** joining `➕ Start a call` creates a voice room named after you and moves you in. It's deleted when the last person leaves. `🎧 Talk to support` works the same way, but the room is visible only to the caller and the Team role, and it pings the team. The bot needs the **Move Members** permission for both.
- **Community questions:** when someone opens a post in `#help`, the assistant answers once from the docs. If it can't, it pings the team. Everyone else can keep the thread going.

## Deploy on Railway

1. In Railway, choose **New → GitHub Repo** and pick this repo. It builds from the `Dockerfile` and redeploys on every push to `main`.
2. Add a **Volume** mounted at `/data`. SQLite lives there.
3. Copy `.env.example` into the service variables and fill them in.
4. Generate a domain and use it in the script tag above.

Keep it to one replica. SQLite and the Discord connection expect a single instance.

## Configuration

See [`.env.example`](.env.example). The main settings:

| Variable | What it does |
|---|---|
| `AI_GATEWAY_API_KEY` or `ANTHROPIC_API_KEY` | Turns on the assistant, through the Vercel AI Gateway or Anthropic directly. Leave both empty to send every chat to the team. |
| `AGENT_MODEL`, `AGENT_EFFORT` | Model and effort for the assistant (defaults: `claude-haiku-5-5`, `low`). |
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
cp .env.example .env   # fill in your keys
npm run dev            # open http://localhost:4318 for a test page with the widget
```
