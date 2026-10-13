import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { api } from "./api.js";

export interface SavedReply {
  id: string;
  title: string;
  body: string;
}

/** The team's saved replies, loaded once and shared by every composer. */
let cache: SavedReply[] | null = null;
const listeners = new Set<(r: SavedReply[]) => void>();

function publish(next: SavedReply[]) {
  cache = [...next].sort((a, b) => a.title.localeCompare(b.title));
  for (const l of listeners) l(cache);
}

export function useSavedReplies(): SavedReply[] {
  const [list, setList] = useState<SavedReply[]>(cache ?? []);
  useEffect(() => {
    listeners.add(setList);
    if (!cache) void api<{ replies: SavedReply[] }>("/api/replies").then((d) => publish(d.replies)).catch(() => {});
    return () => void listeners.delete(setList);
  }, []);
  return list;
}

export function matchReplies(list: SavedReply[], query: string): SavedReply[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((r) => r.title.toLowerCase().includes(q) || r.body.toLowerCase().includes(q));
}

/** Fills in {name} with the person's first name. */
export function fillReply(body: string, name: string | null): string {
  const first = name?.trim().split(/\s+/)[0];
  return body.replace(/\{name\}/gi, first || "there");
}

async function save(reply: { id?: string; title: string; body: string }) {
  const { reply: saved } = await api<{ reply: SavedReply }>(reply.id ? `/api/replies/${reply.id}` : "/api/replies", {
    method: reply.id ? "PUT" : "POST",
    json: { title: reply.title, body: reply.body },
  });
  publish([...(cache ?? []).filter((r) => r.id !== saved.id), saved]);
}

async function remove(id: string) {
  await api(`/api/replies/${id}`, { method: "DELETE" });
  publish((cache ?? []).filter((r) => r.id !== id));
}

/** The composer's saved-replies button: search and insert, and add, edit or delete replies. */
export function SavedReplies({ draft, onPick, Icon }: { draft: string; onPick: (r: SavedReply) => void; Icon: (p: { d: string }) => JSX.Element }) {
  const replies = useSavedReplies();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ id?: string; title: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    addEventListener("mousedown", close);
    return () => removeEventListener("mousedown", close);
  }, [open]);
  useEffect(() => {
    setQuery("");
    setEditing(null);
    setError(null);
  }, [open]);
  const shown = useMemo(() => matchReplies(replies, query), [replies, query]);

  const submit = async () => {
    if (!editing) return;
    try {
      await save(editing);
      setEditing(null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="emoji-wrap" ref={ref}>
      <button className={`icon-btn ${open ? "on" : ""}`} title="Saved replies (type / in an empty reply)" aria-label="Saved replies" onClick={() => setOpen(!open)}>
        <Icon d="M13 2 4.5 13.5H12L11 22l8.5-11.5H12L13 2Z" />
      </button>
      {open && (
        <div className="emoji-pop replies-pop" role="dialog" aria-label="Saved replies">
          {editing ? (
            <form
              className="reply-form"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <div className="emoji-head">{editing.id ? "Edit saved reply" : "New saved reply"}</div>
              <input autoFocus placeholder="Title, e.g. Clear cache" value={editing.title} maxLength={80} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
              <textarea rows={5} placeholder="The reply. {name} becomes the person's first name." value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
              {error && <div className="composer-error">{error}</div>}
              <div className="reply-form-foot">
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(null)}>
                  Cancel
                </button>
                <button className="btn btn-sm btn-send" disabled={!editing.title.trim() || !editing.body.trim()}>
                  Save
                </button>
              </div>
            </form>
          ) : (
            <>
              <input
                className="emoji-search"
                autoFocus
                placeholder="Search saved replies"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setOpen(false);
                  if (e.key === "Enter" && shown[0]) {
                    e.preventDefault();
                    onPick(shown[0]);
                    setOpen(false);
                  }
                }}
              />
              <div className="emoji-scroll">
                {shown.length === 0 && (
                  <div className="emoji-none">{replies.length ? `Nothing matches “${query.trim()}”` : "No saved replies yet. Save answers you give often."}</div>
                )}
                {shown.map((r) => (
                  <div key={r.id} className="saved">
                    <button
                      className="saved-main"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        onPick(r);
                        setOpen(false);
                      }}
                    >
                      <b>{r.title}</b>
                      <span>{r.body}</span>
                    </button>
                    <span className="saved-actions">
                      <button className="icon-btn" title="Edit" onClick={() => setEditing(r)}>
                        <Icon d="M4 20h4L19 9l-4-4L4 16v4Z" />
                      </button>
                      <button
                        className="icon-btn"
                        title="Delete"
                        onClick={() => confirm(`Delete the saved reply “${r.title}” for the whole team?`) && void remove(r.id).catch((e) => setError(e.message))}
                      >
                        <Icon d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
              <div className="replies-foot">
                <button className="btn btn-sm btn-ghost" onClick={() => setEditing({ title: "", body: "" })}>
                  + New
                </button>
                {draft.trim() && !draft.startsWith("/") && (
                  <button className="btn btn-sm btn-ghost" onClick={() => setEditing({ title: "", body: draft.trim() })}>
                    Save what I wrote
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
