"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CareEvent, ChatMessage, ConversationMemory, TreatmentState, User } from "@/lib/types";
import CareContextCard from "./CareContextCard";
import CareStatusPanel from "./CareStatusPanel";
import CareTimeline from "./CareTimeline";
import QuickActionsBar from "./QuickActionsBar";
import ChatView from "./ChatView";
import SimulatePanel from "./SimulatePanel";

interface Props {
  user: User;
  initialTreatment?: TreatmentState;
  initialEvents: CareEvent[];
  initialMessages: ChatMessage[];
}

export default function CareLoop({
  user,
  initialTreatment,
  initialEvents,
  initialMessages,
}: Props) {
  const [treatment, setTreatment] = useState<TreatmentState | undefined>(initialTreatment);
  const [events, setEvents] = useState<CareEvent[]>(initialEvents);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [memory, setMemory] = useState<ConversationMemory | undefined>();
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/users/${user.id}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setTreatment(data.treatment);
    setEvents(data.events ?? []);
    setMessages(data.messages ?? []);
    setMemory(data.memory);
  }, [user.id]);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/v1/chat/session/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: user.id }),
      });
      if (!res.ok) return;
      await refresh();
    })();
  }, [user.id, refresh]);

  useEffect(() => {
    // Light polling so webhook-driven events show up when triggered elsewhere.
    pollRef.current = window.setInterval(refresh, 4000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [refresh]);

  async function sendChat(content: string) {
    if (!content.trim()) return;
    setBusy(true);
    const optimistic: ChatMessage = {
      id: `tmp_${Date.now()}`,
      user_id: user.id,
      role: "user",
      content,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    try {
      const res = await fetch("/api/v1/chat/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: user.id, content }),
      });
      if (!res.ok) throw new Error("Chat failed");
      await refresh();
    } catch {
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function runAction(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const path = mapActionToV1(body);
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Action failed");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function simulate(eventType: string) {
    setBusy(true);
    try {
      await fetch("/api/simulate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: user.id, event: eventType }),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-luma-border bg-luma-panel/70 backdrop-blur sticky top-0 z-20">
        <div className="mx-auto max-w-7xl px-5 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-luma-accent/20 border border-luma-accent/40 grid place-items-center">
                <span className="text-luma-accent font-semibold text-sm">L</span>
              </div>
              <span className="font-semibold text-sm">Luma</span>
            </Link>
            <span className="text-luma-muted">/</span>
            <div className="text-sm">
              <span className="font-medium">{user.name}</span>
              <span className="text-luma-muted ml-2">· {user.goal.replace("_", " ")}</span>
            </div>
          </div>
          <SimulatePanel onSimulate={simulate} busy={busy} />
        </div>
      </header>

      <div className="flex-1 mx-auto max-w-7xl w-full px-5 py-6 grid grid-cols-12 gap-6">
        <aside className="col-span-12 lg:col-span-3 space-y-6">
          <CareStatusPanel user={user} treatment={treatment} />
          <CareContextCard
            user={user}
            treatment={treatment}
            memoryUpdatedAt={memory?.updated_at}
          />
          <CareTimeline events={events} />
        </aside>

        <section className="col-span-12 lg:col-span-9 flex flex-col min-h-[70vh]">
          <div className="flex-1 card overflow-hidden flex flex-col">
            <ChatView messages={messages} busy={busy} />
            <div className="border-t border-luma-border p-3">
              <ChatComposer onSend={sendChat} busy={busy} />
            </div>
          </div>
          <div className="mt-4">
            <QuickActionsBar
              userId={user.id}
              treatment={treatment}
              onAction={runAction}
              onOpenChat={(text) => sendChat(text)}
              busy={busy}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

function mapActionToV1(body: Record<string, unknown>): string {
  const action = body.action as string | undefined;
  if (action === "log_medication") return "/api/v1/actions/log-medication";
  if (action === "checkin_symptom") return "/api/v1/actions/checkin";
  if (action === "request_help") return "/api/v1/actions/request-help";
  return "/api/v1/actions/checkin";
}

function ChatComposer({
  onSend,
  busy,
}: {
  onSend: (content: string) => void;
  busy: boolean;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        onSend(value.trim());
        setValue("");
      }}
      className="flex items-end gap-2"
    >
      <textarea
        className="input min-h-[44px] max-h-40 resize-none"
        placeholder="Ask your coach anything — symptoms, side effects, your plan…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (value.trim()) {
              onSend(value.trim());
              setValue("");
            }
          }
        }}
        rows={1}
      />
      <button className="btn btn-primary" disabled={busy || !value.trim()}>
        Send
      </button>
    </form>
  );
}
