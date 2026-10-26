/* Presentation callbacks for the existing building-session launcher. The City owns
 * pending identity, NPC staging and stale-handle protection; these callbacks never
 * create, send to or stop a session. */
export function buildingTalkCallbacks(city, { notice = () => {} } = {}) {
  const handles = new WeakMap();
  let sequence = 0;
  const visible = () => city.visible && !city.failed;
  return {
    onStarting({ provider, project, context }) {
      if (!visible()) return;
      handles.set(context, city.enterTalk(`building-start:${++sequence}`, {
        pending: { provider, projectId: project.id, label: 'New session' },
      }));
    },
    onStarted(session, { origin, context, sendError } = {}) {
      if (!visible()) return;
      if (origin === 'recovery') city.enterTalk(`sess:${session.id}`);
      else if (origin === 'started') handles.get(context)?.resolve(session.id);
      // A failed first send belongs to the admitted session. The launcher's
      // recovery controls retain the draft and retry that same session.
      if (sendError) notice(sendError);
    },
    onStartFailed(error, { context } = {}) {
      if (visible()) handles.get(context)?.fail(error);
    },
  };
}
