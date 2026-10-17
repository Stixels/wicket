/** The test page at / (or /playground beside the marketing site), standing in for a host app. It follows the system's light or dark setting. */
export function playgroundPage(opts: { title: string; mode: "signed-in" | "visitor" | "unsigned"; plan?: string; initUser: string; base?: string }): string {
  const { mode, plan } = opts;
  const base = opts.base ?? "/";
  const current = mode === "visitor" ? "visitor" : plan === "pro" ? "pro" : "signed-in";
  const status =
    mode === "visitor"
      ? "Not signed in"
      : mode === "unsigned"
        ? "Test user (unsigned; set IDENTITY_SECRET for signed profiles)"
        : `Signed in as a test user${plan ? ` on the ${escapeHtml(plan)} plan` : ""}`;
  const tab = (key: string, href: string, label: string) =>
    `<a href="${href}"${current === key ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Wicket playground</title>
<style>
:root{--bg:#f6f6f8;--card:#fff;--text:#16161d;--muted:#6b6b76;--line:#e6e6ea;--chip:#efeff3;--on:#16161d;--on-text:#fff;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0d0d10;--card:#16161b;--text:#ececf1;--muted:#8d8d98;--line:#26262d;--chip:#1f1f25;--on:#ececf1;--on-text:#16161d;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:560px;margin:0 auto;padding:72px 20px 120px}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;letter-spacing:-.01em}
.brand .dot{width:10px;height:10px;border-radius:50%;background:currentColor}
.pill{font-size:12px;font-weight:500;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:1px 9px}
h1{font-size:26px;line-height:1.25;letter-spacing:-.02em;margin:28px 0 8px}
p{margin:0;color:var(--muted)}
.card{margin-top:28px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}
.label{font-size:12px;font-weight:500;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:10px}
.seg{display:flex;gap:4px;background:var(--chip);border-radius:10px;padding:4px}
.seg a{flex:1;text-align:center;padding:7px 10px;border-radius:7px;color:var(--text);text-decoration:none;font-weight:500;font-size:14px}
.seg a:hover{background:var(--card)}
.seg a[aria-current]{background:var(--on);color:var(--on-text)}
.status{margin-top:12px;font-size:13px}
ol{margin:0;padding:0;list-style:none;counter-reset:s}
ol li{counter-increment:s;display:flex;gap:12px;padding:8px 0;color:var(--muted)}
ol li::before{content:counter(s);flex:none;width:22px;height:22px;border-radius:50%;background:var(--chip);color:var(--text);font-size:12px;font-weight:600;display:grid;place-items:center;margin-top:1px}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--chip);padding:1px 5px;border-radius:5px;color:var(--text)}
footer{margin-top:28px;font-size:13px;color:var(--muted)}
</style>
</head><body>
<main>
<div class="brand"><span class="dot"></span>Wicket <span class="pill">Playground</span></div>
<h1>Try the support chat</h1>
<p>This page stands in for your app. Open the chat button in the corner and send a message.</p>
<div class="card">
<div class="label">View as</div>
<nav class="seg">${tab("signed-in", base, "Signed in")}${tab("pro", `${base}?plan=pro`, "Pro plan")}${tab("visitor", `${base}?as=visitor`, "Visitor")}</nav>
<p class="status">${status}.</p>
</div>
<div class="card">
<div class="label">How it works</div>
<ol>
<li><span>Ask something in the chat. The assistant answers from your docs when the profile allows it.</span></li>
<li><span>Anything it can't answer goes to the team as a post in <code>#support-inbox</code> and on the dashboard at <code>/admin</code>.</span></li>
<li><span>Replies from Discord or the dashboard show up back here.</span></li>
</ol>
</div>
<footer>Turn this page off with <code>PLAYGROUND=false</code>.</footer>
</main>
<script src="/widget.js"></script>
<script>Wicket.init({ title: ${JSON.stringify(opts.title).replace(/</g, "\\u003c")}, ${opts.initUser} context: { area: "playground" } });</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
