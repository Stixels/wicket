# Wicket

A drop-in help and feedback chat for any web app, plus a Discord community and support inbox behind it. Users write one message. An assistant answers from your docs, and every conversation shows up in your team's Discord, where a reply goes straight back to the user in the app.

- **One script tag** adds a chat button to your app. It captures the page, app version and recent console errors, so reports arrive with context.
- **Answers from your docs.** It indexes any GitHub repo of Markdown (GitBook Git Sync, Docusaurus, Mintlify, ...), or any hosted docs site by its sitemap, and links the exact section.
- **Discord as the inbox and community.** Each in-app conversation becomes a private forum post that your team answers from Discord. The same assistant can also answer new questions in your public `#help` forum.
- **Hands off to a person** when the user asks, is frustrated, or the docs don't cover it, and pings a role you choose.
- **Cheap to run.** One Node process with SQLite. The assistant runs through the Vercel AI Gateway or Anthropic directly, and it's optional: without a key, every chat goes straight to the team.

- **Everyone hears back.** With a tracker set up, the assistant logs bugs, ideas and docs gaps itself. A repeat report becomes another report on the ticket that already exists, not a new one. Everyone who reported it gets a message in their chat (and by email if they're away) when it's fixed, and for ideas, when the team plans it or decides not to.

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

You can also call `Wicket.open()`, `Wicket.close()`, `Wicket.toggle()`, `Wicket.ask("question")` (opens the chat and sends it), `Wicket.setContext({ roomId })`, `Wicket.setUser({...})`, `Wicket.setUserToken(...)`, `Wicket.setTheme({...})`, `Wicket.setAnchor(element)`, `Wicket.setQuiet(true)` and `Wicket.destroy()` (removes the widget, for example on sign-out; `init` brings it back) at any time. The latest context and a fresh `userToken` go with every message.

### Your own button

To open the chat from a button in your app's header, hide the launcher and pass the button as `anchor`:

```js
const button = document.querySelector("#help-chat");
Wicket.init({ hideLauncher: true, anchor: button });
button.addEventListener("click", () => Wicket.toggle());
const off = Wicket.on("unread", (count) => (button.dataset.count = count || ""));
```

- The panel opens just below the anchor, right-aligned to it, floating over the page. On phones it opens full screen as usual. If the anchor is gone or hidden, the panel uses the bottom corner.
- When a reply arrives while the chat is closed, a preview drops from under the anchor (or sits above the launcher) with the reply, a one-line reply box and **Open chat**. It never plays a sound.
- `quiet: true` (or `Wicket.setQuiet(true)`) turns the previews off, for screens other people can see; `unread` still fires so you can show the count yourself.
- `Wicket.on(event, callback)` returns a function that unsubscribes. Events: `unread` (the count, on every change, including back to 0 when the chat opens), `open`, `close`, and `rating` (`{ conversationId, messageId, rating }` when someone rates an answer; `rating` is `"up"`, `"down"` or `null` when they take it back). You can subscribe before `init`.

Each assistant answer has thumbs up and down on its name line. A thumbs down offers to pass the conversation to the team. Answers can come with **How we got this** (the numbers behind them) and **Ask next** questions under the latest one. When the server asks for a bot check, visitors pass a Cloudflare Turnstile check in the panel before their first answer.

### Signed-in users

A name or id passed in `user` is only a label. For profiles that depend on who someone is (signed in, their plan) and for per-person budgets, your backend signs a short-lived token and the widget passes it on:

```ts
// Your backend, with the same IDENTITY_SECRET Wicket has (HS256 JWT)
jwt.sign({ sub: user.id, name: user.name, email: user.email, plan: user.plan }, process.env.WICKET_IDENTITY_SECRET, { expiresIn: "5m" });
```

```js
Wicket.init({ userToken: () => fetch("/api/wicket-token").then((r) => r.json()).then((d) => d.token) });
```

`userToken` takes the token or a function that returns one. Without a valid token, the person counts as a visitor. Tokens must have an expiry (`exp`) no more than 24 hours out; a few minutes is best. The widget asks for a fresh one with every message.

Optional claims:

| Claim | What it does |
|---|---|
| `account` | Bill per account instead of per person: everyone with the same `account` spends from one budget. |
| `budget` | The account's (or person's) monthly AI allowance in dollars. When a profile also has a `budget`, the lower one applies, so your app stays in charge of the amount. |
| `env` | Which of your environments signed it (`staging`, `production`), when one Wicket serves several. Picks the app-tools URL. |

### App tools

Let the assistant read the signed-in person's own data, such as their results or settings, through tools your backend offers. Wicket calls them with the person's token, so your backend checks who they are on every call and Wicket never sees data they couldn't see in your app.

```yaml
profiles:
  default:
    appTools:
      url: https://api.example.com/wicket/tools   # or { production: ..., staging: ... } keyed by the token's env
```

- `GET {url}?context=<json>` returns `{ instructions, tools: [{ name, description, inputSchema }] }`. `instructions` are your rules for using the tools; they go into the assistant's prompt. `inputSchema` is JSON Schema.
- `POST {url}/{name}` with `{ input, context, evidenceStart }` returns `{ content, evidence? }`. `content` is what the model reads. `evidence` items (`{ id, label, value, period?, basis?, caveats? }`) show folded under the answer as "How we got this", numbered from `evidenceStart + 1` so ids stay unique within an answer. Answer with a 4xx and `{ error }` for a problem the model should hear about.
- `context` is what the widget last sent with `Wicket.setContext()`, for example the page, the record on screen and the date range. Wicket sends it to the model again whenever it changes.

Profiles with app tools get more steps per answer (`AGENT_MAX_STEPS_WITH_APP_TOOLS`, 20 by default).

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
| `showBranding` | `true` | The small "Powered by" line. It links to your Wicket server's home page, which is the Wicket marketing page unless `SITE=false`. |
| `theme.accentColor` | `#4f46e5` | Brand color. Text on it switches between white and dark automatically. |
| `theme.mode` | `"auto"` | `"light"`, `"dark"`, or follow the visitor's system. |
| `theme.radius` | `20` | Corner radius in px. |
| `theme.fontFamily` | system font | Any CSS font stack your page loads. |
| `theme.position` | `"right"` | `"left"` or `"right"`. |
| `theme.offset` | `{ x: 20, y: 20 }` | Distance from the screen edges. |
| `theme.zIndex` | very high | Stacking order. |
| `theme.cssVars` | none | Override any internal variable, e.g. `{ "--wk-bg": "#fffaf5" }`. |
| `--wk-user`, `--wk-user-text`, `--wk-user-border` | accent, text on accent, none | Colors of the person's own messages, set through `theme.cssVars`. |

The widget renders in a shadow DOM, so your app's CSS can't break it and its CSS can't leak into your app. On phones it opens full screen.

Earlier conversations show under **Recent** on the start screen, and the clock button in the header lists all of them. The browser keeps each conversation's access token in `localStorage` (up to 50). For signed-in users (a verified `userToken`), the server also returns their conversations by user id, so their history, including reports and their progress, follows them to any device or browser. Visitors' history stays in the browser they used.

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
- **Tickets:** with `LINEAR_API_KEY` and `LINEAR_TEAM_KEY` set, anyone with the Team role can tag the bot anywhere in the server, e.g. `@Wicket file this as a bug` in a support-inbox post. It reads the conversation, writes the ticket (summary, steps, context, who reported it), files it in Linear (Triage if the team has it on, otherwise Backlog) with the matching Bug/Feature/Improvement label, and replies with the link. Messages that tag the bot are never sent to the user. To file GitHub issues instead, set `GITHUB_ISSUES_REPO` and `GITHUB_ISSUES_TOKEN` (a fine-grained token with Issues: read and write); issues get the repo's `bug`, `enhancement`, `documentation` or `question` label when it exists, plus `GITHUB_ISSUES_LABEL` if you set one. The tracker is an adapter, so Jira can plug in the same way.
  - Tag the bot with a ticket key or link (`@Wicket +1 ED-123`, `@Wicket same as <link>`) to add the conversation to that ticket instead of filing a new one.
  - Tickets filed or added from a support-inbox post are linked to that app conversation, so its reporter hears back too.
- **Hearing back:** Wicket asks the tracker every 15 minutes (`tickets.checkMinutes`) about tickets someone is waiting on. When the assistant logs a report, the person sees a slim status row in their own words. Bugs go from Logged to Fixed. Ideas go from Logged to Planned (the team moved it out of Triage) to Shipped, or to Not planned when the team cancels it. To tell people why, comment on the issue starting with `Reply:` (for example `Reply: It would distract players mid-game.`); Wicket waits an hour after a cancel so there's time to write it, and sends the newest one. A bug canceled with a `Reply:` comment tells its reporters too; one canceled without a word sends nothing. A ticket closed as a duplicate passes its reporters to the one it duplicates. With GitHub Issues there's no Triage, so ideas skip Planned; closing as completed counts as done and closing as not planned as declined. The check is plain tracker API calls, with no model calls. The dashboard lists each conversation's tickets. Turn off assistant filing with `tickets.assistant: false`.
- **Voice:** joining `➕ Start a call` creates a voice room named after you and moves you in. It's deleted when the last person leaves. `🎧 Talk to support` works the same way, but the room is visible only to the caller and the Team role, and it pings the team. The bot needs the **Move Members** permission for both.
- **Community questions:** with `assistant.helpForum: true`, when someone opens a post in `#help`, the assistant answers once from the docs. If it can't, it pings the team. Everyone else can keep the thread going. It's off by default, because Discord members aren't signed in to your app, so those answers can't count toward anyone's budget.

## Team dashboard

A reply inbox at `/admin`, for teammates who'd rather not answer from Discord. It's another place to reply, not a replacement: Wicket keeps the record, so a reply from the dashboard reaches the user's widget and shows up in the Discord post, and a reply in Discord shows up in the dashboard.

- **Shared conversations.** Nobody owns a conversation. The dashboard shows who has replied ("Alex and you replied"), and anyone can jump in. Teammates are linked across tools by their Discord account, so Alex replying in Discord and Alex in the dashboard are the same person.
- **Online status.** A dot on the user's avatar shows whether they're around: solid green while the chat is open in front of them, a green ring while they're on the site with the chat closed or in a background tab. The conversation header says "In the chat now", "On the site" or "Last seen 12m ago", so you know whether to expect a quick back-and-forth.
- **Typing hints.** While someone types in the dashboard or in the Discord post, the others see "Alex is typing" on the conversation, so two people don't write the same answer.
- **Hand off with a note.** Switch the composer to **Note** (or type `@`) to leave a team-only note like "@Alex can you take this?". Notes never reach the user. In Discord the note pings Alex, and the dashboard lists it under **Mentions** until Alex writes in that conversation. In Discord, a message that starts with an @mention of a teammate or role is treated the same way: it stays with the team instead of going to the user, and gets a 📝 reaction.
- **Desktop notifications.** Turn them on from the banner or your profile menu. You're notified when a conversation is passed to the team, when the user writes in a conversation the team has, and when a note mentions you, but not while you're looking at the dashboard. The tab title counts what you missed.
- **Saved replies.** Answers the team gives often, shared by everyone: the ⚡ button in the composer, or type `/` in an empty reply to search them. `{name}` becomes the person's first name. "Save what I wrote" turns a reply you just wrote into one.
- **Views:** Open, Needs reply (the user is waiting on the team), Mentions, Resolved, All. **Resolve** works like closing the Discord post. Each conversation shows the person, their plan, the page and app version they wrote from, and recent console errors.
- **Attachments** are up to 10 MB each (Discord's limit without server boosts), 30 per conversation, and stored on the server's volume. A teammate can delete one from the dashboard (hover it, then the bin); it's removed for everyone and the message keeps its name, marked removed. Files go automatically after `files.keepDays` (90 by default, 0 keeps them) and uploads that were never sent go after a day. Copies already posted to Discord stay there.

Sign-in is with Discord, for everyone with the Team role:

1. In the same Discord application as the bot, open **OAuth2**, copy the **Client ID** and **Client Secret**, and add a redirect: `https://YOUR-SERVER/admin/auth/callback`.
2. Set `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` and `PUBLIC_URL` (your server's address). With `DISCORD_GUILD_ID` set, anyone with the Team role can sign in. To let in someone without the role, add their Discord user id to `TEAM_DISCORD_IDS`.

For local work, `TEAM_DEV_LOGIN=true` adds a one-click "local teammate" sign-in. Never set it on a public server.

## Email

Support is async, so nobody should have to keep a tab open waiting. With email set up, a team reply the user hasn't seen in the widget for 5 minutes is emailed to them (at most one email per conversation an hour, with every unread reply in it). The email links to a page with just that conversation, and replying to the email posts into the conversation, so it reaches the dashboard and Discord too. Each email has an unsubscribe link for that conversation. The address comes from the signed-in user's token, `user.email` in `Wicket.init`, or the email field in the widget (`askEmail` in a profile), and the "passed to the team" message adds "We'll email you when they do."

It uses [Resend](https://resend.com); the free tier is plenty for a small team.

1. In Resend, verify the domain you'll send from and create an API key. Set `RESEND_API_KEY`, `EMAIL_FROM` (e.g. `Escape Director <support@escapedirector.com>`) and `PUBLIC_URL`.
2. For replies by email: add a receiving domain in Resend (e.g. `reply.escapedirector.com`) and set it as `EMAIL_REPLY_DOMAIN`. Add a webhook for `email.received` pointing at `https://YOUR-SERVER/email/inbound` and set its signing secret as `RESEND_WEBHOOK_SECRET`. A reply only counts if it comes from the address we emailed, to that conversation's own reply address.

## Deploy on Railway

1. In Railway, choose **New → GitHub Repo** and pick this repo. It builds from the `Dockerfile` and redeploys on every push to `main`. The build runs the typecheck and tests first, so a failing push never replaces the running version.
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
- **Assistant** (top level) applies everywhere, including the community help forum: `instructions` for facts every answer should know, `code` (`decline` by default: no code, it links the closest guide or example; `snippets` allows short snippets adapted from examples it has read), and `helpForum` (`false` by default; `true` answers new `#help` posts, which no per-person budget covers).
- **Profiles** set whether the assistant answers at all, extra instructions, whether it stays on topic (`offTopic: decline` by default, so it won't do general coding or homework; `topics` widens what counts), the model and effort, a monthly budget per person, and what the widget shows (title, welcome text, placeholder, quick starts). Options passed to `Wicket.init()` still win.
- **Rules** pick a profile from whether someone is signed in, their `plan`, and the page they're on. Signed in and plan come only from a verified token; the page comes from the widget.
- **Visitors** can get the assistant too, without opening a hole in your budget: give their profile `budgetScope: shared` so they all spend from one pot, and `botCheck: true` so each conversation starts with a Cloudflare Turnstile check (set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`; without them those visitors go straight to the team). `tickets: false` stops the assistant logging reports for people it can't follow up with.
- **Follow-ups:** `followUps: true` has the assistant suggest two or three questions to ask next with each answer, shown as chips. They're written with the answer, so they cost no extra call.
- **Budgets** count what each person's assistant answers cost this calendar month (UTC), from what the AI Gateway billed for each response, or from token usage and list prices when it doesn't say. Signed-in people are counted by user id, visitors by IP. Each person has one total across all profiles; a profile's `budget` is the point where that profile stops answering, so giving every profile the same number makes it a single shared budget. Near the limit the widget says so; at the limit their messages go to the team instead. `monthlyTotal` does the same for everyone at once. Prices for current Claude models and GPT-6 Luna are built in; add others under `budgets.prices`.

On boot the log lists each profile and anything that won't work as written, such as rules about sign-in without `IDENTITY_SECRET`.

## Configuration

See [`.env.example`](.env.example). The main settings:

| Variable | What it does |
|---|---|
| `AI_GATEWAY_API_KEY` or `ANTHROPIC_API_KEY` | Turns on the assistant, through the Vercel AI Gateway or Anthropic directly. Leave both empty to send every chat to the team. |
| `AGENT_MODEL`, `AGENT_EFFORT` | Model and effort for the assistant (defaults: `claude-haiku-5-5`, `low`). |
| `DOCS_GITHUB_REPO`, `DOCS_BASE_URL` | Markdown docs repo to index, and the public site its links should point to. Reindexed every `DOCS_REINDEX_HOURS`. |
| `DOCS_URL` | No docs repo? A hosted docs site to index instead: its home page (pages under that path are read) or its `sitemap.xml`. Pages come from the sitemap when there is one, otherwise by following links, up to 500. |
| `RELAY`, `DISCORD_*` | Where conversations show up for the team. |
| `ALLOWED_ORIGINS` | Sites allowed to embed the widget. |
| `PLAYGROUND`, `SITE` | `PLAYGROUND` serves a test page with the widget at `/` (on outside production). `SITE` serves the Wicket marketing page (`site/index.html`) at `/`, and moves the playground to `/playground`. It's on by default; `SITE=false` turns it off. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `PUBLIC_URL` | Discord sign-in for the team dashboard at `/admin`. `TEAM_DISCORD_IDS` lets in people without the Team role. |
| `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_DOMAIN`, `RESEND_WEBHOOK_SECRET` | Emailing unread replies to users, and replies by email. See [Email](#email). |
| `IDENTITY_SECRET` | Shared with your backend to sign user tokens (at least 32 characters). |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile, for profiles with `botCheck: true`. |
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

### Comparing models

`evals/cases.yaml` is a set of real-world questions, each with the kind of reply it should get (an answer that links the right page, a handoff, a polite decline, and so on). `npm run eval` sends each one to the model with your `.env` settings and docs, scores the replies without an AI judge, and prints pass rate, cost, time and tool calls per model:

```bash
npm run eval -- --models claude-haiku-5-5,openai/gpt-6-luna   # 2 runs per case by default
npm run eval -- --only 24,25 --reps 1
npm run eval -- --only 28,29,30,31,32,33,34,35,36,37,38,39   # just the routing cases
```

Each case runs as a chat with a signed-in person, through the same conversation code as the server, with a fake tracker that starts from the file's `backlog` of open tickets. Routing cases (`kind: route`) check what landed in it: a repeat report added to the right existing ticket, a new bug, idea or docs gap filed once with the right kind, or nothing logged for a how-to question. No real ticket is ever created.

Full replies are saved to `evals/results/` (not committed). A run of every case twice on two models costs well under a dollar.
