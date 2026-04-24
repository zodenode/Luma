"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CareEvent,
  ChatMessage,
  ConversationMemory,
  MemorySnapshot,
  TreatmentState,
  User,
} from "@/lib/types";
import CareStatusPanel from "./CareStatusPanel";
import CareTimeline from "./CareTimeline";
import QuickActionsBar from "./QuickActionsBar";
import ChatView from "./ChatView";
import SimulatePanel from "./SimulatePanel";
import CareContextCard from "./CareContextCard";

interface Props {
  user: User;
  initialTreatment?: TreatmentState;
  initialEvents: CareEvent[];
  initialMessages: ChatMessage[];
  initialMemory?: ConversationMemory;
  initialSnapshot?: MemorySnapshot;
}

export default function CareLoop({
  user,
  initialTreatment,
  initialEvents,
  initialMessages,
  initialMemory,
  initialSnapshot,
}: Props) {
  const [treatment, setTreatment] = useState<TreatmentState | undefined>(initialTreatment);
  const [events, setEvents] = useState<CareEvent[]>(initialEvents);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [memory, setMemory] = useState<ConversationMemory | undefined>(initialMemory);
  const [snapshot, setSnapshot] = useState<MemorySnapshot | undefined>(initialSnapshot);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/users/${user.id}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setTreatment(data.treatment);
    setEvents(data.events ?? []);
    setMessages(data.messages ?? []);
    setMemory(data.conversation_memory);
    setSnapshot(data.latest_memory_snapshot);
  }, [user.id]);

  const rehydrateSession = useCallback(async () => {
    const res = await fetch(`/api/v1/chat/session?userId=${encodeURIComponent(user.id)}`, {
      cache: "no-store",
    });
    if (!res.ok) return;
    const data = await res.json();
    setMessages(data.messages ?? []);
    setTreatment(data.treatment);
    setMemory(data.conversation_memory);
    setSnapshot(data.latest_memory_snapshot);
  }, [user.id]);

  useEffect(() => {
    void rehydrateSession();
  }, [rehydrateSession]);

  useEffect(() => {
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
      metadata: {},
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

  async function runAction(path: string, body: Record<string, unknown>) {
    setBusy(true);
    try {
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
          <CareContextCard
            user={user}
            treatment={treatment}
            memory={memory}
            snapshot={snapshot}
          />
          <CareStatusPanel user={user} treatment={treatment} />
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
