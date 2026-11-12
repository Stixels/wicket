import { DEMO_USER } from "./index.js";

export const REPO_URL = "https://github.com/Stixels/wicket";

/** What the demo pages tell visitors about this server. */
export interface DemoPageInfo {
  /** No AI key: answers come from a scripted model. */
  scripted: boolean;
  /** Minutes until a demo ticket moves on. */
  advanceMinutes: number;
  /** The month's AI budget for the whole demo, in dollars. */
  budget: number | null;
  /** The MCP server is on: offer a token for Claude Code, after the bot check with this Turnstile site key. */
  mcp?: { siteKey: string } | null;
}

export type DemoMode = "visitor" | "customer";

const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/** Fetches a fresh token for the demo's signed-in customer; the widget calls it before each message. */
const TOKEN_FN = `function(){return fetch("/api/demo/token",{method:"POST",credentials:"same-origin"}).then(function(r){if(!r.ok)throw new Error("Couldn't sign in to the demo");return r.json()}).then(function(d){return d.token})}`;

/**
 * The live widget for the marketing page at /. It's always a visitor: Sam is signed in only on
 * /demo with "Signed-in customer" picked, so the sign-in doesn't follow people around the site.
 */
export function siteWidget(): string {
  return `
<script src="/widget.js"></script>
<script>
Wicket.init({
  user: { id: "demo-visitor" },
  context: { page: location.href },
  title: "Wicket live demo",
});
</script>`;
}

/** The marketing page with the live widget, and its demo links pointing at this server. */
export function withSiteWidget(html: string): string {
  const linked = html.replaceAll('href="https://wicketchat.com/demo"', 'href="/demo"');
  return linked.includes("</body>") ? linked.replace("</body>", `${siteWidget()}\n</body>`) : linked + siteWidget();
}

/** /demo: a stand-in escape-room app with the widget in the corner, as a visitor or a signed-in customer. */
export function demoPage(mode: DemoMode, info: DemoPageInfo): string {
  const customer = mode === "customer";
  const tab = (m: DemoMode, label: string) =>
    `<a href="/demo${m === "customer" ? "" : "?as=visitor"}"${m === mode ? ' aria-current="page"' : ""}>${label}</a>`;
  const budget = info.budget !== null ? `$${info.budget.toFixed(2)}` : null;
  const minutes = `${info.advanceMinutes} minute${info.advanceMinutes === 1 ? "" : "s"}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="theme-color" content="#09090b">
<title>Wicket live demo</title>
<meta name="description" content="Try Wicket live: a support chat answering from real docs with Claude, logging bugs and ideas, and telling each person when they ship.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
<style>
:root{--bg:#09090b;--panel:#111115;--card:#141419;--card2:#18181d;--line:rgba(255,255,255,.07);--line2:rgba(255,255,255,.12);
--text:#ededf2;--muted:#9a9aa6;--dim:#686874;--acc:#4f46e5;--acc-hi:#8b85ff;--green:#22c55e;--amber:#f5a524;
--serif:"Instrument Serif",ui-serif,Georgia,serif;--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 var(--sans);-webkit-font-smoothing:antialiased;overflow-x:hidden}
body::before{content:"";position:fixed;left:50%;top:-320px;width:1200px;height:760px;transform:translateX(-50%);background:radial-gradient(closest-side,rgba(79,70,229,.28),transparent);pointer-events:none;z-index:-1}
a{color:inherit}
.wrap{max-width:1160px;margin:0 auto;padding:0 24px}
/* The site's nav (site/index.html), so /demo reads as the same site. */
.site-nav{position:sticky;top:0;z-index:50;background:rgba(9,9,11,.72);-webkit-backdrop-filter:saturate(1.4) blur(18px);backdrop-filter:saturate(1.4) blur(18px);border-bottom:1px solid var(--line)}
.site-nav .wrap{display:flex;align-items:center;height:64px;gap:28px}
.logo{display:flex;align-items:center;gap:10px;font-weight:650;font-size:17px;letter-spacing:-.02em;text-decoration:none}
.nav-links{display:flex;gap:26px;margin-left:auto;font-size:14px;color:var(--muted)}
.nav-links a{text-decoration:none;transition:color .2s}
.nav-links a:hover,.nav-links a[aria-current]{color:var(--text)}
.nav-gh{color:var(--muted);display:grid;place-items:center;width:36px;height:36px;border-radius:10px;transition:color .2s,background .2s}
.nav-gh:hover{color:var(--text);background:rgba(255,255,255,.06)}
.btn{display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 16px;border-radius:999px;font-size:14px;font-weight:600;text-decoration:none;white-space:nowrap;background:#f4f4f7;color:#0b0b0f;box-shadow:0 0 0 1px rgba(255,255,255,.2) inset,0 10px 30px -10px rgba(139,133,255,.6)}
.btn:hover{background:#fff}
@media (max-width:760px){.nav-links{display:none}.nav-gh{margin-left:auto}}
.orb{--s:28px;display:inline-block;position:relative;width:var(--s);height:var(--s);border-radius:50%;flex:none;isolation:isolate;font-size:var(--s)}
.orb .sw{position:absolute;inset:0;border-radius:50%;overflow:hidden;z-index:-2}
.orb .sw::before{content:"";position:absolute;inset:-35%;filter:blur(2px);background:conic-gradient(from 0deg,var(--acc),color-mix(in srgb,var(--acc) 50%,white),var(--acc),color-mix(in srgb,var(--acc) 60%,black),var(--acc));animation:spin 8s linear infinite}
.orb::before{content:"";position:absolute;inset:0;z-index:-1;border-radius:50%;background:radial-gradient(circle at 32% 26%,rgba(255,255,255,.55),transparent 48%)}
.orb .eyes{display:flex;align-items:center;justify-content:center;width:100%;height:100%;animation:look 9s infinite ease-in-out}
.orb .eyes i{width:.12em;height:.2em;margin:0 .06em;border-radius:999px;background:#fff;animation:blink 4.6s infinite}
.orb .eyes i:nth-child(3){width:0;margin:0;opacity:0}
@keyframes spin{to{transform:rotate(1turn)}}
@keyframes blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.12)}}
@keyframes look{0%,30%,100%{transform:translate(0,0)}36%,52%{transform:translate(.08em,-.03em)}60%,78%{transform:translate(-.08em,.02em)}}
@media (prefers-reduced-motion:reduce){.orb .sw::before,.orb .eyes,.orb .eyes i{animation:none}}
.head{display:grid;grid-template-columns:1fr auto;gap:24px;align-items:end;padding:32px 0 24px}
h1{margin:0;font-size:clamp(32px,4.4vw,48px);font-weight:640;letter-spacing:-.035em;line-height:1.05}
h1 .serif{font-family:var(--serif);font-style:italic;font-weight:400;font-size:1.08em}
.head p{margin:12px 0 0;color:var(--muted);max-width:620px}
.view-as{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin-bottom:8px;text-align:right}
.seg{display:flex;gap:6px;justify-content:flex-end}
.seg a{display:inline-flex;align-items:center;height:38px;padding:0 16px;border-radius:999px;text-decoration:none;font-size:14px;font-weight:500;color:var(--muted);white-space:nowrap;background:rgba(255,255,255,.035);box-shadow:inset 0 0 0 1px var(--line);transition:color .2s,background .2s,box-shadow .2s}
.seg a:hover{color:var(--text)}
.seg a[aria-current]{color:var(--text);background:rgba(255,255,255,.07);box-shadow:inset 0 0 0 1px var(--line2)}
.who{margin-top:8px;font-size:13px;color:var(--dim);text-align:right}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:24px;padding-bottom:120px}
/* The stand-in app */
.app{border-radius:22px;overflow:hidden;background:linear-gradient(180deg,#121218,#0c0c10);box-shadow:inset 0 0 0 1px var(--line2),0 40px 100px -40px rgba(0,0,0,.9);display:grid;grid-template-columns:200px 1fr;min-height:520px}
.side{border-right:1px solid var(--line);padding:20px 14px;display:flex;flex-direction:column;gap:4px}
.brand{display:flex;align-items:center;gap:9px;font-weight:650;font-size:14px;color:#d6d6de;margin:0 6px 16px}
.brand i{width:22px;height:22px;border-radius:7px;background:linear-gradient(135deg,#dd3333,#7a1b1b)}
.nav{display:flex;align-items:center;gap:10px;height:32px;padding:0 10px;border-radius:8px;font-size:13.5px;color:var(--dim)}
.nav.on{background:rgba(255,255,255,.06);color:#d6d6de}
.nav svg{width:15px;height:15px}
.venue{margin-top:auto;font-size:12px;color:var(--dim);padding:0 10px}
.venue b{display:block;color:var(--muted);font-weight:600}
.main{padding:24px 28px;display:flex;flex-direction:column;gap:18px}
.crumbs{font-size:13px;color:var(--dim)}
.titlerow{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.titlerow h2{margin:0;font-size:22px;font-weight:650;letter-spacing:-.02em}
.state{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;padding:3px 10px;border-radius:999px;background:color-mix(in srgb,var(--green) 14%,transparent);color:#7ee2a1}
.state::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.state.paused{background:color-mix(in srgb,var(--amber) 14%,transparent);color:#f7c46b}
.panels{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.stat{border-radius:14px;background:rgba(255,255,255,.03);box-shadow:inset 0 0 0 1px var(--line);padding:14px}
.stat span{display:block;font-size:12px;color:var(--dim)}
.stat b{font-size:24px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.actions{display:flex;gap:10px;flex-wrap:wrap}
button,.clue{font:600 14px var(--sans);height:40px;border-radius:10px;border:0;padding:0 16px;color:var(--text);background:rgba(255,255,255,.06);box-shadow:inset 0 0 0 1px var(--line2);cursor:pointer}
button:hover{background:rgba(255,255,255,.1)}
button.primary{background:#dd3333;box-shadow:none;color:#fff}
button.primary:hover{background:#e84545}
.clue{flex:1;min-width:180px;font-weight:400;cursor:text}
.clue::placeholder{color:var(--dim)}
.puzzles{border-radius:14px;box-shadow:inset 0 0 0 1px var(--line);overflow:hidden}
.puzzles div{display:flex;justify-content:space-between;padding:10px 14px;font-size:13.5px;border-top:1px solid var(--line);color:var(--muted)}
.puzzles div:first-child{border-top:0}
.puzzles em{font-style:normal;color:var(--dim);font-variant-numeric:tabular-nums}
.puzzles .done{color:#d6d6de}
/* The explainer */
.notes{display:flex;flex-direction:column;gap:16px}
.card{border-radius:18px;background:var(--card);box-shadow:inset 0 0 0 1px var(--line);padding:20px}
.card h3{margin:0 0 10px;font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--acc-hi)}
.card p,.card li{color:var(--muted);font-size:14px;margin:0}
.card ul{margin:0;padding-left:18px;display:grid;gap:8px}
.card b{color:var(--text);font-weight:600}
.card code{font:12.5px var(--mono);background:rgba(255,255,255,.06);padding:1px 5px;border-radius:5px;color:#d4d4dc}
.card pre{margin:10px 0 0;padding:10px 12px;border-radius:10px;background:rgba(0,0,0,.35);box-shadow:inset 0 0 0 1px var(--line);font:12px/1.5 var(--mono);color:#d4d4dc;white-space:pre-wrap;word-break:break-all;max-height:160px;overflow:auto}
.card .row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.card .row button{height:34px;font-size:13px}
#mcp-check:empty{display:none}
#mcp-check{margin-top:10px}
.warn{border-radius:14px;padding:12px 14px;font-size:13.5px;background:color-mix(in srgb,var(--amber) 12%,transparent);color:#f7c46b;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--amber) 30%,transparent)}
@media (max-width:960px){.grid{grid-template-columns:1fr}.head{grid-template-columns:1fr}.who,.view-as{text-align:left}.seg{justify-content:flex-start}}
@media (max-width:640px){.app{grid-template-columns:1fr}.side{display:none}.panels{grid-template-columns:1fr 1fr}.main{padding:20px 16px}.seg a{padding:8px 12px}}
</style>
</head><body>
<header class="site-nav">
  <div class="wrap">
    <a class="logo" href="/" aria-label="Wicket home"><span class="orb" aria-hidden="true"><span class="sw"></span><span class="eyes"><i></i><i></i><i></i></span></span>Wicket</a>
    <nav class="nav-links" aria-label="Sections">
      <a href="/#demo">Product</a>
      <a href="/#how">How it works</a>
      <a href="/#hear-back">Hear back</a>
      <a href="/#features">Features</a>
      <a href="/#faq">FAQ</a>
      <a href="/demo" aria-current="page">Live demo</a>
    </nav>
    <a class="nav-gh" href="${REPO_URL}" aria-label="Wicket on GitHub"><svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z"/></svg></a>
    <a class="btn" href="/#start">Get started</a>
  </div>
</header>
<main class="wrap">
  <div class="head">
    <div>
      <h1>Wicket, <span class="serif">running live</span></h1>
      <p>This page plays an escape-room venue's software. The chat in the corner is the real Wicket server, answering from the Escape Director docs. Switch between an anonymous visitor and a signed-in customer to see what each gets.</p>
    </div>
    <div>
      <div class="view-as" aria-hidden="true">View as</div>
      <nav class="seg" aria-label="View as">${tab("visitor", "Visitor")}${tab("customer", "Signed-in customer")}</nav>
      <div class="who">${customer ? `Signed in as <b>${DEMO_USER.name}</b>, ${DEMO_USER.role} at ${DEMO_USER.venue}` : "Not signed in"}</div>
    </div>
  </div>
  <div class="grid">
    <section class="app" aria-label="Stand-in escape room software">
      <aside class="side">
        <div class="brand"><i></i>Escape Director</div>
        <div class="nav on"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10l9-7 9 7v10H3z"/></svg>Rooms</div>
        <div class="nav"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>Analytics</div>
        <div class="nav"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16v15H4zM4 10h16M9 3v4M15 3v4"/></svg>Bookings</div>
        <div class="nav"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/></svg>Settings</div>
        <div class="venue"><b>${DEMO_USER.venue}</b>Demo venue</div>
      </aside>
      <div class="main">
        <div class="crumbs" id="where">Rooms › The Treehouse</div>
        <div class="titlerow"><h2>The Treehouse</h2><span class="state" id="state">Live game running</span></div>
        <div class="panels">
          <div class="stat"><span>Time left</span><b id="timer">42:17</b></div>
          <div class="stat"><span>Clues sent</span><b id="clues">2</b></div>
          <div class="stat"><span>Puzzles solved</span><b>3 / 7</b></div>
        </div>
        <div class="actions">
          <button id="dash">Room Dashboard</button>
          <button id="pause">Pause game</button>
          <button class="primary" id="clue">Send Clue</button>
          <input class="clue" placeholder="Clue text (never recorded)" aria-label="Clue text">
        </div>
        <div class="puzzles">
          <div class="done"><span>Find the hidden key</span><em>solved 6:12</em></div>
          <div class="done"><span>Rope bridge sequence</span><em>solved 14:40</em></div>
          <div class="done"><span>Bird call lock</span><em>solved 21:05</em></div>
          <div><span>Lantern colors</span><em>in progress</em></div>
        </div>
      </div>
    </section>
    <aside class="notes">
      ${info.scripted ? `<div class="warn">No AI key is set on this server, so answers come from a scripted stand-in rather than Claude.</div>` : ""}
      <div class="card">
        <h3>What you're looking at</h3>
        <ul>
          <li><b>The chat is real.</b> ${info.scripted ? "It" : "Claude"} searches the Escape Director docs and links the section it used.</li>
          <li><b>Visitor:</b> anonymous docs questions after a bot check. No report buttons, since nobody could follow up.</li>
          <li><b>Signed-in customer:</b> this page signs you in as a fake customer, ${DEMO_USER.name}. <b>Report a bug</b> and <b>Request a feature</b> appear, and reports become tickets.</li>
          <li><b>Steps come along.</b> Press Pause and Send Clue, then report a bug: the assistant proposes those steps for the ticket.</li>
        </ul>
      </div>
      <div class="card">
        <h3>Hearing back (simulated)</h3>
        <p>Tickets go to a demo tracker inside this server, never to a real Linear or GitHub. About ${minutes} after you report, the ticket moves on (a bug to <b>Fixed</b>, an idea to <b>Planned</b>) and a simulated team reply arrives in the same chat. Keep the page open or come back later.</p>
      </div>
      ${info.mcp ? mcpCard() : ""}
      <div class="card">
        <h3>Limits</h3>
        <p>${budget ? `The whole demo shares one AI budget of ${budget} a month. ` : ""}Messages and chats are capped per person. Nothing here reaches a real team: handoffs explain what would happen instead.</p>
        <p style="margin-top:10px"><a href="${REPO_URL}">Read the code</a> · <a href="/">About Wicket</a></p>
      </div>
    </aside>
  </div>
</main>
<script>
// The stand-in app's own steps, for the trail that goes with a bug report.
var paused = false, left = 42 * 60 + 17, clues = 2;
setInterval(function () { if (paused || left <= 0) return; left--; document.getElementById("timer").textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0"); }, 1000);
document.getElementById("dash").onclick = function () { document.getElementById("where").textContent = "Rooms › The Treehouse › Room Dashboard"; Wicket.addBreadcrumb("Opened the Room Dashboard"); };
document.getElementById("pause").onclick = function (e) {
  paused = !paused;
  e.target.textContent = paused ? "Resume" : "Pause game";
  var s = document.getElementById("state"); s.textContent = paused ? "Paused" : "Live game running"; s.className = paused ? "state paused" : "state";
  Wicket.addBreadcrumb(paused ? "Paused the game" : "Resumed the game");
};
document.getElementById("clue").onclick = function () {
  Wicket.addBreadcrumb("Sent a Clue from the Room Dashboard");
  // The clue counter "breaks", so there's a bug to report.
  console.error("TypeError: Cannot read properties of undefined (reading 'clueCount')");
};
</script>
${info.mcp ? mcpScript(info.mcp.siteKey) : ""}
<script src="/widget.js"></script>
<script>
Wicket.init({
  user: { id: ${json(customer ? "demo-customer" : "demo-visitor")} },
  ${customer ? `userToken: ${TOKEN_FN},` : ""}
  context: { appVersion: "2.3.0", path: "/rooms/treehouse"${customer ? `, venue: ${json(DEMO_USER.venue)}, role: ${json(DEMO_USER.role)}` : ""} },
  title: "Escape Director Support",
});
if (window.innerWidth > 1600) Wicket.open();
</script>
</body></html>`;
}

/** The card that hands out a token for MCP clients, signed in as this browser's demo customer. */
function mcpCard(): string {
  return `<div class="card" id="mcp">
        <h3>Try it from Claude Code</h3>
        <p>Wicket is also an MCP server. Get a command, run it, then ask Claude Code to search the Escape Director docs, report a bug or check on your reports. You're ${DEMO_USER.name} there too, so reports show up in this chat's history.</p>
        <div id="mcp-check"></div>
        <div class="row"><button id="mcp-get">Get a command</button></div>
        <pre id="mcp-cmd" hidden></pre>
        <div class="row"><button id="mcp-copy" hidden>Copy</button></div>
        <p id="mcp-note" style="margin-top:10px;font-size:13px" hidden>The token lasts a day. It only works on this demo.</p>
      </div>`;
}

/** Runs the bot check, then fetches a token and shows the claude mcp add command. */
function mcpScript(siteKey: string): string {
  return `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>
<script>
(function () {
  var get = document.getElementById("mcp-get"), pre = document.getElementById("mcp-cmd"), copy = document.getElementById("mcp-copy"), note = document.getElementById("mcp-note");
  function fetchToken(turnstileToken) {
    return fetch("/api/demo/mcp-token", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turnstileToken: turnstileToken }) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "Couldn't get a token"); return d; }); })
      .then(function (d) {
        pre.textContent = "claude mcp add --transport http wicket-demo " + d.url + ' --header "Authorization: Bearer ' + d.token + '"';
        pre.hidden = false; copy.hidden = false; note.hidden = false; get.textContent = "Get a new command";
      })
      .catch(function (e) { pre.textContent = e.message; pre.hidden = false; })
      .finally(function () { get.disabled = false; });
  }
  get.onclick = function () {
    if (!window.turnstile) { pre.textContent = "The bot check is still loading. Try again in a moment."; pre.hidden = false; return; }
    get.disabled = true;
    var box = document.getElementById("mcp-check");
    box.innerHTML = "";
    turnstile.render(box, { sitekey: ${json(siteKey)}, theme: "dark", callback: function (t) { box.innerHTML = ""; fetchToken(t); }, "error-callback": function () { get.disabled = false; } });
  };
  copy.onclick = function () { navigator.clipboard.writeText(pre.textContent).then(function () { copy.textContent = "Copied"; setTimeout(function () { copy.textContent = "Copy"; }, 1500); }); };
})();
</script>`;
}
