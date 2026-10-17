import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError, fileUrl, type Attachment, type ConversationDetail, type InboxItem, type Member, type Message, type Presence, type TeamEvent, type View } from "./api.js";
import { connectLive } from "./live.js";
import { EMOJI, GROUPS, recentEmoji, rememberEmoji, searchEmoji } from "./emoji.js";
import { RichText } from "./text.js";
import * as notifications from "./notify.js";
import { SavedReplies, fillReply, matchReplies, useSavedReplies, type SavedReply } from "./replies.js";
import "./styles.css";

declare global {
  interface Window {
    WICKET_TEAM: { productName: string; accent: string | null };
  }
}

const boot = window.WICKET_TEAM ?? { productName: "Wicket", accent: null };
if (boot.accent) document.documentElement.style.setProperty("--accent", boot.accent);

const VIEWS: { id: View; label: string; icon: ReactNode }[] = [
  { id: "open", label: "Open", icon: <Icon d="M4 6h16M4 12h16M4 18h10" /> },
  { id: "needs_reply", label: "Needs reply", icon: <Icon d="M21 12a9 9 0 1 1-3.5-7.1M21 4v5h-5" /> },
  { id: "mentions", label: "Mentions", icon: <Icon d="M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm0 0v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.6 7.2" /> },
  { id: "resolved", label: "Resolved", icon: <Icon d="M5 12.5 10 17 19 7" /> },
  { id: "all", label: "All", icon: <Icon d="M3 7h18M3 12h18M3 17h18" /> },
];

type Typing = { memberId: string | null; name: string; source: string; until: number };

// --- App -----------------------------------------------------------------------

function App() {
  const [me, setMe] = useState<Member | null>(null);
  const [signIn, setSignIn] = useState<SignInOptions | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ member: Member }>("/api/me")
      .then((d) => setMe(d.member))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) setSignIn(e.data.signIn ?? { discord: false, dev: false });
        else setError(e.message);
      });
  }, []);
  useEffect(load, [load]);

  if (me) return <Dashboard me={me} onSignOut={() => (setMe(null), load())} />;
  if (signIn) return <SignIn options={signIn} onDone={load} />;
  return <div className="splash">{error ?? <span className="spinner" />}</div>;
}

type SignInOptions = { discord: boolean; dev: boolean };

function SignIn({ options, onDone }: { options: SignInOptions; onDone: () => void }) {
  const error = new URLSearchParams(location.search).get("error");
  return (
    <div className="signin">
      <div className="signin-glow" />
      <div className="signin-card">
        <Logo size={44} />
        <h1>{boot.productName} team</h1>
        <p className="muted">Reply to conversations from the app, alongside Discord.</p>
        {error === "not-team" && <p className="alert">That Discord account isn't on the team. Ask for the Team role in the server.</p>}
        {error === "sign-in" && <p className="alert">Sign-in didn't go through. Try again.</p>}
        {options.discord && (
          <a className="btn btn-discord" href="/admin/auth/discord">
            <DiscordIcon /> Sign in with Discord
          </a>
        )}
        {options.dev && (
          <button className="btn btn-ghost" onClick={() => void api("/auth/dev", { json: {} }).then(onDone)}>
            Continue as local teammate
          </button>
        )}
        {!options.discord && !options.dev && <p className="muted small">Sign-in isn't set up yet. Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET on the server.</p>}
      </div>
    </div>
  );
}

// --- Dashboard ------------------------------------------------------------------

function Dashboard({ me, onSignOut }: { me: Member; onSignOut: () => void }) {
  const [view, setView] = useState<View>(() => (sessionGet("view") as View) || "open");
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [counts, setCounts] = useState<Partial<Record<View, number>>>({});
  const [selected, setSelected] = useState<string | null>(() => /^\/admin\/c\/([\w-]+)/.exec(location.pathname)?.[1] ?? null);
  const [members, setMembers] = useState<Member[]>([]);
  const [typing, setTyping] = useState<Record<string, Typing[]>>({});
  const [live, setLive] = useState<TeamEvent | null>(null);
  const [connected, setConnected] = useState(true);
  const [resync, setResync] = useState(0);

  const refresh = useCallback(() => {
    api<{ conversations: InboxItem[]; counts: Record<View, number> }>(`/api/conversations?view=${view}`)
      .then((d) => {
        setItems(d.conversations);
        setCounts(d.counts);
      })
      .catch((e) => e instanceof ApiError && e.status === 401 && onSignOut());
  }, [view, onSignOut]);

  useEffect(() => {
    sessionSet("view", view);
    refresh();
  }, [refresh, view]);

  useEffect(() => {
    void api<{ members: Member[] }>("/api/members").then((d) => setMembers(d.members));
  }, []);

  // Live updates. The list refetches (debounced); the open conversation gets the event itself.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    let timer: number | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => refreshRef.current(), 250);
    };
    const on = (data: string) => {
      const event = JSON.parse(data) as TeamEvent;
      setLive(event);
      notifications.notify(event, me, (id) => openRef.current(id));
      if (event.type === "typing") {
        if (event.memberId && event.memberId === me.id) return;
        setTyping((t) => {
          const list = (t[event.conversationId] ?? []).filter((x) => x.name !== event.name && x.until > Date.now());
          return { ...t, [event.conversationId]: [...list, { memberId: event.memberId, name: event.name, source: event.source, until: Date.now() + 6000 }] };
        });
        return;
      }
      if (event.type === "presence") {
        setItems((list) => list?.map((i) => (i.id === event.conversationId ? { ...i, presence: event.presence } : i)) ?? list);
        return;
      }
      if (event.type === "message" && event.message.author === "staff") {
        // Their reply landed, so they're done typing.
        setTyping((t) => ({ ...t, [event.conversationId]: (t[event.conversationId] ?? []).filter((x) => x.name !== event.message.authorName) }));
      }
      soon();
    };
    const stop = connectLive({
      url: "/admin/api/events",
      types: ["message", "status", "typing", "presence"],
      onEvent: (_type, data) => on(data),
      onStatus: (up, resumed) => {
        setConnected(up);
        // Events sent while we were away are gone, so catch up from the server. A dropped
        // connection can also mean the session ended; the list fetch signs out on a 401.
        if (resumed || !up) soon();
        if (resumed) setResync((n) => n + 1);
      },
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [me.id]);

  // Typing hints fade on their own.
  useEffect(() => {
    const t = setInterval(() => {
      setTyping((all) => {
        const now = Date.now();
        let changed = false;
        const next: Record<string, Typing[]> = {};
        for (const [k, v] of Object.entries(all)) {
          const keep = v.filter((x) => x.until > now);
          if (keep.length !== v.length) changed = true;
          if (keep.length) next[k] = keep;
        }
        return changed ? next : all;
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const open = (id: string | null) => {
    setSelected(id);
    history.pushState(null, "", id ? `/admin/c/${id}` : "/admin");
  };
  const openRef = useRef(open);
  openRef.current = open;
  const [askNotify, setAskNotify] = useState(() => notifications.supported && !notifications.decided());
  useEffect(() => {
    const onPop = () => setSelected(/^\/admin\/c\/([\w-]+)/.exec(location.pathname)?.[1] ?? null);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  // j/k to move through the list.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!items?.length || (e.target as HTMLElement).closest("textarea, input")) return;
      if (e.key !== "j" && e.key !== "k") return;
      const i = items.findIndex((x) => x.id === selected);
      const next = items[Math.min(items.length - 1, Math.max(0, i + (e.key === "j" ? 1 : -1)))];
      if (next) open(next.id);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  return (
    <div className={`shell ${selected ? "has-selection" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <Logo size={26} />
          <div>
            <div className="brand-name">{boot.productName}</div>
            <div className="brand-sub">Team inbox</div>
          </div>
        </div>
        <nav>
          {VIEWS.map((v) => (
            <button key={v.id} className={`nav-item ${view === v.id ? "active" : ""}`} onClick={() => setView(v.id)}>
              {v.icon}
              <span>{v.label}</span>
              {v.id !== "all" && v.id !== "resolved" && counts[v.id] ? (
                <span className={`count ${v.id === "needs_reply" || v.id === "mentions" ? "hot" : ""}`}>{counts[v.id]}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <ProfileMenu me={me} onSignOut={onSignOut} />
        </div>
      </aside>

      <section className="list">
        <header className="list-head">
          <h2>{VIEWS.find((v) => v.id === view)?.label}</h2>
          <div className="mobile-brand">
            <Logo size={26} />
            <span>{boot.productName}</span>
          </div>
          {!connected && <span className="offline">Reconnecting…</span>}
        </header>
        <div className="view-tabs" role="tablist">
          {VIEWS.filter((v) => v.id !== "all").map((v) => (
            <button key={v.id} role="tab" aria-selected={view === v.id} className={view === v.id ? "on" : ""} onClick={() => setView(v.id)}>
              {v.label}
              {(v.id === "needs_reply" || v.id === "mentions") && counts[v.id] ? <span className="count hot">{counts[v.id]}</span> : null}
            </button>
          ))}
        </div>
        {askNotify && (
          <div className="notify-ask">
            <Icon d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
            <span>Get a desktop notification when someone needs the team.</span>
            <button className="btn btn-sm" onClick={() => void notifications.setEnabled(true).then(() => setAskNotify(false))}>
              Turn on
            </button>
            <button className="icon-btn" title="Not now" onClick={() => (notifications.dismiss(), setAskNotify(false))}>
              <Icon d="M18 6 6 18M6 6l12 12" />
            </button>
          </div>
        )}
        <div className="list-body">
          {items === null ? (
            <div className="empty">
              <span className="spinner" />
            </div>
          ) : items.length === 0 ? (
            <EmptyList view={view} />
          ) : (
            items.map((item) => <ListItem key={item.id} item={item} active={item.id === selected} typing={typing[item.id]} onClick={() => open(item.id)} />)
          )}
        </div>
      </section>

      <main className="detail">
        {selected ? (
          <Conversation key={selected} id={selected} me={me} members={members} live={live} resync={resync} typing={typing[selected] ?? []} onBack={() => open(null)} onChange={refresh} />
        ) : (
          <div className="empty big">
            <Logo size={56} muted />
            <p>Pick a conversation</p>
            <span className="muted small">
              Replies reach the user in the app and show up in Discord.
            </span>
          </div>
        )}
      </main>
    </div>
  );
}

function EmptyList({ view }: { view: View }) {
  const text: Record<View, string> = {
    open: "No open conversations.",
    needs_reply: "Nobody is waiting on the team. 🎉",
    mentions: "No one has mentioned you.",
    resolved: "Nothing resolved yet.",
    all: "No conversations yet.",
  };
  return <div className="empty">{text[view]}</div>;
}

function ListItem({ item, active, typing, onClick }: { item: InboxItem; active: boolean; typing?: Typing[]; onClick: () => void }) {
  const who = item.reporter.name ?? item.reporter.email ?? "Visitor";
  const typers = (typing ?? []).filter((t) => t.until > Date.now());
  return (
    <button className={`item ${active ? "active" : ""} ${item.needsReply ? "unread" : ""} ${item.status === "resolved" ? "done" : ""}`} onClick={onClick}>
      <UserAvatar name={who} size={36} presence={item.presence} />
      <div className="item-main">
        <div className="item-top">
          <span className="item-name">{who}</span>
          {item.mentionsMe && <span className="at-you" title="A teammate mentioned you">@</span>}
          {item.participants.length > 0 && <AvatarStack people={item.participants.map((p) => ({ name: p.name }))} max={3} size={16} />}
          <span className="item-time">{ago(item.updatedAt)}</span>
        </div>
        <div className="item-title">{item.title}</div>
        <div className="item-last">
          {typers.length ? (
            <span className="typing-text">
              <Dots /> {names(typers.map((t) => t.name))} {typers.length > 1 ? "are" : "is"} typing
            </span>
          ) : item.last && !(item.last.author === "user" && item.title.startsWith(item.last.body.slice(0, 100))) ? (
            <>
              <span className="who">{lastWho(item.last)}</span> {item.last.body}
            </>
          ) : (
            <span className="state">{stateText(item)}</span>
          )}
        </div>
      </div>
    </button>
  );
}

function lastWho(last: NonNullable<InboxItem["last"]>): string {
  if (last.author === "user") return "";
  if (last.author === "agent") return "Assistant:";
  if (last.author === "note") return `${last.authorName ?? "Team"} (note):`;
  if (last.author === "staff") return `${last.authorName ?? "Team"}:`;
  return "";
}

/** One quiet line for where a conversation stands. */
function stateText(item: { status: InboxItem["status"]; needsReply: boolean }): string {
  if (item.needsReply) return item.status === "needs_human" ? "Waiting for the team" : "New reply";
  if (item.status === "agent") return "With the assistant";
  if (item.status === "human") return "With the team";
  return "Resolved";
}

// --- Conversation -----------------------------------------------------------------

function Conversation({
  id,
  me,
  members,
  live,
  resync,
  typing,
  onBack,
  onChange,
}: {
  id: string;
  me: Member;
  members: Member[];
  live: TeamEvent | null;
  resync: number;
  typing: Typing[];
  onBack: () => void;
  onChange: () => void;
}) {
  const [conv, setConv] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(() => sessionGet("details") !== "0");
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const load = useCallback(() => {
    api<{ conversation: ConversationDetail; messages: Message[] }>(`/api/conversations/${id}`)
      .then((d) => {
        setConv(d.conversation);
        setMessages(d.messages);
      })
      .catch((e) => setError(e.message));
  }, [id]);
  // Reload after a reconnect too, since live events may have been missed.
  useEffect(load, [load, resync]);

  useEffect(() => {
    if (!live || live.conversationId !== id) return;
    if (live.type === "message")
      setMessages((m) => (m.some((x) => x.id === live.message.id) ? m.map((x) => (x.id === live.message.id ? live.message : x)) : [...m, live.message]));
    if (live.type === "status") setConv((c) => (c ? { ...c, status: live.status } : c));
    if (live.type === "presence") setConv((c) => (c ? { ...c, presence: live.presence } : c));
    if (live.type !== "typing" && live.type !== "presence") {
      // Who has replied and whether someone is waiting come from the server.
      const t = setTimeout(load, 300);
      return () => clearTimeout(t);
    }
  }, [live, id, load]);

  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, typing.length]);

  if (error) return <div className="empty">{error}</div>;
  if (!conv) return <div className="empty"><span className="spinner" /></div>;

  const who = conv.reporter.name ?? conv.reporter.email ?? "Visitor";
  const memberNames = members.map((m) => m.name);
  const typers = typing.filter((t) => t.until > Date.now());

  return (
    <div className={`conv ${showDetails ? "with-details" : ""}`}>
      <div className="conv-main">
        <header className="conv-head">
          <button className="icon-btn back" onClick={onBack} title="Back">
            <Icon d="M15 18l-6-6 6-6" />
          </button>
          <UserAvatar name={who} size={36} presence={conv.presence} />
          <div className="conv-title">
            <div className="conv-name">{who}</div>
            <div className="conv-sub">
              <span className={`state-dot ${conv.needsReply ? "hot" : conv.status}`} />
              {stateText(conv)}
              {presenceText(conv.presence) && <span className={`presence-text ${conv.presence.state}`}> · {presenceText(conv.presence)}</span>}
              {conv.participants.length > 0 && <> · {names(conv.participants.map((p) => (p.memberId === me.id ? "you" : p.name)))} replied</>}
            </div>
          </div>
          <div className="conv-actions">
            {conv.discordUrl && (
              <a className="icon-btn" href={conv.discordUrl} target="_blank" rel="noreferrer" title="Open in Discord">
                <DiscordIcon />
              </a>
            )}
            {conv.status !== "resolved" && (
              <button
                className="btn btn-sm btn-resolve"
                onClick={() =>
                  void api(`/api/conversations/${id}/resolve`, { json: {} }).then(() => {
                    load();
                    onChange();
                  })
                }
              >
                <Icon d="M5 12.5 10 17 19 7" /> <span className="hide-sm">Resolve</span>
              </button>
            )}
            <button
              className={`icon-btn details-toggle ${showDetails ? "on" : ""}`}
              title="Details"
              onClick={() => {
                setShowDetails(!showDetails);
                sessionSet("details", showDetails ? "0" : "1");
              }}
            >
              <Icon d="M4 5h16v14H4zM15 5v14" />
            </button>
          </div>
        </header>

        <div
          className="log"
          ref={logRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className="log-inner">
            <div className="log-start">
              Started {new Date(conv.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
            </div>
            {messages.map((m, i) => (
              <Bubble key={m.id} m={m} prev={messages[i - 1]} me={me} memberNames={memberNames} reporter={who} conversationId={conv.id} />
            ))}
            {typers.length > 0 && (
              <div className="row team">
                <div className="bubble typing-bubble">
                  <Dots /> {names(typers.map((t) => t.name))} {typers.length > 1 ? "are" : "is"} typing
                  {typers.length === 1 && typers[0]!.source !== "dashboard" ? ` in ${cap(typers[0]!.source)}` : ""}
                </div>
              </div>
            )}
          </div>
        </div>

        <Composer conversation={conv} members={members} me={me} onSent={(m) => setMessages((list) => (list.some((x) => x.id === m.id) ? list : [...list, m]))} />
      </div>
      {showDetails && <Details conv={conv} me={me} />}
    </div>
  );
}

function Bubble({
  m,
  prev,
  me,
  memberNames,
  reporter,
  conversationId,
}: {
  m: Message;
  prev?: Message;
  me: Member;
  memberNames: string[];
  reporter: string;
  conversationId: string;
}) {
  if (m.author === "system") {
    const done = m.body === "Marked as resolved" || m.body.startsWith("The team marked this conversation as resolved");
    return done ? (
      <div className="sys done">
        <Icon d="M5 12.5 10 17 19 7" /> Marked as resolved
      </div>
    ) : (
      <div className="sys">{m.body}</div>
    );
  }
  const grouped = prev && prev.author === m.author && prev.authorName === m.authorName && m.createdAt - prev.createdAt < 5 * 60_000;
  const side = m.author === "user" ? "them" : "team";
  const name = m.author === "user" ? reporter : m.author === "agent" ? "Assistant" : m.memberId === me.id ? "You" : (m.authorName ?? "Team");
  if (m.author === "note") {
    return (
      <div className={`note ${m.mentions.includes(me.id) ? "for-me" : ""}`}>
        <div className="note-head">
          <Icon d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4" />
          <b>{name}</b>
          <span className="note-tag" title="Only the team sees notes">Team note</span>
          <span className="time">{time(m.createdAt)}</span>
        </div>
        <div className="note-body">
          <RichText text={m.body} members={memberNames} />
        </div>
      </div>
    );
  }
  return (
    <div className={`row ${side} ${grouped ? "grouped" : ""}`}>
      {!grouped && (
        <div className="meta">
          <span className={`meta-name ${m.author}`}>{name}</span>
          <span className="time">{time(m.createdAt)}</span>
        </div>
      )}
      <div className={`bubble ${m.author}`}>
        {m.body && <RichText text={m.body} />}
        {m.attachments.length > 0 && <Files files={m.attachments} conversationId={conversationId} />}
        {m.evidence && m.evidence.length > 0 && (
          <details className="evidence">
            <summary>How we got this</summary>
            <ul>
              {m.evidence.map((e) => (
                <li key={e.id}>
                  <b>{e.id}</b> {e.label}: {e.value}
                  {[e.period, e.basis, ...(e.caveats ?? [])].filter(Boolean).length > 0 && <small> · {[e.period, e.basis, ...(e.caveats ?? [])].filter(Boolean).join(" · ")}</small>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      {m.rating && (
        <div className={`rating ${m.rating}`} title={m.rating === "up" ? "They found this helpful" : "They found this unhelpful"}>
          {m.rating === "up" ? "👍 Helpful" : "👎 Not helpful"}
        </div>
      )}
    </div>
  );
}

function Files({ files, conversationId }: { files: Attachment[]; conversationId: string }) {
  const remove = (f: Attachment) => {
    if (!confirm(`Delete “${f.name}” for everyone? It's removed from Wicket and the user's chat. Copies already in Discord stay there.`)) return;
    api(`/api/conversations/${conversationId}/files/${f.id}`, { method: "DELETE" }).catch((e) => alert(e.message));
  };
  return (
    <div className="files">
      {files.map((f) =>
        f.expired ? (
          <div key={f.id} className="file expired" title="This file was removed">
            <Icon d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6ZM9.5 12.5l5 5m0-5-5 5" />
            <span>
              <b>{f.name}</b>
              <small>Removed</small>
            </span>
          </div>
        ) : (
          <div key={f.id} className="file-item">
            {f.type.startsWith("image/") ? (
              <a href={fileUrl(f)} target="_blank" rel="noreferrer" className="file-img">
                <img src={fileUrl(f)} alt={f.name} loading="lazy" />
              </a>
            ) : (
              <a href={fileUrl(f)} target="_blank" rel="noreferrer" className="file">
                <Icon d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6" />
                <span>
                  <b>{f.name}</b>
                  <small>{size(f.size)}</small>
                </span>
              </a>
            )}
            <button className="file-del" title="Delete file" aria-label={`Delete ${f.name}`} onClick={() => remove(f)}>
              <Icon d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
            </button>
          </div>
        ),
      )}
    </div>
  );
}

function Composer({ conversation, members, me, onSent }: { conversation: ConversationDetail; members: Member[]; me: Member; onSent: (m: Message) => void }) {
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [text, setText] = useState(() => sessionGet(`draft:${conversation.id}`) ?? "");
  const [files, setFiles] = useState<(Attachment & { uploading?: boolean })[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mention, setMention] = useState<{ query: string; start: number; index: number } | null>(null);
  // "/" at the start of an empty reply searches saved replies.
  const [slash, setSlash] = useState<{ query: string; index: number } | null>(null);
  const saved = useSavedReplies();
  const slashMatches = useMemo(() => (slash ? matchReplies(saved, slash.query).slice(0, 6) : []), [slash, saved]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastPing = useRef(0);

  useEffect(() => sessionSet(`draft:${conversation.id}`, text), [text, conversation.id]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [text]);

  const candidates = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return members.filter((m) => m.id !== me.id && m.name.toLowerCase().includes(q)).slice(0, 6);
  }, [mention, members, me.id]);

  const onInput = (value: string, caret: number) => {
    setText(value);
    setError(null);
    // "@al" right before the caret opens the teammate picker, and turns this into a note.
    const m = /(^|\s)@([\p{L}\d._-]*)$/u.exec(value.slice(0, caret));
    setMention(m ? { query: m[2]!, start: caret - m[2]!.length - 1, index: 0 } : null);
    const s = /^\/([^\n]*)$/.exec(value);
    setSlash(s ? { query: s[1]!, index: 0 } : null);
    if (Date.now() - lastPing.current > 3000 && value.trim()) {
      lastPing.current = Date.now();
      void api(`/api/conversations/${conversation.id}/typing`, { json: {} }).catch(() => {});
    }
  };

  const pick = (m: Member) => {
    if (!mention) return;
    const el = ref.current!;
    const caret = el.selectionStart;
    const next = `${text.slice(0, mention.start)}@${m.name} ${text.slice(caret)}`;
    setText(next);
    setMention(null);
    setMode("note");
    requestAnimationFrame(() => {
      const pos = mention.start + m.name.length + 2;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  /** Uses a saved reply: it replaces a "/search", otherwise goes in at the caret. */
  const applyReply = (r: SavedReply) => {
    const body = fillReply(r.body, conversation.reporter.name);
    setSlash(null);
    if (!text.trim() || text.startsWith("/")) {
      setText(body);
      requestAnimationFrame(() => {
        ref.current?.focus();
        ref.current?.setSelectionRange(body.length, body.length);
      });
    } else insert(body);
  };

  /** Puts text at the caret, e.g. an emoji from the picker. */
  const insert = (value: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    setText(text.slice(0, start) + value + text.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + value.length, start + value.length);
    });
  };

  const upload = async (list: FileList | File[]) => {
    for (const file of Array.from(list).slice(0, 10)) {
      const temp = { id: `tmp-${Math.random()}`, name: file.name, type: file.type, size: file.size, uploading: true };
      setFiles((f) => [...f, temp]);
      const form = new FormData();
      form.append("file", file);
      try {
        const { file: saved } = await api<{ file: Attachment }>(`/api/conversations/${conversation.id}/files`, { form });
        setFiles((f) => f.map((x) => (x.id === temp.id ? saved : x)));
      } catch (e) {
        setFiles((f) => f.filter((x) => x.id !== temp.id));
        setError((e as Error).message);
      }
    }
  };

  const send = async () => {
    const body = text.trim();
    const ready = files.filter((f) => !f.uploading);
    if (sending || (!body && (mode === "note" || !ready.length))) return;
    if (files.some((f) => f.uploading)) return setError("Wait for the files to finish uploading.");
    const mentions = members.filter((m) => body.includes(`@${m.name}`)).map((m) => m.id);
    setSending(true);
    try {
      const { message } = await api<{ message: Message }>(`/api/conversations/${conversation.id}/messages`, {
        json: { body, note: mode === "note", mentions, attachments: mode === "reply" ? ready.map((f) => f.id) : [] },
      });
      onSent(message);
      setText("");
      setFiles([]);
      setMode("reply");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash && slashMatches.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setSlash({ ...slash, index: (slash.index + d + slashMatches.length) % slashMatches.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyReply(slashMatches[slash.index]!);
        return;
      }
      if (e.key === "Escape") return setSlash(null);
    }
    if (mention && candidates.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setMention({ ...mention, index: (mention.index + d + candidates.length) % candidates.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(candidates[mention.index]!);
        return;
      }
      if (e.key === "Escape") return setMention(null);
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const note = mode === "note";
  return (
    <div className={`composer ${note ? "is-note" : ""}`}>
      {conversation.status === "agent" && !note && (
        <div className="composer-hint">The assistant is handling this. Replying takes over from it.</div>
      )}
      {conversation.status === "resolved" && !note && <div className="composer-hint">Resolved. Replying reopens it for the user.</div>}
      <div
        className="composer-box"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length && !note) void upload(e.dataTransfer.files);
        }}
      >
        <div className="composer-tabs">
          <button className={!note ? "on" : ""} onClick={() => setMode("reply")}>
            Reply
          </button>
          <button className={note ? "on" : ""} onClick={() => setMode("note")}>
            Note
          </button>
          <span className="composer-tip">{note ? "Only the team sees notes. Type @ to hand off." : `Goes to ${conversation.reporter.name ?? "the user"} in the app and to Discord`}</span>
        </div>
        {mention && candidates.length > 0 && (
          <div className="mentions-pop">
            {candidates.map((m, i) => (
              <button key={m.id} className={i === mention.index ? "on" : ""} onMouseDown={(e) => (e.preventDefault(), pick(m))}>
                <Avatar name={m.name} url={m.avatarUrl} size={20} /> {m.name}
              </button>
            ))}
          </div>
        )}
        {slash && (
          <div className="mentions-pop slash-pop">
            {slashMatches.length ? (
              slashMatches.map((r, i) => (
                <button key={r.id} className={i === slash.index ? "on" : ""} onMouseDown={(e) => (e.preventDefault(), applyReply(r))}>
                  <b>{r.title}</b>
                  <span>{r.body}</span>
                </button>
              ))
            ) : (
              <div className="slash-none">{saved.length ? "No saved reply matches" : "No saved replies yet. Add one with the ⚡ button."}</div>
            )}
          </div>
        )}
        <textarea
          ref={ref}
          rows={2}
          value={text}
          placeholder={note ? "Write a note for the team…" : "Write a reply… (/ for saved replies)"}
          onChange={(e) => onInput(e.target.value, e.target.selectionStart)}
          onKeyDown={onKey}
          onPaste={(e) => {
            if (e.clipboardData.files.length && !note) {
              e.preventDefault();
              void upload(e.clipboardData.files);
            }
          }}
        />
        {files.length > 0 && !note && (
          <div className="pending">
            {files.map((f) => (
              <span key={f.id} className={`pend ${f.uploading ? "up" : ""}`}>
                {f.name}
                <button onClick={() => setFiles((list) => list.filter((x) => x.id !== f.id))} title="Remove">
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-foot">
          {!note && (
            <>
              <button className="icon-btn" title="Attach files" onClick={() => fileInput.current?.click()}>
                <Icon d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7" />
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) void upload(e.target.files);
                  e.target.value = "";
                }}
              />
            </>
          )}
          <EmojiPicker onPick={insert} />
          <SavedReplies draft={text} onPick={applyReply} Icon={Icon} />
          {error && <span className="composer-error">{error}</span>}
          <span className="spacer" />
          <button className={`btn btn-send ${note ? "btn-note" : ""}`} disabled={sending || (!text.trim() && (note || !files.length))} onClick={() => void send()}>
            {note ? "Add note" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Details({ conv, me }: { conv: ConversationDetail; me: Member }) {
  const ctx = conv.context ?? {};
  const errors = Array.isArray(ctx.errors) ? (ctx.errors as unknown[]) : [];
  const fields = Object.entries(ctx).filter(([k, v]) => k !== "errors" && v !== null && v !== "" && v !== undefined);
  return (
    <aside className="details">
      <section>
        <h3>Person</h3>
        <dl>
          <dt>Name</dt>
          <dd>{conv.reporter.name ?? "Not given"}</dd>
          <dt>Email</dt>
          <dd>{conv.reporter.email ? <a href={`mailto:${conv.reporter.email}`}>{conv.reporter.email}</a> : "Not given"}</dd>
          <dt>Signed in</dt>
          <dd>{conv.reporter.signedIn ? "Yes" : "No (visitor)"}</dd>
          {conv.reporter.plan && (
            <>
              <dt>Plan</dt>
              <dd>{conv.reporter.plan}</dd>
            </>
          )}
        </dl>
      </section>
      {conv.tickets && conv.tickets.length > 0 && (
        <section>
          <h3>Tickets</h3>
          <ul className="tickets">
            {conv.tickets.map((t) => (
              <li key={t.key}>
                <a href={t.url} target="_blank" rel="noreferrer">
                  {t.key}
                </a>{" "}
                {t.title}
                <div className="muted small">
                  {t.relation === "filed" ? "Filed from this chat" : "Added as another report"} ·{" "}
                  {t.state === "done" ? (t.notified ? "done, they were told" : "done") : t.state === "closed" ? "closed" : "open, they'll hear back when it's done"}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {fields.length > 0 && (
        <section>
          <h3>From the app</h3>
          <dl>
            {fields.map(([k, v]) => (
              <div key={k} className="dl-row">
                <dt>{label(k)}</dt>
                <dd>{typeof v === "object" ? <code>{JSON.stringify(v)}</code> : String(v)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {errors.length > 0 && (
        <section>
          <h3>Recent errors</h3>
          <ul className="errors">
            {errors.slice(-10).map((e, i) => (
              <li key={i}>
                <code>{typeof e === "string" ? e : JSON.stringify(e)}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h3>Team</h3>
        <p className="muted small">
          {conv.participants.length
            ? `${names(conv.participants.map((p) => (p.memberId === me.id ? "You" : p.name)))} replied. Anyone can jump in.`
            : "Nobody from the team has replied yet. Anyone can jump in."}
        </p>
      </section>
    </aside>
  );
}

// --- Bits -------------------------------------------------------------------------

function Avatar({ name, url, size = 28 }: { name: string; url?: string | null; size?: number }) {
  const hue = [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
  const initials = name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4, ["--hue" as string]: hue }} title={name}>
      {url ? <img src={url} alt="" /> : initials || "?"}
    </span>
  );
}

/** The user's avatar, with a dot while they're around: solid in the chat, ring on the site. */
function UserAvatar({ name, size, presence }: { name: string; size: number; presence?: Presence }) {
  const state = presence?.state ?? "offline";
  return (
    <span className="presence-wrap">
      <Avatar name={name} size={size} />
      {state !== "offline" && <i className={`pdot ${state}`} title={presenceText(presence!) ?? ""} />}
    </span>
  );
}

function presenceText(p: Presence): string | null {
  if (p.state === "viewing") return "In the chat now";
  if (p.state === "online") return "On the site";
  if (!p.lastSeenAt) return null;
  const a = ago(p.lastSeenAt);
  if (a === "now") return "Left just now";
  return /^\d/.test(a) ? `Last seen ${a} ago` : `Last seen ${a}`;
}

function AvatarStack({ people, max = 4, size = 22 }: { people: { name: string; avatarUrl?: string | null }[]; max?: number; size?: number }) {
  if (!people.length) return null;
  return (
    <span className="stack" title={people.map((p) => p.name).join(", ")}>
      {people.slice(0, max).map((p, i) => (
        <Avatar key={i} name={p.name} url={p.avatarUrl} size={size} />
      ))}
      {people.length > max && (
        <span className="avatar more" style={{ width: size, height: size, fontSize: size * 0.4 }}>
          +{people.length - max}
        </span>
      )}
    </span>
  );
}

/** You, in the corner: one quiet row that opens a small menu for the theme and signing out. */
function ProfileMenu({ me, onSignOut }: { me: Member; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "dark");
  const [notifyOn, setNotifyOn] = useState(notifications.enabled);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    setNotifyOn(notifications.enabled());
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("mousedown", close);
    addEventListener("keydown", esc);
    return () => {
      removeEventListener("mousedown", close);
      removeEventListener("keydown", esc);
    };
  }, [open]);
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("wicket-team-theme", next);
    } catch {}
    setTheme(next);
  };
  return (
    <div className="me-wrap" ref={ref}>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-who">
            <b>{me.name}</b>
            <span>{me.discordId ? "Signed in with Discord" : "Local sign-in"}</span>
          </div>
          <button role="menuitem" onClick={toggleTheme}>
            {theme === "dark" ? <Icon d="M12 3v2M12 19v2M5 5l1.5 1.5M17.5 17.5 19 19M3 12h2M19 12h2M5 19l1.5-1.5M17.5 6.5 19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" /> : <Icon d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />}
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
          {notifications.supported && (
            <button role="menuitem" onClick={() => void notifications.setEnabled(!notifyOn).then(setNotifyOn)}>
              <Icon d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
              Notifications
              <span className={`menu-state ${notifyOn ? "on" : ""}`}>{notifyOn ? "On" : "Off"}</span>
            </button>
          )}
          <button role="menuitem" onClick={() => void api("/auth/logout", { json: {} }).then(onSignOut)}>
            <Icon d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3" />
            Sign out
          </button>
        </div>
      )}
      <button className={`me ${open ? "on" : ""}`} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title={me.name}>
        <Avatar name={me.name} url={me.avatarUrl} size={28} />
        <span className="me-name">{me.name}</span>
        <Icon d="M8 9l4-4 4 4M8 15l4 4 4-4" />
      </button>
    </div>
  );
}

function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    addEventListener("mousedown", close);
    return () => removeEventListener("mousedown", close);
  }, [open]);
  useEffect(() => setQuery(""), [open]);

  const results = useMemo(() => (query.trim() ? searchEmoji(query) : []), [query]);
  const recents = useMemo(() => (open ? recentEmoji() : []), [open]);
  const pick = (char: string) => {
    rememberEmoji(char);
    onPick(char);
    setOpen(false);
  };
  const grid = (list: string[]) => (
    <div className="emoji-grid">
      {list.map((e) => (
        <button key={e} onMouseDown={(ev) => ev.preventDefault()} onClick={() => pick(e)}>
          {e}
        </button>
      ))}
    </div>
  );

  return (
    <div className="emoji-wrap" ref={ref}>
      <button className={`icon-btn ${open ? "on" : ""}`} title="Emoji" aria-label="Emoji" onClick={() => setOpen(!open)}>
        <Icon d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8.5 14.5s1.2 1.8 3.5 1.8 3.5-1.8 3.5-1.8M9 9.5h.01M15 9.5h.01" />
      </button>
      {open && (
        <div className="emoji-pop" role="dialog" aria-label="Pick an emoji">
          <input
            className="emoji-search"
            autoFocus
            placeholder="Search emoji"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              if (e.key === "Enter") {
                e.preventDefault();
                if (results[0]) pick(results[0].char);
              }
            }}
          />
          <div className="emoji-scroll">
            {query.trim() ? (
              results.length ? (
                grid(results.map((e) => e.char))
              ) : (
                <div className="emoji-none">No emoji for “{query.trim()}”</div>
              )
            ) : (
              <>
                {recents.length > 0 && (
                  <>
                    <div className="emoji-head">Recent</div>
                    {grid(recents)}
                  </>
                )}
                {GROUPS.map((g) => (
                  <div key={g}>
                    <div className="emoji-head">{g}</div>
                    {grid(EMOJI.filter((e) => e.group === g).map((e) => e.char))}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Logo({ size = 28, muted = false }: { size?: number; muted?: boolean }) {
  return (
    <span className={`logo ${muted ? "muted" : ""}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 6.5 7.6 18 12 9.5 16.4 18 20 6.5" />
      </svg>
    </span>
  );
}

function Icon({ d }: { d: string }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

function DiscordIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
      <path d="M19.6 5.3A16.6 16.6 0 0 0 15.5 4l-.5 1a15.3 15.3 0 0 0-6 0L8.5 4a16.6 16.6 0 0 0-4.1 1.3C1.8 9.2 1.1 13 1.4 16.7a16.7 16.7 0 0 0 5 2.6l1.1-1.8a10.8 10.8 0 0 1-1.7-.8l.4-.3a11.9 11.9 0 0 0 10.2 0l.4.3c-.5.3-1.1.6-1.7.8l1.1 1.8a16.6 16.6 0 0 0 5-2.6c.4-4.3-.7-8-3-11.4ZM8.7 14.5c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm6.6 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z" />
    </svg>
  );
}

function Dots() {
  return (
    <span className="dots">
      <i />
      <i />
      <i />
    </span>
  );
}

function names(list: string[]): string {
  const uniq = [...new Set(list)];
  if (uniq.length <= 1) return uniq[0] ?? "";
  return `${uniq.slice(0, -1).join(", ")} and ${uniq.at(-1)}`;
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

function time(ms: number): string {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function size(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function label(k: string): string {
  return k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function sessionGet(k: string): string | null {
  try {
    return sessionStorage.getItem(`wicket-team:${k}`);
  } catch {
    return null;
  }
}

function sessionSet(k: string, v: string) {
  try {
    if (v) sessionStorage.setItem(`wicket-team:${k}`, v);
    else sessionStorage.removeItem(`wicket-team:${k}`);
  } catch {}
}

createRoot(document.getElementById("root")!).render(<App />);
