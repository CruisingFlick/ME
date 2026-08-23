import type { Message, MessageKind, Role } from "../types.js";
import { id, nowIso } from "../util/id.js";
import type { Ledger } from "./ledger.js";
import type { Store } from "./store/index.js";

export interface SendOptions {
  from: string;
  /** An agent id, a role name (fans out to everyone in that role), or "*". */
  to: string;
  subject: string;
  body: string;
  kind?: MessageKind;
  threadId?: string;
  taskId?: string;
}

/**
 * Agent-to-agent messaging.
 *
 * This is the "they talk to each other" part, and it is deliberately a mailbox
 * rather than a chat room. Free-form group chat between models does not
 * converge: everyone answers everyone, context inflates, and the run stalls.
 * Addressed messages with threads keep each exchange bounded and auditable.
 */
export class MessageBus {
  constructor(
    private readonly store: Store,
    private readonly ledger: Ledger,
    private readonly runId: string,
  ) {}

  async send(options: SendOptions): Promise<Message> {
    const message: Message = {
      id: id("msg"),
      runId: this.runId,
      from: options.from,
      to: options.to,
      kind: options.kind ?? "request",
      subject: options.subject,
      body: options.body,
      threadId: options.threadId ?? id("thr"),
      taskId: options.taskId,
      createdAt: nowIso(),
      readBy: [],
    };
    await this.store.putMessage(message);
    await this.ledger.record("message.sent", options.from, {
      to: message.to,
      kind: message.kind,
      subject: message.subject,
      threadId: message.threadId,
      messageId: message.id,
      chars: message.body.length,
    });
    return message;
  }

  /** Everything addressed to this agent that it has not yet seen. */
  async inbox(agentId: string, role: Role): Promise<Message[]> {
    const all = await this.store.listMessages(this.runId);
    return all.filter(
      (m) =>
        m.from !== agentId &&
        !m.readBy.includes(agentId) &&
        (m.to === agentId || m.to === role || m.to === "*"),
    );
  }

  async markRead(agentId: string, messages: Message[]): Promise<void> {
    if (messages.length === 0) return;
    await this.store.markRead(this.runId, messages.map((m) => m.id), agentId);
  }

  /** Every message in a thread, oldest first. Used to answer a request in context. */
  async thread(threadId: string): Promise<Message[]> {
    const all = await this.store.listMessages(this.runId);
    return all.filter((m) => m.threadId === threadId);
  }

  async all(): Promise<Message[]> {
    return this.store.listMessages(this.runId);
  }
}

/** Render an inbox for injection into a model prompt. */
export function renderInbox(messages: Message[]): string {
  if (messages.length === 0) return "(no new messages)";
  return messages
    .map(
      (m) =>
        `--- message ${m.id} | from: ${m.from} | kind: ${m.kind} | thread: ${m.threadId}` +
        (m.taskId ? ` | task: ${m.taskId}` : "") +
        `\nsubject: ${m.subject}\n${m.body}`,
    )
    .join("\n\n");
}
