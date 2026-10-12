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

You can also call `Wicket.open()`, `Wicket.close()`, `Wicket.setContext({ roomId })`, `Wicket.setUser({...})`, `Wicket.setUserToken(...)` and `Wicket.setTheme({...})` at any time.

### Signed-in users

A name or id passed in `user` is only a label. For profiles that depend on who someone is (signed in, their plan) and for per-person budgets, your backend signs a short-lived token and the widget passes it on:

```ts
// Your backend, with the same IDENTITY_SECRET Wicket has (HS256 JWT)
jwt.sign({ sub: user.id, name: user.name, email: user.email, plan: user.plan }, process.env.WICKET_IDENTITY_SECRET, { expiresIn: "5m" });
```

```js
Wicket.init({ userToken: () => fetch("/api/wicket-token").then((r) => r.json()).then((d) => d.token) });
```

`userToken` takes the token or a function that returns one. Without a valid token, the person counts as a visitor.

### Customizing

| Option | Default | What it does |
|---|---|---|
| `title`, `subtitle` | "Help & feedback" | Header text. |
| `welcomeTitle`, `welcomeSubtitle` | "Hi {first name} 👋", "How can we help you today?" | Large heading on the start screen. |
| `greeting` | short default | Line under the start screen heading. |
| `suggestions` | 3 quick starts | Buttons shown before the first message. Pass `[]` to hide them. |
| `placeholder` | "Write a message…" | Text in the empty input. |
| `logoUrl` | animated bot | Square image for the header and the assistant's avatar. Without one, the assistant is a small animated orb in your brand color that blinks, looks around and shows bouncing dots while it thinks. |
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

Earlier conversations show under **Recent** on the start screen, and the clock button in the header lists all of them. The list lives in the browser (each conversation's access token is kept in `localStorage`, up to 50), so it doesn't follow someone to another device or browser yet.

## Set up Discord (community + support inbox)

1. Go to https://discord.com/developers/applications and create a **New Application**. Under **Bot**, copy the token and turn on **Message Content Intent**.
2. Under **OAuth2 → URL Generator**, pick the `bot` scope with these permissions: Manage Roles, Manage Channels, Move Members, View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Manage Threads, Read Message History, Add Reactions, Embed Links and Manage Messages (to pin the welcome post). Manage Server is optional: with it the bot also points join messages and the Community welcome screen at `#welcome`. On a Community server it also keeps the rules channel (`#📜・rules`) in Start here with a pinned rules post, makes `#announcements` a real announcement channel, and moves Discord's admin notices channel into Team. Open the URL and add the bot to your server.
3. Turn on Developer Mode (User Settings → Advanced). Right-click your server and choose **Copy Server ID**.
4. Set `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID` in the service variables. On every boot the service makes sure the server has a **Team** role and these channels, creating only what's missing:

   | Category | Channels | Who sees it |
   |---|---|---|
   | Start here | `#👋・welcome`, `#📣・announcements` | Everyone; only the team posts |
   | Support | `#❓・help` (forum), `🎧 Talk to support` (voice) | Everyone |
   | Community | `#💬・general`, `#💡・ideas` (forum), `#📸・show-and-tell`, `➕ Start a call` (voice) | Everyone |
   | Team | `#support-inbox` (forum), `#team-chat` | Team role only |

   Channels are matched by name with or without the emoji, and nothing is ever deleted. An existing channel keeps its place and settings; the bot only adds the emoji while it still has the plain name, fills in an empty topic, and adds forum tags and the 👍 default reaction on `#ideas` when they're missing. It keeps **Start here** at the top so new members land in `#welcome`, and keeps a pinned welcome post there with the house rules and where to go. Anything it can't do itself is logged as `discord: needs you: …`. To use an existing staff role, set `DISCORD_TEAM_ROLE` to its name. You can also run it by hand with `npm run discord:setup`.
5. Give your teammates the **Team** role.

How it behaves:
- **In-app conversations** become posts in `#support-inbox`. The user's messages show as blue cards and the assistant's as gray cards, so your own replies (plain messages) stand out. While the assistant is working the bot shows as typing. Reply in a post to answer the user in the app. The assistant stops replying once someone from the team does. When the assistant asks for a person, it pings the Team role and tags the post **Needs a person**. Only a reply that fails to reach the app gets a ⚠️ reaction.
- **When you're done**, close the post (or tag it **Resolved**; deleting it works too, though the transcript is then gone from Discord). The user sees "resolved" in the widget, the post is tagged Resolved, and if they write again the post reopens and the assistant takes the new question first. Posts Discord archives on its own after inactivity aren't treated as resolved.
- **Tickets:** with `LINEAR_API_KEY` and `LINEAR_TEAM_KEY` set, anyone with the Team role can tag the bot anywhere in the server, e.g. `@Wicket file this as a bug` in a support-inbox post. It reads the conversation, writes the ticket (summary, steps, context, who reported it), files it in Linear (Triage if the team has it on, otherwise Backlog) with the matching Bug/Feature/Improvement label, and replies with the link. Messages that tag the bot are never sent to the user. The tracker is an adapter, so GitHub Issues or Jira can plug in the same way.
- **Voice:** joining `➕ Start a call` creates a voice room named after you and moves you in. It's deleted when the last person leaves. `🎧 Talk to support` works the same way, but the room is visible only to the caller and the Team role, and it pings the team. The bot needs the **Move Members** permission for both.
- **Community questions:** when someone opens a post in `#help`, the assistant answers once from the docs. If it can't, it pings the team. Everyone else can keep the thread going.

## Team dashboard

A reply inbox at `/admin`, for teammates who'd rather not answer from Discord. It's another place to reply, not a replacement: Wicket keeps the record, so a reply from the dashboard reaches the user's widget and shows up in the Discord post, and a reply in Discord shows up in the dashboard.

- **Shared conversations.** Nobody owns a conversation. The dashboard shows who has replied ("Alex and you replied"), and anyone can jump in. Teammates are linked across tools by their Discord account, so Alex replying in Discord and Alex in the dashboard are the same person.
- **Typing hints.** While someone types in the dashboard or in the Discord post, the others see "Alex is typing" on the conversation, so two people don't write the same answer.
- **Hand off with a note.** Switch the composer to **Note** (or type `@`) to leave a team-only note like "@Alex can you take this?". Notes never reach the user. In Discord the note pings Alex, and the dashboard lists it under **Mentions** until Alex writes in that conversation. In Discord, a message that starts with an @mention of a teammate or role is treated the same way: it stays with the team instead of going to the user, and gets a 📝 reaction.
- **Views:** Open, Needs reply (the user is waiting on the team), Mentions, Resolved, All. **Resolve** works like closing the Discord post. Each conversation shows the person, their plan, the page and app version they wrote from, and recent console errors.

Sign-in is with Discord, for everyone with the Team role:

1. In the same Discord application as the bot, open **OAuth2**, copy the **Client ID** and **Client Secret**, and add a redirect: `https://YOUR-SERVER/admin/auth/callback`.
2. Set `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` and `PUBLIC_URL` (your server's address). With `DISCORD_GUILD_ID` set, anyone with the Team role can sign in. To let in someone without the role, add their Discord user id to `TEAM_DISCORD_IDS`.

For local work, `TEAM_DEV_LOGIN=true` adds a one-click "local teammate" sign-in. Never set it on a public server.

## Deploy on Railway

1. In Railway, choose **New → GitHub Repo** and pick this repo. It builds from the `Dockerfile` and redeploys on every push to `main`.
2. Add a **Volume** mounted at `/data`. SQLite lives there.
3. Copy `.env.example` into the service variables and fill them in.
4. Generate a domain and use it in the script tag above.

Keep it to one replica. SQLite and the Discord connection expect a single instance.

## Profiles, rules and budgets

How the assistant behaves lives in one YAML file: [`config/wicket.yaml`](config/wicket.yaml), or the YAML pasted into the `WICKET_CONFIG` variable. [`config/wicket.example.yaml`](config/wicket.example.yaml) lists every option.

```yaml
profiles:
  visitor:                # not signed in
    ai: false             # no assistant: messages go straight to the team
    askEmail: true        # offer an email field so the team can follow up
  default:
    budget: 0.50          # dollars per person per month
  analytics:
    instructions: Explain metrics using the docs.
    suggestions: ["What does Success Rate mean?"]
    budget: 2.00
rules:                    # first match wins; otherwise "default"
  - when: { signedIn: false }
    profile: visitor
  - when: { page: /app/analytics, plan: pro }
    profile: analytics
budgets:
  warnAt: 0.8             # warn at 80% of a budget
  monthlyTotal: 20        # cap across everyone
```

- **Theme** (top level) sets the widget's look for everyone, with the same fields as `Wicket.init({ theme })`, so the embed snippet can stay bare.
- **Profiles** set whether the assistant answers at all, extra instructions, whether it stays on topic (`offTopic: decline` by default, so it won't write code or do homework; `topics` widens what counts), the model and effort, a monthly budget per person, and what the widget shows (title, welcome text, placeholder, quick starts). Options passed to `Wicket.init()` still win.
- **Rules** pick a profile from whether someone is signed in, their `plan`, and the page they're on. Signed in and plan come only from a verified token; the page comes from the widget.
- **Budgets** count what each person's assistant answers cost this calendar month (UTC), from token usage and list prices. Signed-in people are counted by user id, visitors by IP. Each person has one total across all profiles; a profile's `budget` is the point where that profile stops answering, so giving every profile the same number makes it a single shared budget. Near the limit the widget says so; at the limit their messages go to the team instead. `monthlyTotal` does the same for everyone at once. Prices for current Claude models and GPT-6 Luna are built in; add others under `budgets.prices`.

On boot the log lists each profile and anything that won't work as written, such as rules about sign-in without `IDENTITY_SECRET`.

## Configuration

See [`.env.example`](.env.example). The main settings:

| Variable | What it does |
|---|---|
| `AI_GATEWAY_API_KEY` or `ANTHROPIC_API_KEY` | Turns on the assistant, through the Vercel AI Gateway or Anthropic directly. Leave both empty to send every chat to the team. |
| `AGENT_MODEL`, `AGENT_EFFORT` | Model and effort for the assistant (defaults: `claude-haiku-5-5`, `low`). |
| `DOCS_GITHUB_REPO`, `DOCS_BASE_URL` | Markdown docs repo to index, and the public site its links should point to. Reindexed every `DOCS_REINDEX_HOURS`. |
| `RELAY`, `DISCORD_*` | Where conversations show up for the team. |
| `ALLOWED_ORIGINS` | Sites allowed to embed the widget. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `PUBLIC_URL` | Discord sign-in for the team dashboard at `/admin`. `TEAM_DISCORD_IDS` lets in people without the Team role. |
| `IDENTITY_SECRET` | Shared with your backend to sign user tokens (at least 32 characters). |
| `WICKET_CONFIG` | Profiles, rules, budgets and extra knowledge repos (`knowledge:`, e.g. an SDK with examples): a file path or the YAML itself. Defaults to `config/wicket.yaml`. |

## How it fits together

```
widget.js ──▶ Hono API ──▶ ConversationService ──▶ Agent (Claude + tools: search_docs, handoff_to_human)
                 ▲               │                         │
         SSE live updates        ├──▶ SQLite (conversations, messages, transcript, FTS5 docs index)
                                 └──▶ Relay adapter (Discord) ◀── team replies
                 ▲
/admin dashboard ┘ (team replies, notes, typing; live over SSE)
```

Each external tool sits behind an adapter interface in `src/adapters/types.ts` (`KnowledgeSource`, `Relay`), so Slack, other docs sources or trackers plug in without touching the core.

## Development

```bash
npm test            # unit + API tests (scripted model, fake relay)
npm run typecheck
cp .env.example .env   # fill in your keys
npm run dev            # open http://localhost:4318 for a test page with the widget
```
