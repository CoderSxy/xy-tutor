// Keep the task and idempotency key until its first message is acknowledged.
export type StarterSubmission = {
  message: string;
  attachmentIds: string[];
  questionVersionId?: string;
};

type Task = { id: string; conversationId: string };

export function sessionStarter(
  create: (scope: string, creationKey: string) => Promise<Task>,
  submit: (
    conversationId: string,
    submission: StarterSubmission,
    requestKey: string,
    scope: string,
  ) => Promise<unknown>,
) {
  let draft:
    | {
        scope: string;
        creationKey: string;
        task?: Task;
        creating?: Promise<Task>;
      }
    | undefined;
  let pending:
    | { scope: string; fingerprint: string; task: Task; key: string }
    | undefined;

  const ensureConversation = async (scope: string): Promise<string> => {
    if (draft?.scope !== scope)
      draft = { scope, creationKey: crypto.randomUUID() };
    const current = draft;
    if (current.task) return current.task.conversationId;
    if (!current.creating) {
      const promise = create(scope, current.creationKey).then((task) => {
        current.task = task;
        return task;
      });
      current.creating = promise;
      const settle = () => {
        if (current.creating === promise) current.creating = undefined;
      };
      promise.then(settle, settle);
    }
    return (await current.creating!).conversationId;
  };

  const send = async (scope: string, submission: StarterSubmission) => {
    const fingerprint = JSON.stringify([
      scope,
      submission.message,
      submission.questionVersionId ?? null,
      submission.attachmentIds,
    ]);
    if (!pending || pending.scope !== scope || pending.fingerprint !== fingerprint) {
      const conversationId = await ensureConversation(scope);
      pending = {
        scope,
        fingerprint,
        task: { id: draft!.task!.id, conversationId },
        key: crypto.randomUUID(),
      };
    }
    const current = pending;
    await submit(current.task.conversationId, submission, current.key, scope);
    pending = undefined;
    if (draft?.task === current.task) draft = undefined;
    return current.task.id;
  };

  return { ensureConversation, send };
}
