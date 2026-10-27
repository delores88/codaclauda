/* Presentation callbacks for the existing building-session launcher. The City owns
 * pending identity, NPC staging and stale-handle protection; these callbacks never
 * create, send to or stop a session. */
export function buildingTalkCallbacks(city) {
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
    onStarted(session, { origin, context } = {}) {
      if (!visible()) return;
      if (origin === 'recovery') city.enterTalk(`sess:${session.id}`);
      else if (origin === 'started') handles.get(context)?.resolve(session.id);
    },
    onStartFailed(error, { context } = {}) {
      if (visible()) handles.get(context)?.fail(error);
    },
  };
}
