"use client";

import clsx from "clsx";
import { useEffect, useRef } from "react";
import type { ChatMessage } from "@/lib/types";

export default function ChatView({
  messages,
  busy,
}: {
  messages: ChatMessage[];
  busy: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, busy]);

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-4">
      {messages.length === 0 && (
        <div className="text-sm text-luma-muted">
          Your coach will greet you as soon as your first event lands.
        </div>
      )}
      {messages.map((m) => (
        <MessageBubble key={m.id} msg={m} />
      ))}
      {busy && (
        <div className="flex items-center gap-2 text-xs text-luma-muted">
          <Dot /> <Dot delay={120} /> <Dot delay={240} />
          <span className="ml-1">Coach is thinking…</span>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  const kind = msg.metadata?.kind ?? msg.meta?.kind;
  const kindLabel = kind && kind !== "chat" ? kind.replace("_", " ") : null;

  return (
    <div className={clsx("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={clsx(
          "max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
          isUser
            ? "bg-luma-accent text-black rounded-br-md"
            : "bg-luma-surface border border-luma-border rounded-bl-md",
        )}
      >
        {!isUser && kindLabel && (
          <div className="text-[10px] uppercase tracking-wide text-luma-accent mb-1">
            {kindLabel}
          </div>
        )}
        <div className="whitespace-pre-wrap">{msg.content}</div>
      </div>
    </div>
  );
}

function Dot({ delay = 0 }: { delay?: number }) {
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full bg-luma-muted animate-pulse"
      style={{ animationDelay: `${delay}ms` }}
    />
  );
}
