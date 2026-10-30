import type { Mail, Message } from "./data";

/**
 * The received message that carries the sender's advertised unsubscribe
 * target. Superhuman offers Unsubscribe only when the sender advertises one,
 * so this is evidence from the stored headers, never a heuristic.
 */
export function unsubscribeMessage(mail: Mail, account?: string): Message | undefined {
  return mail.messages.filter(message =>
    !message.outgoing
    && !message.pending
    && !message.operationId
    && message.email !== account
    && message.email !== mail.account
    && message.facts?.listUnsubscribe === true,
  ).at(-1);
}
