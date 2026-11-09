// Keep the task and idempotency key until its first message is acknowledged.
export function sessionStarter(
  create: (scope: string) => Promise<{ id: string; conversationId: string }>,
  submit: (
    conversationId: string,
    text: string,
    requestKey: string,
    scope: string,
  ) => Promise<unknown>,
) {
  let pending:
    | {
        scope: string;
        text: string;
        task: { id: string; conversationId: string };
        key: string;
      }
    | undefined;
  return async (scope: string, text: string) => {
    if (!pending || pending.scope !== scope || pending.text !== text) {
      const task = await create(scope);
      pending = { scope, text, task, key: crypto.randomUUID() };
    }
    const current = pending;
    await submit(current.task.conversationId, text, current.key, scope);
    pending = undefined;
    return current.task.id;
  };
}
